'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const land = require('./land_pr.js');

const ID = n => String(n).padStart(32, 'a').replace(/[0-9]/g, c => 'abcdefghij'[c]); // 32 chars, a-p only
const patch = (...lines) => '@@ -1,1 +1,1 @@\n' + lines.join('\n');
const file = (filename, p, status = 'modified') => ({ filename, status, patch: p });

// ---- analyzeFiles ------------------------------------------------------------------

test('analyzeFiles: one added line qualifies', () => {
  const r = land.analyzeFiles([file('contributable_lists/utilities.txt', patch(' ctx', `+${ID(1)} // Thing`))]);
  assert.equal(r.ok, true);
  assert.equal(r.file, 'contributable_lists/utilities.txt');
  assert.equal(r.id, ID(1));
  assert.equal(r.desc, 'Thing');
});

test('analyzeFiles: missing-final-newline rewrite of the last line is not an edit', () => {
  const r = land.analyzeFiles([file('contributable_lists/productivity.txt',
    patch(`-${ID(2)} // Old`, '\\ No newline at end of file', `+${ID(2)} // Old`, `+${ID(3)} // New`))]);
  assert.equal(r.ok, true);
  assert.equal(r.id, ID(3));
});

test('analyzeFiles: rejects everything that is not exactly one added entry', () => {
  const l = 'contributable_lists/utilities.txt';
  const bad = [
    [[file(l, patch(`+${ID(1)} // A`, `+${ID(2)} // B`))], /adds 2 lines/],
    [[file(l, patch(`-${ID(1)} // A`, `+${ID(2)} // B`))], /removes or edits 1 existing/],
    [[file(l, patch(`-${ID(1)} // A`))], /removes or edits/],
    [[file(l, patch(`+${ID(1)} // A`)), file('extensions.txt', patch('+x'))], /extensions\.txt/],
    [[file('.github/CODEOWNERS', patch('+* @x'))], /not a plain edit/],
    [[file('contributable_lists/new.txt', patch(`+${ID(1)} // A`), 'added')], /not a plain edit/],
    [[{ filename: l, status: 'modified' }], /not a plain edit/], // no patch (too large)
    [[file(l, patch('+not-an-id // A'))], /not `<32-character id/],
    [[file(l, patch(`+${ID(1)} //`))], /not `<32-character id/],
    [[file(l, patch(`+${ID(1)} // A\u0007bell`))], /not `<32-character id/],
    [[file(l, patch(`+${ID(1)} // A`, `+${ID(1)} // A`))], /same line twice/],
    [[], /no file changes/],
  ];
  for (const [files, re] of bad) {
    const r = land.analyzeFiles(files);
    assert.equal(r.ok, false, JSON.stringify(files));
    assert.match(r.reason, re);
  }
});

test('analyzeFiles: one entry spread over two files is rejected', () => {
  const r = land.analyzeFiles([
    file('contributable_lists/a.txt', patch(`+${ID(1)} // A`)),
    file('contributable_lists/b.txt', patch(`+${ID(2)} // B`)),
  ]);
  assert.equal(r.ok, false);
});

// ---- parseCodeowners / reviewVerdict -----------------------------------------------

test('parseCodeowners: handles lowercased, comments ignored', () => {
  const o = land.parseCodeowners('# @ignored\n* @Alice @bob-2 @carol\n');
  assert.deepEqual([...o].sort(), ['alice', 'bob-2', 'carol']);
});

const owners = new Set(['alice', 'bob', 'author']);
const rv = (login, state, commit_id = 'H') => ({ user: { login }, state, commit_id });

test('reviewVerdict: a code owner approval on the current head counts', () => {
  const v = land.reviewVerdict([rv('Alice', 'APPROVED')], { headSha: 'H', owners, author: 'someone' });
  assert.equal(v.approved, true);
});

test('reviewVerdict: approval of an older commit, non-owner, or own PR does not count', () => {
  const ctx = { headSha: 'H', owners, author: 'author' };
  assert.equal(land.reviewVerdict([rv('alice', 'APPROVED', 'OLD')], ctx).approved, false);
  assert.deepEqual(land.reviewVerdict([rv('alice', 'APPROVED', 'OLD')], ctx).stale, ['alice']);
  assert.equal(land.reviewVerdict([rv('stranger', 'APPROVED')], ctx).approved, false);
  assert.equal(land.reviewVerdict([rv('author', 'APPROVED')], ctx).approved, false);
});

test('reviewVerdict: latest decisive review wins; comments do not change it', () => {
  const ctx = { headSha: 'H', owners, author: 'x' };
  assert.equal(land.reviewVerdict([rv('alice', 'APPROVED'), rv('alice', 'COMMENTED')], ctx).approved, true);
  assert.equal(land.reviewVerdict([rv('alice', 'APPROVED'), rv('alice', 'CHANGES_REQUESTED')], ctx).approved, false);
  assert.equal(land.reviewVerdict([rv('alice', 'CHANGES_REQUESTED'), rv('alice', 'APPROVED')], ctx).approved, true);
  assert.equal(land.reviewVerdict([rv('alice', 'APPROVED'), rv('alice', 'DISMISSED')], ctx).approved, false);
});

test('reviewVerdict: one owner approving does not override another owner requesting changes', () => {
  const v = land.reviewVerdict([rv('alice', 'APPROVED'), rv('bob', 'CHANGES_REQUESTED')], { headSha: 'H', owners, author: 'x' });
  assert.equal(v.approved, false);
  assert.deepEqual(v.blockers, ['bob']);
});

// ---- git round trip ----------------------------------------------------------------

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  fs.mkdirSync(path.join(work, '.github/scripts'), { recursive: true });
  fs.mkdirSync(path.join(work, 'contributable_lists'));
  fs.copyFileSync(path.join(__dirname, 'refresh_list.js'), path.join(work, '.github/scripts/refresh_list.js'));
  fs.writeFileSync(path.join(work, 'contributable_lists/utilities.txt'), `${ID(10)} // Base one\n${ID(11)} // Base two\n`);
  fs.writeFileSync(path.join(work, 'contributable_lists/productivity.txt'), `${ID(12)} // Prod`); // no final newline
  execFileSync('node', ['.github/scripts/refresh_list.js'], { cwd: work });
  sh(work, 'add', '-A'); sh(work, ...IDENT, 'commit', '-qm', 'base'); sh(work, 'push', '-q', 'origin', 'HEAD:main');
  return { root, origin, work, base: sh(work, 'rev-parse', 'HEAD') };
}

// A PR branch cut from `base` that appends one line, published as refs/pull/<n>/head.
function openPr(fx, n, fileName, line) {
  sh(fx.work, 'checkout', '-q', '--detach', fx.base);
  const p = path.join(fx.work, 'contributable_lists', fileName);
  let t = fs.readFileSync(p, 'utf8'); if (!t.endsWith('\n')) t += '\n';
  fs.writeFileSync(p, t + line + '\n');
  sh(fx.work, ...IDENT, 'commit', '-qam', 'pr ' + n);
  const head = sh(fx.work, 'rev-parse', 'HEAD');
  sh(fx.work, 'push', '-q', 'origin', `${head}:refs/pull/${n}/head`);
  return head;
}

function advanceMain(fx, fileName, line) { // someone else lands first
  sh(fx.work, 'fetch', '-q', 'origin', 'main'); sh(fx.work, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  const p = path.join(fx.work, 'contributable_lists', fileName);
  let t = fs.readFileSync(p, 'utf8'); if (!t.endsWith('\n')) t += '\n';
  fs.writeFileSync(p, t + line + '\n');
  execFileSync('node', ['.github/scripts/refresh_list.js'], { cwd: fx.work });
  sh(fx.work, 'add', '-A'); sh(fx.work, ...IDENT, 'commit', '-qm', 'other lands');
  sh(fx.work, 'push', '-q', 'origin', 'HEAD:main');
}

const origin = (fx, ...a) => sh(fx.origin, ...a);
const buildArgs = (fx, n, head, file_, line) => ({
  cwd: fx.work, prNumber: n, headSha: head, title: 'Add thing', label: 'someone:patch-1',
  entry: { file: `contributable_lists/${file_}`, line, id: line.slice(0, 32) },
});

test('buildCommit: stale PR branch still lands as main + exactly one line (the collision case)', () => {
  const fx = fixture();
  const lineA = `${ID(20)} // Alpha`, lineB = `${ID(21)} // Beta`;
  const headA = openPr(fx, 1, 'utilities.txt', lineA);
  const headB = openPr(fx, 2, 'utilities.txt', lineB); // same spot: classic conflict
  const a = land.buildCommit(buildArgs(fx, 1, headA, 'utilities.txt', lineA));
  assert.equal(a.status, 'built');
  sh(fx.work, 'push', '-q', 'origin', `${a.commit}:refs/heads/main`);
  // B is now stale against main and would conflict if merged; the bot does not care
  const b = land.buildCommit(buildArgs(fx, 2, headB, 'utilities.txt', lineB));
  assert.equal(b.status, 'built');
  assert.equal(sh(fx.work, 'rev-list', '--parents', '-n1', b.commit).split(' ').length, 3, 'two parents');
  assert.equal(sh(fx.work, 'merge-base', '--is-ancestor', headB, b.commit) === '', true);
  const lines = sh(fx.work, 'show', `${b.commit}:contributable_lists/utilities.txt`).split('\n');
  assert.deepEqual(lines.filter(Boolean).slice(-2), [lineA, lineB]);
  assert.ok(lines.includes(lineA) && lines.includes(lineB));
  // extensions.txt is regenerated in the same commit, so main never goes out of sync
  execFileSync('git', ['checkout', '-q', '--detach', b.commit], { cwd: fx.work });
  execFileSync('node', ['.github/scripts/refresh_list.js', '--check'], { cwd: fx.work });
});

test('buildCommit: file without a final newline gets one, no duplicated last line', () => {
  const fx = fixture();
  const line = `${ID(22)} // Gamma`;
  const head = openPr(fx, 3, 'productivity.txt', line);
  const r = land.buildCommit(buildArgs(fx, 3, head, 'productivity.txt', line));
  const txt = sh(fx.work, 'show', `${r.commit}:contributable_lists/productivity.txt`);
  assert.equal(txt, `${ID(12)} // Prod\n${line}`);
});

test('buildCommit: duplicate ID on main, and a PR head that moved, are refused', () => {
  const fx = fixture();
  const line = `${ID(23)} // Delta`;
  const head = openPr(fx, 4, 'utilities.txt', line);
  advanceMain(fx, 'productivity.txt', line); // same ID lands elsewhere first
  const r = land.buildCommit(buildArgs(fx, 4, head, 'utilities.txt', line));
  assert.equal(r.status, 'duplicate');
  assert.throws(() => land.buildCommit(buildArgs(fx, 4, 'f'.repeat(40), 'utilities.txt', `${ID(24)} // E`)), /head moved/);
});

// ---- run() with a mocked GitHub ------------------------------------------------------

function mock({ pr, files, reviews, gate = 'success', owners = '* @alice @bob\n' }) {
  const comments = [], calls = [];
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: typeof pr === 'function' ? pr() : pr }),
        listFiles: 'listFiles', listReviews: 'listReviews',
        merge: async () => { calls.push('merge'); },
        update: async a => { calls.push('update:' + a.state); },
      },
      repos: { getContent: async () => ({ data: { content: Buffer.from(owners).toString('base64') } }) },
      checks: { listForRef: async () => ({ data: { check_runs: gate ? [{ status: 'completed', conclusion: gate, started_at: '2026-01-01' }] : [] } }) },
      issues: { createComment: async a => { comments.push(a.body); } },
    },
    paginate: async fn => (fn === 'listFiles' ? files : reviews),
    graphql: async () => { calls.push('graphql'); },
  };
  const core = { info() {}, warning() {}, setFailed: m => calls.push('failed:' + m) };
  return { github, core, comments, calls, context: { repo: { owner: 'o', repo: 'r' } } };
}
const basePr = head => ({ state: 'open', draft: false, base: { ref: 'main' }, labels: [], title: 'Add thing',
  user: { login: 'contrib' }, head: { sha: head, label: 'contrib:patch-1' }, merged: true });

