# Guardian Studio — verification report

**Date:** 15 October 2026
**Scope:** Browser Studio plus Windows desktop packaging for local AI-image inventory and opt-in archive/restore/purge.
**Design source:** [`../DESIGN.md`](../DESIGN.md)
**Interaction contract:** [`../UX-CONTRACT.md`](../UX-CONTRACT.md)

## Verification status

On 15 October, the Studio file workflow changed to a marked `Corbeille` inside the chosen source folder. Exact paths and sizes are visible inline before archiving; permanent deletion has its own inline list and acknowledgement checkbox. The final `npm test` run passed 323 tests across the repository packages, with one OS-dependent skip; build and architecture checks passed. The updated Studio loaded at `http://127.0.0.1:8768/` and rendered its synthetic demo. Actual browser write permissions and file operations were not exercised manually. No user folder or real image was changed.

## Automated checks

| Check | Result |
|---|---|
| Studio file operations, metadata, inventory, watcher, and UI contracts | Passed in the full suite |
| TypeScript build | Passed as part of `npm test` |
| Browser-backed local HTTP/security checks | Passed: server headers, assets, methods, paths, origin, and watcher status route |
| Full repository test chain | Passed: 323 tests; one OS-dependent test skipped |
| Architecture contract | Passed: five workspace packages and dependency boundaries |
| Updated Studio visual smoke | Passed: current local page rendered synthetic demo at port 8768 |
| Browser file permission and archive/delete flow | Not manually verified; use a disposable synthetic folder before personal data |
| Packaged Windows installer | Not rebuilt in this verification run |

The synthetic file-operation suite covers chunked SHA-256, exact-copy verification, source preservation on copy failure, permission checks, marked Corbeille identity, refusal to adopt a non-empty user folder, path validation, archive collisions and unknown data folders, resumable interruption states, restore conflicts, retained copies, checkbox-confirmed permanent deletion, and cancellation.

## Browser smoke limitation

The updated local server on `127.0.0.1:8768` rendered the current synthetic demo. This does not validate browser permission prompts or real file writes. Use only a disposable folder containing synthetic images for a manual smoke check: deny write permission and confirm no changes; then grant it, archive one file into the source folder's Corbeille, compare bytes, restore it, confirm the Corbeille copy remains, and finally delete the Corbeille copy through the inline acknowledgement. Do not use a personal collection for first-run validation.

## Product and safety limits

- Browser Studio serves a fixed local asset allowlist on IPv4 loopback. Desktop Studio serves the same fixed assets from the secure `guardian://studio` origin. Neither exposes a file-upload route; selected image bytes and metadata are processed in the local Chromium renderer.
- Folder inventory and the compatibility picker remain read-only. Archive selection requires a complete scan, a manually selected batch of at most 20 files, and an inline exact path/size review. The archive action asks for source-folder write permission and creates a marked Corbeille there.
- Archive bytes are copied and byte/hash verified before source removal. The local journal and archive data are stored under `Corbeille/.guardian-quarantine`. If a source is already absent during recovery, its bytes are reported separately and are not newly attributed to Guardian.
- Restore preflights for an existing target and retains the Corbeille copy after success. Permanent deletion requires reviewing its inline path/size list, checking the acknowledgement, and another integrity check.
- A failed restore may leave a partial target file beside the retained archive; inspect that path before retrying.
- Browser file APIs do not provide a portable atomic no-replace transaction against unrelated processes changing the same folders at the same time. The beta tells users to keep both folders unchanged and avoid concurrent Guardian sessions; the UI must not describe this as a database-grade transaction.
- Archiving keeps the copies on the same device until permanent deletion. Even after deletion, the app does not measure OS-reported free space.
- Metadata parsing is limited to supported PNG text chunks. Other image types are inventoried, not asserted to be metadata-free. Scan caps and unsupported inputs can make results partial.

## Human validation still required

- Open the packaged Windows app and inspect the synthetic demo, folder permission denial, and filesystem access on a disposable synthetic folder.
- Open browser Studio in a supported Chromium desktop browser and inspect the synthetic demo at desktop and narrow widths.
- With a disposable synthetic folder only, verify scan and permission denial/grant; archive one manually selected file to Corbeille; compare bytes; restore it; confirm the archived copy remains; then delete that copy after checking the inline paths.
- Verify keyboard focus and screen-reader labels for every dialog, permission denial, cancellation, interrupted recovery, and error states.
- Run the loopback HTTP security tests in an environment that permits a temporary `127.0.0.1` listener; rerun the suite after changes.
- Do not enable real-user cleanup or call this production-safe until browser testing covers supported browsers and the residual concurrent-folder-change limitation is acceptable.
