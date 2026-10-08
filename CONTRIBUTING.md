# Contributing

This repository controls which browser extensions are allowed to run during Proctorio-monitored exams. Every entry is reviewed with exam integrity in mind.

## Adding an extension

1. Find the extension ID: the 32-character string (letters a-p) in its store URL:
   `https://chromewebstore.google.com/detail/<name>/<THIS IS THE ID>`
2. Pick the right category file in [`contributable_lists/`](contributable_lists/):
   - `accessibility.txt` - assistive technology (screen readers, text to speech)
   - `productivity.txt` - general productivity and workflow tools
   - `security.txt` - endpoint security, filtering, and identity extensions
   - `supervision.txt` - classroom management and monitoring tools
   - `utilities.txt` - other extensions with a legitimate institutional purpose
3. Add one line per extension in this exact format:

   ```
   abcdefghijklmnopabcdefghijklmnop // Extension Name
   ```

4. Open a pull request and fill out the template completely, including a link to the extension's store listing. Requests without a store link, or an explanation for unlisted enterprise extensions, will not be reviewed.

Do not edit `extensions.txt`. It is generated from the category lists after your pull request is merged. CI rejects pull requests that modify it.

## What gets accepted

An extension is a candidate for the allowlist when it:

- serves a legitimate educational, accessibility, security, or institutional purpose
- is published by an identifiable vendor with a public store listing or documented enterprise distribution
- does not undermine exam integrity

An extension will be rejected if it can:

- enable communication between people (chat, messaging, screen sharing, co-browsing)
- look up, generate, or display answers (search assistants, AI helpers, flashcard or answer tools)
- capture, record, or exfiltrate exam content
- inject arbitrary or remotely controlled scripts into pages
- remote-control the browser or mask the user's activity
- route, tunnel, or disguise network traffic. Consumer VPNs, proxies, and IP or location spoofers are not accepted. Corporate filtering and security agents deployed through an institution's MDM (for example Netskope, iboss, Smoothwall) are fine.

## Rejected vendors

Pull requests adding any extension from the following vendors will be closed without further review, regardless of the specific extension ID submitted:

- **Honorlock** (Honorlock, Inc.)
  - Sends students' exam images to Amazon without their consent, breaching the privacy they were promised. See [NYT, May 27, 2022](https://www.nytimes.com/2022/05/27/technology/college-students-cheating-software-honorlock.html).
  - Removed students' right to opt out of binding arbitration. The September 2022 Terms of Use let a student opt out within 30 days (§13(g)); the August 2023 revision deleted that clause, so taking a Honorlock-proctored exam binds the student to confidential arbitration with no class action and no jury trial, and the only way to decline is not to take the exam. Compare the [Sept. 2022 Terms of Use](https://honorlock.com/wp-content/uploads/2024/01/Honorlock-Exam-Taker-Terms-of-Use-013024.pdf) ([archived](https://web.archive.org/web/20261002140618/https://honorlock.com/wp-content/uploads/2024/01/Honorlock-Exam-Taker-Terms-of-Use-013024.pdf)) §13(g) to the [Aug. 2023 Terms of Use](https://honorlock.com/wp-content/uploads/2024/09/Honorlock-Test-Taker-Terms-of-Use-0825233.pdf) ([archived](https://web.archive.org/web/20260820194454/https://honorlock.com/wp-content/uploads/2024/09/Honorlock-Test-Taker-Terms-of-Use-0825233.pdf)) §13.

## What reviewers check

Reviewers verify the ID, not the description. The description in your pull request is a label, not proof. A reviewer opens the store listing for the exact ID you submitted and confirms the publisher, name, and permissions match your claim. Submitting an ID that belongs to a different product than described will get the pull request closed and the submitter blocked.

## Validation

CI validates every pull request. The same checks can be run locally:

```
npm run validate        # format, duplicate, and description checks
npm run refresh-list    # regenerate extensions.txt (maintainers and CI only)
```

## Reporting a problem with a listed extension

If an already-listed extension is compromised, has changed ownership, or can be abused during exams, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License of contributions

By submitting a pull request you agree that your contribution is provided under the repository [LICENCE](LICENCE) and may be redistributed by Proctorio as part of this list.