test('run: approved + gate success lands on origin/main and the PR ends up merged', async () => {
  const fx = fixture();
  const line = `${ID(30)} // Landed`;
  const head = openPr(fx, 5, 'utilities.txt', line);
  const m = mock({
    pr: basePr(head),
    files: [file('contributable_lists/utilities.txt', patch(`+${line}`))],
    reviews: [rv('alice', 'APPROVED', head)],
  });
  const out = await land.run({ ...m, prNumber: 5, cwd: fx.work, gateWaitMs: 0, pollMs: 1 });
  assert.equal(out, 'landed');
  assert.ok(origin(fx, 'show', 'main:contributable_lists/utilities.txt').includes(line));
  assert.equal(origin(fx, 'merge-base', '--is-ancestor', head, 'main') === '', true);
});

test('run: survives a push race (main moves between build and push)', async () => {
  const fx = fixture();
  const line = `${ID(31)} // Racer`;
  const head = openPr(fx, 6, 'utilities.txt', line);
  // The first push to origin makes main move underneath it, so the ref update is refused.
  const hook = path.join(fx.origin, 'hooks/pre-receive');
  fs.writeFileSync(hook, `#!/bin/sh
unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
[ -e "$GIT_DIR/raced" ] && exit 0
touch "$GIT_DIR/raced"
tree=$(git rev-parse main^{tree})
new=$(GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x git commit-tree $tree -p main -m raced)
git update-ref refs/heads/main $new
exit 0
`, { mode: 0o755 });
  const m = mock({
    pr: basePr(head),
    files: [file('contributable_lists/utilities.txt', patch(`+${line}`))],
    reviews: [rv('bob', 'APPROVED', head)],
  });
  const out = await land.run({ ...m, prNumber: 6, cwd: fx.work, gateWaitMs: 0, pollMs: 1 });
  assert.equal(out, 'landed');
  assert.ok(fs.existsSync(path.join(fx.origin, 'raced')), 'the race really happened');
  assert.ok(origin(fx, 'show', 'main:contributable_lists/utilities.txt').includes(line));
  assert.ok(origin(fx, 'log', '--format=%s', 'main').split('\n').includes('raced'), 'competing commit kept');
});

