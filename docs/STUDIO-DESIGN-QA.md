# Guardian Studio — verification report

**Date:** 14 October 2026
**Scope:** Local AI-image inventory, metadata review, and opt-in archive/restore/purge beta.
**Design source:** [`../DESIGN.md`](../DESIGN.md)
**Interaction contract:** [`../UX-CONTRACT.md`](../UX-CONTRACT.md)

## Verification status

The local file-operation module and the synthetic inventory/metadata suites pass. The TypeScript build and JavaScript syntax checks pass. Browser end-to-end behavior and the local HTTP server suite were not verified in this run: the available browser could not connect to the loopback test server, and the restricted environment denied local listener access. No user folder, real image, browser file permission, or destructive UI action was used during these checks.

## Automated checks

| Check | Result |
|---|---|
| Studio file operations, metadata, and inventory | Passed: 31 synthetic tests, 0 failures |
| TypeScript build | Passed: `npm run build` |
| JavaScript syntax | Passed: `site/studio.js`, `site/studio-file-ops.js`, `site/studio-scan.js`, and file-operation tests |
| Static local HTTP/security suite | Not run: its listener-based checks require loopback access unavailable in this environment |
| Full repository test chain | Not run in this verification pass |
| Visual/browser smoke | Incomplete: loopback page timed out; no claim of rendered or end-to-end validation |

The synthetic file-operation suite covers chunked SHA-256, exact-copy verification, source preservation on copy failure, explicit confirmation and permission checks, path validation, archive collisions and unknown data folders, resumable interruption states, attribution of already-absent bytes, restore conflicts and source-folder confirmation, retained archive copies, typed purge confirmation, and cancellation.

## Browser smoke limitation

The test page was directed only to `127.0.0.1` on the dedicated test port. The browser reported a connection timeout and no listening process was found on that port. No non-loopback binding was used, and the test was stopped there. A future human smoke check should use only a disposable folder containing synthetic images. It should verify the UI, permission denial, a confirmed archive to a separate folder, restore, and a purge only after checking the recovered files. Do not use a personal collection for first-run validation.

## Product and safety limits

- Studio serves a fixed local asset allowlist on IPv4 loopback. It does not expose a file-upload route; selected image bytes and metadata are processed in the browser.
- Folder inventory and the compatibility picker remain read-only. Archive actions require separate write permissions, a complete scan, a manually selected bounded batch, exact path review, and a stated reason.
- Archive bytes are copied and byte/hash verified before source removal. A local journal is stored in the selected archive folder. If a source is already absent during recovery, its bytes are reported separately and are not newly attributed to Guardian.
- Restore preflights for an existing target and retains the archive copy after success. Purge requires a second acknowledgement, the exact typed word `PURGE`, and another integrity check.
- A failed restore may leave a partial target file beside the retained archive; inspect that path before retrying.
- Browser file APIs do not provide a portable atomic no-replace transaction against unrelated processes changing the same folders at the same time. The beta tells users to keep both folders unchanged and avoid concurrent Guardian sessions; the UI must not describe this as a database-grade transaction.
- A same-volume archive does not free device space. Even after purge, the app does not measure OS-reported free space.
- Metadata parsing is limited to supported PNG text chunks. Other image types are inventoried, not asserted to be metadata-free. Scan caps and unsupported inputs can make results partial.

## Human validation still required

- Open Studio in a supported Chromium desktop browser and inspect the synthetic demo at desktop and narrow widths.
- With a disposable synthetic folder only, verify scan and permissions; archive one manually selected file to a different folder; compare bytes; restore it; confirm the archived copy remains; then test purge on synthetic data.
- Verify keyboard focus and screen-reader labels for every dialog, permission denial, cancellation, interrupted recovery, and error states.
- Run the loopback HTTP security tests and the full repository suite in an environment that permits a temporary `127.0.0.1` listener.
- Do not enable real-user cleanup or call this production-safe until browser testing covers supported browsers and the residual concurrent-folder-change limitation is acceptable.
