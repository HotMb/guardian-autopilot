# Guardian Studio — verification report

**Date:** 14 October 2026
**Scope:** Local AI-image inventory, metadata review, and opt-in archive/restore/purge beta.
**Design source:** [`../DESIGN.md`](../DESIGN.md)
**Interaction contract:** [`../UX-CONTRACT.md`](../UX-CONTRACT.md)

## Verification status

The local file-operation module and the synthetic inventory/metadata suites pass. The TypeScript build and JavaScript syntax checks pass. The static Studio content assertion passes. The browser could render an existing Studio demo tab on port 8767, but its copy did not match the current source, so it is not accepted as a current-build smoke test. A server started from this checkout on port 8765, but the browser timed out when connecting to it. The listener-backed HTTP suite therefore remains unverified. No user folder, real image, browser file permission, or destructive UI action was used.

## Automated checks

| Check | Result |
|---|---|
| Studio file operations, metadata, and inventory | Passed: 31 synthetic tests, 0 failures |
| TypeScript build | Passed: `npm run build` |
| JavaScript syntax | Passed: `site/studio.js`, `site/studio-file-ops.js`, `site/studio-scan.js`, and file-operation tests |
| Static Studio content assertion | Passed: one test, run without opening a listener |
| Listener-backed local HTTP/security checks | Not verified: browser timed out against the server started from this checkout |
| Full repository test chain | Not run in this verification pass |
| Visual/browser smoke | Incomplete: an existing stale demo rendered; the current checkout could not be reached from the browser |

The synthetic file-operation suite covers chunked SHA-256, exact-copy verification, source preservation on copy failure, explicit confirmation and permission checks, path validation, archive collisions and unknown data folders, resumable interruption states, attribution of already-absent bytes, restore conflicts and source-folder confirmation, retained archive copies, typed purge confirmation, and cancellation.

## Browser smoke limitation

The current checkout's server was started on `127.0.0.1:8765` and printed its listening URL, but the separate browser environment returned `ERR_CONNECTION_TIMED_OUT` for that address. An existing demo tab at `127.0.0.1:8767` did render the synthetic collection and archive panel, but it exposed stale copy and was not treated as a validation of this checkout. No non-loopback binding was used. A future end-to-end smoke check should use only a disposable folder containing synthetic images. It should verify the UI, permission denial, a confirmed archive to a separate folder, restore, and a purge only after checking the recovered files. Do not use a personal collection for first-run validation.

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
