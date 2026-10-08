# Proctorio Extension Allowlist

This repository contains the allowlist of browser extensions permitted to run during Proctorio-monitored exams. Extensions on this list are not disabled by the lockdown browser. Vendors and schools can request additions by pull request.

## Repository structure

The editable lists live in the `contributable_lists/` folder, one file per category:

- `accessibility.txt` - assistive technology (screen readers, text to speech)
- `productivity.txt` - general productivity and workflow tools
- `security.txt` - endpoint security, filtering, and identity extensions
- `supervision.txt` - classroom management and monitoring tools
- `utilities.txt` - other extensions with a legitimate institutional purpose

Do not edit `extensions.txt`. It is generated from the category lists by CI after each merge, and pull requests that modify it directly will fail validation.

## Entry format

One extension per line: the 32-character extension ID, then a comment with the extension's store name.

```
cjpalhdlnbpafiamejdnhcphjbkeiagm // uBlock Origin
```

## How to contribute

1. Find the extension ID in its store listing URL.
2. Add one line to the appropriate file in `contributable_lists/`.
3. Open a pull request and fill out the template. A link to the store listing is required.
4. A code owner reviews the request. Reviewers verify the ID against the store listing, not the description.
5. Once merged, the change goes live for exams.

See [CONTRIBUTING.md](CONTRIBUTING.md) for acceptance criteria and the full checklist.

## What gets rejected

Extensions that can enable communication between people, look up or generate answers, capture exam content, inject remotely controlled scripts, or route traffic through consumer VPNs, proxies, or location spoofers. Corporate security agents deployed through an institution's MDM are acceptable. Some vendors (e.g. Honorlock) are rejected outright regardless of extension ID. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Validation

CI validates every pull request. The same checks can be run locally:

```
npm run validate        # format, duplicate, and description checks
npm run refresh-list    # regenerate extensions.txt
```

## Reporting a problem

To report a listed extension that is compromised or unsafe, see [SECURITY.md](SECURITY.md). Do not open a public issue with exploit details.

## License

This repository is source-available under the [Proctorio Source-Available License](LICENCE): free to use, copy, and redistribute, except by or for the benefit of any product or service that competes with Proctorio.
