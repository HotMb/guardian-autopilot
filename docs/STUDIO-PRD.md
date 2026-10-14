# Guardian Studio — local AI image archive

**Status:** Local archive beta with an assisted folder-watch pilot; human-confirmed file changes only, updated 14 October 2026
**Design source:** [`DESIGN.md`](../DESIGN.md)
**Interaction contract:** [`UX-CONTRACT.md`](../UX-CONTRACT.md)

## Product job

Help creators understand where locally generated image storage is going, monitor one explicitly selected output folder, inspect supported generation metadata, and review exact byte-identical files before deciding manually what to keep. Storage triage is the primary job; CleanCode is a separate code-maintenance capability in the same repository. Willingness to pay and category demand remain {{UNVALIDATED}}.

## Current user flow

1. Start Guardian Studio from the CLI. The app is served only on `127.0.0.1` and begins with explicitly synthetic sample data. Optionally pass one local image folder with `guardian studio --watch <image-folder>` to start the read-only folder watcher.
2. Choose a folder through the browser's read-only directory picker, with a compatibility file-input fallback. No write permission is requested.
3. See the supported image count and aggregate bytes, then review up to the 10,000 largest files. The table renders a fixed page of 40 rows at a time. Archives beyond the entry cap or retained review set are explicitly marked partial.
4. Select a PNG to inspect supported generation metadata. Prompt/workflow values remain in memory for the selected file and are revealed only after an explicit disclosure action.
5. Select exact files manually. A complete scan and separate source/archive write permissions are required before Guardian can offer archive review.
6. Confirm the exact paths, byte count, and reason in an app dialog. Guardian streams a copy to the chosen archive folder, verifies the copied bytes, saves a local journal, and removes the source entry only after verification. A failed or cancelled copy leaves the source in place.
7. Restore only into the selected source folder after checking the original relative path is absent; the verified archive copy remains until a separate irreversible purge is confirmed with a checkbox and the typed word `PURGE`. A failed restore may leave a partial target file, which must be inspected before retrying.

## Supported scope

- Local-only HTML/CSS/JavaScript app; no hosted scan, account, analytics, telemetry, cloud sync, or file-upload route. It exposes one same-origin read-only status endpoint for the optional local watcher.
- Browser scanning uses `showDirectoryPicker({mode: 'read'})` where available; the compatibility file-input picker remains read-only. Archive is offered only where directory handles support separately granted `readwrite` permission. Each permission request follows a direct user gesture.
- Optional watcher mode accepts one folder only from the CLI. It uses local filesystem events plus a 60-second full reconciliation, inventories image filenames, byte counts, and modification times, and keeps state in memory for this process. It lists new/changed files and images at least 10 MiB; large size is a review signal, never a deletion recommendation.
- Watcher traversal is capped at 250,000 directory entries and the visible queue at 100 candidates. It ignores symlinks, `.guardian`, `.guardian-quarantine`, and common build/cache folders. If native filesystem events fail, it falls back to periodic checks and labels that mode.
- Current image-extension inventory: PNG, JPEG, WebP, GIF, AVIF, and SVG. Preview is disabled for SVG. Generation-metadata parsing is currently only for PNG text chunks; other types must be labeled not checked, not metadata-free.
- PNG parser reads only the first 1 MiB of the selected PNG, recognizes generation-oriented `tEXt` and uncompressed `iTXt` fields (including Stable Diffusion WebUI `parameters` and ComfyUI `prompt` / `workflow`), and caps each displayed field at 256,000 characters. It does not decode compressed `zTXt`/compressed `iTXt`, parse general EXIF, validate image integrity, or claim every producer is compatible. Truncated or malformed input is reported as partial/incomplete.
- The currently selected file's parsed metadata is held in page memory only. Values are inserted as text, not HTML. Metadata is not placed in browser storage, URLs, logs, or remote requests; changing selection clears the cached result.
- Exact duplicate candidates are grouped by file size, hashed with SHA-256 only when no larger than 64 MiB, and then compared byte-for-byte in bounded chunks before being labeled exact. Read failures and files over the cap are not marked as duplicates.
- Inventory traversal is capped at 250,000 entries; at most 10,000 largest supported image files are retained for review and exact-duplicate checks. The app reports when those limits, unreadable entries, or the 64 MiB hashing cap make coverage partial. The table is strictly paginated at 40 rows per page.
- Inventory progress is yielded to the browser every 250 entries. SHA-256 duplicate checks use a same-origin module worker when available and fall back to the main thread; only byte-confirmed groups are labeled exact. Cancellation remains cooperative and cannot interrupt one in-flight browser file read or Web Crypto digest.
- Browser folder scans, image bytes, duplicate comparisons, and file operations remain in the browser page. In watcher mode the local service reads metadata from only the CLI-selected folder and sends a bounded relative-path/status snapshot to the same-origin page; image bytes, hashes, and prompts are not returned by the watcher. The server accepts no caller-supplied filesystem path and exposes no mutation endpoint. A chosen archive directory still contains `.guardian-quarantine/manifest.json` and opaque archive data files; its paths, reasons, byte counts, hashes, and lifecycle state are sensitive local data.
- Demo records and preview images are generated synthetic samples. Their metadata is also synthetic and must never be confused with a scan of a real image.

