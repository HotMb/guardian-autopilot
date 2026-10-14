# Guardian Studio — verification report

**Date:** 14 October 2026
**Scope:** Browser Studio plus Windows desktop packaging for local AI-image inventory and opt-in archive/restore/purge.
**Design source:** [`../DESIGN.md`](../DESIGN.md)
**Interaction contract:** [`../UX-CONTRACT.md`](../UX-CONTRACT.md)

## Verification status

The full repository suite passed: 317 tests passed and one OS-dependent test was skipped. The desktop protocol/security tests, desktop package verifier, CLI package verifier, and Windows x64 Squirrel installer build passed. A smoke run of the packaged executable loaded the synthetic Studio demo at `guardian://studio/`; the renderer reported a secure context and exposed `showDirectoryPicker`. The installer is unsigned. The browser environment could render an existing Studio demo tab on port 8767, but its copy did not match the current source; a server from this checkout on port 8765 timed out from that separate browser environment. Actual folder permission and archive/restore/purge actions were not exercised. No user folder, real image, browser file permission, or destructive UI action was used.

## Automated checks

| Check | Result |
|---|---|
| Studio file operations, metadata, and inventory | Passed: 31 synthetic tests, 0 failures |
| TypeScript build | Passed: `npm run build` |
| JavaScript syntax | Passed: `site/studio.js`, `site/studio-file-ops.js`, `site/studio-scan.js`, and file-operation tests |
| Static Studio content assertion | Passed: one test, run without opening a listener |
| Desktop origin and protocol security | Passed: 5 tests; exact origin, asset allowlist, headers, GET-only handling, and disabled desktop watcher |
| Desktop package verifier | Passed: isolated renderer settings, resource layout, and Squirrel configuration |
| npm CLI package verification | Passed: CLI and CleanCode packages |
| Windows x64 installer build | Passed: unsigned Squirrel installer generated |
| Listener-backed local HTTP/security checks | Not verified: browser timed out against the server started from this checkout |
| Full repository test chain | Passed: 317 tests; one OS-dependent test skipped |
| Visual/browser smoke | Incomplete: an existing stale demo rendered; the current checkout could not be reached from the browser |
| Packaged desktop startup smoke | Passed: packaged window loaded synthetic demo at the secure app origin; folder selection and file-operation permissions were not exercised |

The synthetic file-operation suite covers chunked SHA-256, exact-copy verification, source preservation on copy failure, explicit confirmation and permission checks, path validation, archive collisions and unknown data folders, resumable interruption states, attribution of already-absent bytes, restore conflicts and source-folder confirmation, retained archive copies, typed purge confirmation, and cancellation.

## Browser smoke limitation

The current checkout's browser server was started on `127.0.0.1:8765` and printed its listening URL, but the separate browser environment returned `ERR_CONNECTION_TIMED_OUT` for that address. An existing demo tab at `127.0.0.1:8767` rendered stale copy and was not treated as validation of this checkout. The packaged window has loaded the demo over its secure origin; filesystem permission and file-operation testing still need a manual smoke check. Use only a disposable folder containing synthetic images: verify permission denial, a confirmed archive to a separate folder, restore, retained archive copy, and a purge after checking the recovered files. Do not use a personal collection for first-run validation.

## Product and safety limits

- Browser Studio serves a fixed local asset allowlist on IPv4 loopback. Desktop Studio serves the same fixed assets from the secure `guardian://studio` origin. Neither exposes a file-upload route; selected image bytes and metadata are processed in the local Chromium renderer.
- Folder inventory and the compatibility picker remain read-only. Archive actions require separate write permissions, a complete scan, a manually selected bounded batch, exact path review, and a stated reason.
- Archive bytes are copied and byte/hash verified before source removal. A local journal is stored in the selected archive folder. If a source is already absent during recovery, its bytes are reported separately and are not newly attributed to Guardian.
- Restore preflights for an existing target and retains the archive copy after success. Purge requires a second acknowledgement, the exact typed word `PURGE`, and another integrity check.
- A failed restore may leave a partial target file beside the retained archive; inspect that path before retrying.
- Browser file APIs do not provide a portable atomic no-replace transaction against unrelated processes changing the same folders at the same time. The beta tells users to keep both folders unchanged and avoid concurrent Guardian sessions; the UI must not describe this as a database-grade transaction.
- A same-volume archive does not free device space. Even after purge, the app does not measure OS-reported free space.
- Metadata parsing is limited to supported PNG text chunks. Other image types are inventoried, not asserted to be metadata-free. Scan caps and unsupported inputs can make results partial.

## Human validation still required

- Open the packaged Windows app and inspect the synthetic demo, folder permission denial, and filesystem access on a disposable synthetic folder.
- Open browser Studio in a supported Chromium desktop browser and inspect the synthetic demo at desktop and narrow widths.
- With a disposable synthetic folder only, verify scan and permissions; archive one manually selected file to a different folder; compare bytes; restore it; confirm the archived copy remains; then test purge on synthetic data.
- Verify keyboard focus and screen-reader labels for every dialog, permission denial, cancellation, interrupted recovery, and error states.
- Run the loopback HTTP security tests in an environment that permits a temporary `127.0.0.1` listener; rerun the suite after changes.
- Do not enable real-user cleanup or call this production-safe until browser testing covers supported browsers and the residual concurrent-folder-change limitation is acceptable.
