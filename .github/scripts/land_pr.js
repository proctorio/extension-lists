'use strict';

// Lands an approved single-line list addition on main WITHOUT touching the PR branch.
//
// Why: every submission appends to the end of a category file, so as soon as one PR
// merges, every other open PR conflicts. GitHub's merge engine ignores merge=union, so
// the conflicts can only be removed by not merging the branch at all. This script
// builds "main + the one verified line" itself and records the PR head as the second
// parent, so GitHub shows the PR as merged and nobody updates a branch or resolves
// a conflict.
//
// SAFETY: runs in a privileged workflow (deploy key = ruleset bypass). It never checks
// out or executes anything from the PR: the PR head is only fetched as objects, its
// diff is read as data through the API, and the only code executed is main's own
// refresh_list.js. Every ruleset requirement is re-enforced here, because the push
// bypasses the ruleset:
//   - the PR adds exactly one valid entry to category lists and changes nothing else
//   - a code owner (not the author) approved the CURRENT head commit, none requests changes
//   - the PR gate (live store verification) succeeded on the current head commit
//   - the entry is not already on main, and main + entry passes the repo validator

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LIST_RE = /^contributable_lists\/[^/]+\.txt$/;
const ENTRY_RE = /^([a-p]{32})\s+\/\/\s*(.+)$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const HOLD_LABELS = new Set(['hold', 'do not merge', 'do-not-merge']);
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const MAX_PUSH_ATTEMPTS = 5;

// ---- pure logic (unit tested) ------------------------------------------------------

function patchLines(patch) {
  const added = [], removed = [];
  for (const raw of patch.split('\n')) {
    if (raw === '' || raw.startsWith('@@') || raw.startsWith('\\')) continue;
    const line = raw.slice(1).trim();
    if (!line) continue;
    if (raw[0] === '+') added.push(line);
    else if (raw[0] === '-') removed.push(line);
  }
  return { added, removed };
}

// A line that is removed and re-added with only whitespace changed (the missing final
// newline in an old file) is not a real edit, so compare trimmed sets, like the gate.
function analyzeFiles(files) {
  if (!files.length) return { ok: false, reason: 'the pull request has no file changes' };
  const bad = files.filter(f => !LIST_RE.test(f.filename) || f.status !== 'modified' || typeof f.patch !== 'string');
  if (bad.length) {
    return { ok: false, reason: 'it changes ' + bad.map(f => '`' + f.filename + '`').join(', ')
      + ', which is not a plain edit of a category list' };
  }
  const adds = [];
  let removes = 0;
  for (const f of files) {
    const { added, removed } = patchLines(f.patch);
    const a = new Set(added), r = new Set(removed);
    if (a.size !== added.length) return { ok: false, reason: 'it adds the same line twice' };
    for (const l of a) if (!r.has(l)) adds.push({ file: f.filename, line: l });
    for (const l of r) if (!a.has(l)) removes++;
  }
  if (removes) return { ok: false, reason: 'it removes or edits ' + removes + ' existing entr' + (removes === 1 ? 'y' : 'ies') };
  if (adds.length !== 1) return { ok: false, reason: 'it adds ' + adds.length + ' lines (exactly one extension per pull request)' };
  const { file, line } = adds[0];
  const m = ENTRY_RE.exec(line);
  if (!m || CONTROL_RE.test(line)) return { ok: false, reason: 'the added line is not `<32-character id, a-p> // <store name>`' };
  return { ok: true, file, line, id: m[1], desc: m[2].trim() };
}

function parseCodeowners(text) {
  const owners = new Set();
  for (const l of String(text).split('\n')) {
    if (l.trim().startsWith('#')) continue;
    for (const m of l.matchAll(/@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g)) owners.add(m[1].toLowerCase());
  }
  return owners;
}

// reviews must be in chronological order (the REST API returns them that way).
function reviewVerdict(reviews, { headSha, owners, author }) {
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user || r.state === 'COMMENTED') continue; // a comment does not change a decision
    latest.set(r.user.login.toLowerCase(), r);
  }
  const eligible = [...latest].filter(([u]) => owners.has(u) && u !== String(author).toLowerCase());
  const approvals = eligible.filter(([, r]) => r.state === 'APPROVED' && r.commit_id === headSha).map(([u]) => u);
  const stale = eligible.filter(([, r]) => r.state === 'APPROVED' && r.commit_id !== headSha).map(([u]) => u);
  const blockers = eligible.filter(([, r]) => r.state === 'CHANGES_REQUESTED').map(([u]) => u);
  return { approved: approvals.length > 0 && blockers.length === 0, approvals, stale, blockers };
}

// ---- git ---------------------------------------------------------------------------

function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  }).trim();
}