## Safety and privacy requirements

- Bind only to IPv4 loopback. Keep the fixed asset allowlist, exact Host validation, GET-only server, cross-origin/cross-site rejection, restrictive CSP, `nosniff`, no-referrer, and same-origin resource policy.
- No caller-supplied filesystem path may be opened by an HTTP request. The watch root is supplied once through the CLI; the only new route is fixed `GET /api/watch/status`, which accepts no query string and performs no file operation. Do not add an upload endpoint or remote request for folder contents.
- The watcher performs only bounded directory enumeration and file metadata reads. It never opens image bytes, selects a candidate, moves, renames, archives, or deletes a file. Do not request write permission during browser scan. Only a separate click can request source write access or open the archive picker in `readwrite` mode.
- Never choose a file automatically. Archive is limited to 20 explicitly selected files per operation and requires a non-empty user reason, a full path/count/byte review, and a final confirmation. Partial/incomplete scans cannot archive.
- Archive copy is chunked at 1 MiB and verified by byte comparison plus incremental SHA-256. The source entry is removed only after the archived file and durable `verified` journal state have been committed. Permission, write, quota, collision, cancellation, and verification failures leave the source intact; an interrupted owned partial archive can be explicitly resumed after the user reviews the same file again.
- Keep `/.guardian-quarantine` protected from traversal and selection. Refuse unsafe relative paths and an archive journal that is malformed or exceeds bounds. Never overwrite a detected existing archive payload or restore target.
- Restore is explicit, checks the source-relative target before writing, and retains the verified quarantine copy. The user must confirm they selected the original source folder. If a target exists at the check, stop and preserve the archive. A failed restore can leave a partial target which should be inspected before retrying.
- Purge is a separate irreversible action. The dialog lists each exact path and stored byte count, requires a separate acknowledgement checkbox and exact `PURGE` text, verifies the archive hash before removal, and journals the purge state for interrupted recovery.
- Report only verified bytes removed from the selected source or from Guardian's archive. Do not claim or measure operating-system free space. Quarantine on the same storage volume does not reduce total device storage; Guardian cannot verify whether the chosen destination is another volume.
- Browser filesystem APIs do not provide a portable atomic no-replace reservation against another application changing the folder between Guardian's preflight check and write. Use this local beta only while other programs are not changing either selected folder; this residual concurrency limitation prevents a claim of OS-level transactional safety.
- Clear transient selection, metadata, and review-plan state on folder switch/rescan or tab close. The local archive journal and bytes are the only persisted operation state; no browser database or remote service is used.
- Never equate large size, visual similarity, or a metadata marker with a reason to remove a file.
- Keep the scope and completeness of scans visible: file-count cap, hash-size cap, partial cancellation, unsupported metadata, and read errors must not be described as full verification.