test('run: refuses unless approved on the current head, gate green, not held, not a draft', async () => {
  const fx = fixture();
  const line = `${ID(32)} // Nope`;
  const head = openPr(fx, 7, 'utilities.txt', line);
  const files = [file('contributable_lists/utilities.txt', patch(`+${line}`))];
  const before = origin(fx, 'rev-parse', 'main');
  const cases = [
    ['not-approved', { reviews: [rv('alice', 'APPROVED', 'OLDHEAD')] }],
    ['not-approved', { reviews: [rv('contrib', 'APPROVED', head)] }],
    ['not-approved', { reviews: [] }],
    ['gate-failure', { reviews: [rv('alice', 'APPROVED', head)], gate: 'failure' }],
    ['gate-missing', { reviews: [rv('alice', 'APPROVED', head)], gate: null }],
    ['held', { reviews: [rv('alice', 'APPROVED', head)], pr: { ...basePr(head), labels: [{ name: 'Hold' }] } }],
    ['skipped', { reviews: [rv('alice', 'APPROVED', head)], pr: { ...basePr(head), draft: true } }],
    ['skipped', { reviews: [rv('alice', 'APPROVED', head)], pr: { ...basePr(head), base: { ref: 'dev' } } }],
  ];
  for (const [expected, over] of cases) {
    const m = mock({ pr: basePr(head), files, ...over });
    assert.equal(await land.run({ ...m, prNumber: 7, cwd: fx.work, gateWaitMs: 0, pollMs: 1 }), expected);
  }
  assert.equal(origin(fx, 'rev-parse', 'main'), before, 'nothing was pushed');
});

test('run: non-single-line PRs keep the standard merge path; dry run pushes nothing', async () => {
  const fx = fixture();
  const m = mock({
    pr: basePr('H'),
    files: [file('contributable_lists/utilities.txt', patch(`-${ID(10)} // Base one`))],
    reviews: [rv('alice', 'APPROVED', 'H')],
  });
  await land.run({ ...m, prNumber: 8, cwd: fx.work, gateWaitMs: 0, pollMs: 1 });
  assert.deepEqual(m.calls, ['merge']);

  const line = `${ID(33)} // Dry`;
  const head = openPr(fx, 9, 'utilities.txt', line);
  const before = origin(fx, 'rev-parse', 'main');
  const d = mock({
    pr: basePr(head), files: [file('contributable_lists/utilities.txt', patch(`+${line}`))],
    reviews: [rv('alice', 'APPROVED', head)],
  });
  const out = await land.run({ ...d, prNumber: 9, cwd: fx.work, dryRun: true, gateWaitMs: 0, pollMs: 1 });
  assert.equal(out.status, 'built');
  assert.equal(origin(fx, 'rev-parse', 'main'), before);
});