class HeadMoved extends Error {}

// Builds the merge commit locally. Returns { status: 'built', commit, mainSha } or a
// terminal { status: 'duplicate' | 'invalid', ... }.
function buildCommit({ cwd, prNumber, headSha, title, label, entry }) {
  git(cwd, ['fetch', '--quiet', 'origin', 'main']);
  git(cwd, ['fetch', '--quiet', 'origin', `pull/${prNumber}/head`]);
  if (git(cwd, ['rev-parse', 'FETCH_HEAD']) !== headSha) throw new HeadMoved('the PR head moved after it was approved');
  const mainSha = git(cwd, ['rev-parse', 'origin/main']);
  git(cwd, ['checkout', '--quiet', '--detach', mainSha]);
  git(cwd, ['reset', '--quiet', '--hard', mainSha]);
  git(cwd, ['clean', '-fdq']);

  const dir = path.join(cwd, 'contributable_lists');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.txt'))) {
    if (fs.readFileSync(path.join(dir, f), 'utf8').includes(entry.id)) return { status: 'duplicate', where: f };
  }
  const target = path.join(cwd, entry.file);
  if (!fs.existsSync(target)) return { status: 'invalid', detail: entry.file + ' does not exist on main' };
  let text = fs.readFileSync(target, 'utf8');
  if (text && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(target, text + entry.line + '\n');

  try { // main's own validator + generator; this is the only code that runs
    execFileSync('node', ['.github/scripts/refresh_list.js'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { status: 'invalid', detail: String(e.stderr || e.message).trim() };
  }
  git(cwd, ['add', '--', 'contributable_lists', 'extensions.txt']);

  // the result must differ from main by exactly this one line (plus regenerated extensions.txt)
  const changed = git(cwd, ['diff', '--cached', '--name-only', mainSha]).split('\n').filter(Boolean);
  if (changed.some(n => n !== entry.file && n !== 'extensions.txt')) throw new Error('unexpected files changed: ' + changed.join(', '));
  // compare trimmed lines, so a missing final newline on main is not mistaken for an edit
  const lines = t => t.split('\n').map(l => l.trim()).filter(Boolean);
  const before = lines(git(cwd, ['show', `${mainSha}:${entry.file}`]));
  const after = lines(git(cwd, ['show', `:${entry.file}`]));
  if (after.length !== before.length + 1 || after[after.length - 1] !== entry.line || !before.every((l, i) => l === after[i])) {
    throw new Error('the list change is not exactly one appended line');
  }
  const tree = git(cwd, ['write-tree']);
  const msg = `Merge pull request #${prNumber} from ${label.replace(':', '/')}\n\n${title}`;
  const commit = git(cwd, ['commit-tree', tree, '-p', mainSha, '-p', headSha, '-m', msg], {
    GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email, GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email,
  });
  return { status: 'built', commit, mainSha };
}

// ---- GitHub I/O --------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gateConclusion({ github, owner, repo, sha, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await github.rest.checks.listForRef({ owner, repo, ref: sha, check_name: 'gate', per_page: 100 });
    const run = data.check_runs.sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))[0];
    if (run && run.status === 'completed') return run.conclusion;
    if (Date.now() >= deadline) return run ? 'still running' : 'missing';
    await sleep(pollMs);
  }
}

async function say(github, owner, repo, number, body) {
  try { await github.rest.issues.createComment({ owner, repo, issue_number: number, body }); } catch (e) { /* never fail on a comment */ }
}

// Existing behaviour, kept for approved PRs that are not a single-line addition
// (maintainer edits, removals): native merge, else native auto-merge, else a comment.
async function standardMerge({ github, core, owner, repo, number }) {
  try {
    await github.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: 'merge' });
    core.info(`Merged PR #${number}.`);
    return 'merged';
  } catch (e) {
    core.info(`Direct merge refused (${e.status}): ${e.message}`);
  }
  try {
    const { repository } = await github.graphql(
      `query($owner:String!,$repo:String!,$number:Int!){
         repository(owner:$owner,name:$repo){ pullRequest(number:$number){ id } } }`,
      { owner, repo, number });
    await github.graphql(
      `mutation($id:ID!){ enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}){ clientMutationId } }`,
      { id: repository.pullRequest.id });
    core.info(`Auto-merge enabled on PR #${number}; it will merge when checks pass.`);
    return 'auto-merge-enabled';
  } catch (e) {
    await say(github, owner, repo, number,
      'Approved, but automatic merge could not proceed (' + e.message + '). Update the branch or resolve conflicts, then re-approve.');
    core.setFailed(`Could not merge or enable auto-merge on PR #${number}: ${e.message}`);
    return 'failed';
  }
}

