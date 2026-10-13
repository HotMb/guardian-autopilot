# Guardian Studio — verification report

**Date:** 14 October 2026
**Scope:** Local, read-only AI-image storage triage and review interface.
**Design source:** [`../DESIGN.md`](../DESIGN.md)
**Interaction contract:** [`../UX-CONTRACT.md`](../UX-CONTRACT.md)

## Browser smoke check

The updated version was opened at `http://127.0.0.1:8766/` in a separate browser tab without stopping or replacing the already-running server. The desktop view rendered the synthetic collection and the following interactions were exercised:

- The collection showed 10 synthetic image records, four records in exact-byte-match groups, and two large-image examples. Every sample remained labeled synthetic.
- The selected PNG showed a metadata marker count, but not the prompt text. The user-facing disclosure and then the `parameters` field were opened; the synthetic prompt, negative prompt, sampler, step count, and seed appeared as text.
- An exact-match copy was selected for human review. The UI showed the candidate size separately from actual space freed (`0 B`); export became available and the quarantine action remained disabled. The export was not activated. No file was removed, moved, renamed, overwritten, or uploaded.
- No personal folder or image was opened. The test used only the built-in synthetic examples.

This is a desktop smoke check, not a complete visual/accessibility audit. No real user-selected folder was opened. Narrow-screen behavior, keyboard-only completion, and scanning a disposable test folder still need separate verification. The 40-row pagination is covered by implementation inspection but was not exercised with more than 40 live records in this smoke check.

## Automated verification

| Check | Result |
|---|---|
| Studio unit tests | Passed: 17 tests, including PNG metadata parsing, byte-confirmed duplicate checks, cooperative cancellation, and a 12,050-image synthetic inventory stress case retaining the 10,000 largest records |
| Studio local HTTP/security tests | Passed: 7 tests for CSP, worker asset allowlisting, GET-only behavior, fixed routes, Host validation, and cross-origin/cross-site rejection |
| Root repository tests | Passed: 105 tests, 0 failures, 1 existing platform-dependent test skipped |
| Shared, license, and core package tests | Passed: 4, 3, and 80 tests respectively |
| Full `npm test` chain | Not claimed complete: CLI package tests were interrupted after targeted and upstream checks had passed |
| `node --check` for Studio JavaScript modules and TypeScript build | Passed |

## Privacy and verification limits

- Studio scans selected files in the browser and serves only a fixed list of local static assets. The local server is bound to IPv4 loopback, rejects non-GET methods, arbitrary routes, mismatched Host, and cross-origin/cross-site requests.
- Selected paths, image bytes, hashes, metadata, and review-plan state are not sent to a server or persisted by the app. The review plan is informational only.
- Metadata parsing is currently limited to supported PNG text chunks. Other image formats are inventoried but their generation metadata is not parsed. Compressed metadata, general EXIF, integrity checks, and archive-wide prompt search are not supported.
- Folder traversal is capped at 250,000 entries, review and duplicate checking retain at most 10,000 largest images, and per-file hashing is capped at 64 MiB. Any cap, unreadable entry, skipped large file, or failed duplicate scan is labeled partial. Cancellation is cooperative; a currently running file read or Web Crypto digest cannot be interrupted.
- This check does not establish that file selection, metadata parsing, or scanning behaves correctly for every real creator tool or browser. Use a disposable folder of synthetic images for human validation; do not rely on this smoke check as proof of safe cleanup.
- Studio currently counts, inspects, confirms exact duplicates, and exports review candidates only. It does not free disk space. Automated quarantine, deletion, or restoration needs a separate native file-provider and recovery design, with explicit human authorization and destructive-action testing.