## Acceptance criteria

- `guardian studio` serves the app only at a loopback URL. Optional `--watch <folder>` monitors one CLI-selected folder; fixed `GET /api/watch/status` accepts no path or query and no write endpoint exists.
- Demo works without a selected folder and clearly marks every demo record/metadata value as synthetic. Watch mode can be off, active, polling, partial, empty, or truncated; the queue is informational and never selects an archive candidate.
- Folder selection remains read-only until separately authorized; the browser never transmits selected file paths, bytes, hashes, or prompts.
- PNG parser tests cover Stable Diffusion WebUI parameters, ComfyUI prompt/workflow, `iTXt`, compressed metadata, malformed/truncated input, bounded values, and unsupported input.
- Exact-duplicate tests cover equal bytes, same-size different bytes, forced hash collision, file read error, oversize skip, and cancellation. Only byte-confirmed groups become selectable.
- Search, filters, sorting, 40-row pagination, preview, details, keyboard focus, review-plan export for selected files, and clear empty/error/partial states work.
- PNG prompt/workflow fields require explicit disclosure and are inserted using safe text rendering. The UI clearly labels PNG-only support and the 1 MiB/256,000-character bounds.
- Archive never removes the source before the verified copy and journal commit; failures/cancellation preserve the source and resumable state.
- Restore refuses an existing target and retains its verified archive copy. Purge requires a separately confirmed exact selection, typed confirmation, and a verified archive hash.
- Protected archive folders are never scanned; selected archive targets are not intentionally overwritten. Filesystem concurrency limitations are communicated to the user.
- Byte counters never claim OS free-space changes. Same-volume archive retention is explained.
- Server security tests reject unexpected methods, paths, Host, Origin, cross-site requests, and watch-status query parameters. Watcher tests use disposable folders and verify large/new candidate reporting, protected-directory exclusion, entry caps, and unchanged source bytes.
- CLI smoke check starts `guardian studio --watch <temporary-folder>`, reads `/api/watch/status`, and shuts the process down cleanly.

## Known limitations and next architecture boundary

- The watcher currently monitors one folder supplied at launch. New/changed status exists only for the lifetime of the process; a restart establishes a new baseline. The CLI path is less discoverable than an in-app folder picker and should be tested with pilot users. Category demand is {{UNVALIDATED}}.
- The watcher performs bounded metadata enumeration; it does not verify image content, detect visual similarity, or identify exact duplicates. Use Studio's separate browser scan for byte-confirmed duplicates.
- Native event support varies by filesystem and operating system. Guardian reconciles every 60 seconds, but unusual remote/network filesystem behavior and very large folder performance need wider pilot measurement.
- The compatibility picker and unsupported browsers remain read-only. The optional archive feature depends on the File System Access API. See [MDN directory input](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory), [`showDirectoryPicker()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), and [`getFileHandle()`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle/getFileHandle).
- Folder traversal is capped at 250,000 entries and the app retains at most 10,000 largest image handles for inspection; larger archives produce partial duplicate coverage. Duplicate hashing is capped at 64 MiB. Archive copy, verification, and archive/purge hashing stream in 1 MiB chunks; cancellation is cooperative and honored at safe chunk/item boundaries.
- Metadata is parsed when a PNG is selected, not indexed across every file. Search does not yet index prompts, workflow graphs, model names, seeds, or parameters across the collection.
- This is a browser-local beta, not a signed native application. It does not provide atomic filesystem transactions, symlink-level guarantees, or protection from another process changing the selected folders concurrently. Real-file use should follow disposable-folder validation and maintain an independent backup. A production desktop product needs a platform-specific file provider and OS-level recovery testing.
- Visual/perceptual similarity, broad metadata formats (JPEG/WebP/EXIF), AI model analysis, automated cleanup, persistent catalogs, and cloud features remain out of scope until individually specified and tested.