async function run({ github, context, core, prNumber, dryRun = false, cwd = process.cwd(), gateWaitMs = 300000, pollMs = 10000 }) {
  const { owner, repo } = context.repo;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.state !== 'open' || pr.draft) { core.info(`PR #${prNumber} is ${pr.draft ? 'a draft' : pr.state}; nothing to do.`); return 'skipped'; }
  if (pr.base.ref !== 'main') { core.info(`PR #${prNumber} targets ${pr.base.ref}, not main; nothing to do.`); return 'skipped'; }
  const hold = (pr.labels || []).find(l => HOLD_LABELS.has(String(l.name).toLowerCase()));
  if (hold) { core.info(`PR #${prNumber} carries the "${hold.name}" label; not landing.`); return 'held'; }

  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 });
  const entry = analyzeFiles(files);
  if (!entry.ok) {
    core.info(`PR #${prNumber} is not a single-line list addition (${entry.reason}); using the standard merge path.`);
    return dryRun ? 'dry-run:standard-merge' : standardMerge({ github, core, owner, repo, number: prNumber });
  }

  const { data: co } = await github.rest.repos.getContent({ owner, repo, path: '.github/CODEOWNERS', ref: 'main' });
  const owners = parseCodeowners(Buffer.from(co.content, 'base64').toString('utf8'));
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
  const verdict = reviewVerdict(reviews, { headSha: pr.head.sha, owners, author: pr.user.login });
  if (!verdict.approved) {
    core.info(`PR #${prNumber}: no current code-owner approval (approvals=${verdict.approvals}, approved an older commit=${verdict.stale}, requested changes=${verdict.blockers}).`);
    return 'not-approved';
  }

  const gate = await gateConclusion({ github, owner, repo, sha: pr.head.sha, timeoutMs: gateWaitMs, pollMs });
  if (gate !== 'success') {
    core.info(`PR #${prNumber}: the PR gate is "${gate}" on ${pr.head.sha.slice(0, 7)}; not landing.`);
    if (!dryRun) await say(github, owner, repo, prNumber,
      `Approved, but the PR gate is **${gate}** on the latest commit, so it was not landed. Once the gate passes, re-approve or run the "Auto-merge on approval" workflow for this PR.`);
    return 'gate-' + gate.replace(/\s+/g, '-');
  }

  let built;
  for (let attempt = 1; ; attempt++) {
    try {
      built = buildCommit({ cwd, prNumber, headSha: pr.head.sha, title: pr.title, label: pr.head.label, entry });
    } catch (e) {
      if (!(e instanceof HeadMoved)) throw e;
      core.info(`PR #${prNumber}: ${e.message}; the new commit needs its own approval.`);
      return 'head-moved';
    }
    if (built.status !== 'built') break;
    if (dryRun) { core.info(`DRY RUN: would push ${built.commit} (parents ${built.mainSha.slice(0, 7)} + ${pr.head.sha.slice(0, 7)}).`); return built; }
    try {
      git(cwd, ['push', '--quiet', 'origin', `${built.commit}:refs/heads/main`]);
      break;
    } catch (e) {
      const err = String(e.stderr || e.message);
      if (/GH006|GH013|rule violation|protected branch/i.test(err)) throw new Error('push refused by the branch ruleset (does the deploy key still bypass it?): ' + err);
      if (attempt >= MAX_PUSH_ATTEMPTS) throw e;
      core.info(`Push raced with another change to main (attempt ${attempt}); rebuilding on the new main.`);
    }
  }
  if (built.status === 'duplicate') {
    await say(github, owner, repo, prNumber, `Approved, but this ID is already listed in \`contributable_lists/${built.where}\` on main, so there is nothing to add. Close this pull request.`);
    core.info(`PR #${prNumber}: ID already on main (${built.where}).`);
    return 'duplicate';
  }
  if (built.status === 'invalid') {
    await say(github, owner, repo, prNumber, 'Approved, but adding this entry to main fails the list validator, so it was not landed:\n\n```\n' + built.detail + '\n```');
    core.setFailed(`PR #${prNumber}: validator rejected main + entry: ${built.detail}`);
    return 'invalid';
  }

  core.info(`Landed PR #${prNumber} on main as ${built.commit}.`);
  // GitHub marks the PR merged once its head is reachable from main; close it by hand if that lags.
  for (let i = 0; i < 6; i++) {
    const { data: now } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (now.merged) return 'landed';
    await sleep(pollMs);
  }
  await say(github, owner, repo, prNumber, `Landed on main in ${built.commit}.`);
  await github.rest.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
  return 'landed';
}

module.exports = { patchLines, analyzeFiles, parseCodeowners, reviewVerdict, buildCommit, run, standardMerge };
