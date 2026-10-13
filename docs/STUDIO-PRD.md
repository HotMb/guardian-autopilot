# Guardian Studio — local AI image archive

**Status:** Read-only product phase, updated 14 October 2026
**Design source:** [`DESIGN.md`](../DESIGN.md)
**Interaction contract:** [`UX-CONTRACT.md`](../UX-CONTRACT.md)

## Product job

Help creators understand where locally generated image storage is going, inspect generation metadata Guardian can actually parse, and review exact byte-identical files before deciding manually what to keep. Storage triage is the primary job; CleanCode is a separate code-maintenance capability in the same repository.

## Current user flow

1. Start Guardian Studio from the CLI. The static app is served only on `127.0.0.1` and begins with explicitly synthetic sample data.
2. Choose a folder through the browser's read-only directory picker, with a compatibility file-input fallback. No write permission is requested.
3. See the supported image count and aggregate bytes, then review up to the 10,000 largest files. The table renders a fixed page of 40 rows at a time. Archives beyond the entry cap or retained review set are explicitly marked partial.
4. Select a PNG to inspect supported generation metadata. Prompt/workflow values remain in memory for the selected file and are revealed only after an explicit disclosure action.
5. Select files for human review and export a local JSON plan. Candidate size is not space recovered: Guardian reports 0 B actually freed and does not move, rename, overwrite, or delete files.

## Supported scope

- Local-only static HTML/CSS/JavaScript app; no hosted scan, account, analytics, telemetry, cloud sync, or file-upload route.
- Use `showDirectoryPicker({mode: 'read'})` when present and `<input type="file" webkitdirectory multiple>` as a compatibility fallback. Both are read-only; file mutation is not part of this phase.
- Current image-extension inventory: PNG, JPEG, WebP, GIF, AVIF, and SVG. Preview is disabled for SVG. Generation-metadata parsing is currently only for PNG text chunks; other types must be labeled not checked, not metadata-free.
- PNG parser reads only the first 1 MiB of the selected PNG, recognizes generation-oriented `tEXt` and uncompressed `iTXt` fields (including Stable Diffusion WebUI `parameters` and ComfyUI `prompt` / `workflow`), and caps each displayed field at 256,000 characters. It does not decode compressed `zTXt`/compressed `iTXt`, parse general EXIF, validate image integrity, or claim every producer is compatible. Truncated or malformed input is reported as partial/incomplete.
- The currently selected file's parsed metadata is held in page memory only. Values are inserted as text, not HTML. Metadata is not placed in browser storage, URLs, logs, or remote requests; changing selection clears the cached result.
- Exact duplicate candidates are grouped by file size, hashed with SHA-256 only when no larger than 64 MiB, and then compared byte-for-byte in bounded chunks before being labeled exact. Read failures and files over the cap are not marked as duplicates.
- Inventory traversal is capped at 250,000 entries; at most 10,000 largest supported image files are retained for review and exact-duplicate checks. The app reports when those limits, unreadable entries, or the 64 MiB hashing cap make coverage partial. The table is strictly paginated at 40 rows per page.
- Inventory progress is yielded to the browser every 250 entries. SHA-256 duplicate checks use a same-origin module worker when available and fall back to the main thread; only byte-confirmed groups are labeled exact. Cancellation remains cooperative and cannot interrupt one in-flight browser file read or Web Crypto digest.
- Folder selection, paths, image bytes, metadata values, hashes, and review-plan state remain in the browser page; the local server serves a fixed allowlist of static assets only.
- Demo records and preview images are generated synthetic samples. Their metadata is also synthetic and must never be confused with a scan of a real image.

## Safety and privacy requirements

- Bind only to IPv4 loopback. Keep the fixed asset allowlist, exact Host validation, GET-only server, cross-origin/cross-site rejection, restrictive CSP, `nosniff`, no-referrer, and same-origin resource policy.
- No caller-supplied filesystem path may be opened by the local server. Do not add an upload endpoint or remote request for folder contents.
- Do not request write permission. No delete, move, rename, overwrite, quarantine, or other automated cleanup action is part of this phase. The UI must keep the cleanup action disabled and export only a human-review plan.
- Clear transient selection, metadata, and review-plan state on folder switch/rescan or tab close. No persistence by default.
- Never equate large size, visual similarity, or a metadata marker with a reason to remove a file.
- Keep the scope and completeness of scans visible: file-count cap, hash-size cap, partial cancellation, unsupported metadata, and read errors must not be described as full verification.

## Acceptance criteria

- `guardian studio` serves the app only at a loopback URL; there is no arbitrary filesystem/API route.
- Demo works without a selected folder and clearly marks every demo record/metadata value as synthetic.
- Folder selection remains read-only; the browser never transmits selected file paths, bytes, hashes, or prompts.
- PNG parser tests cover Stable Diffusion WebUI parameters, ComfyUI prompt/workflow, `iTXt`, compressed metadata, malformed/truncated input, bounded values, and unsupported input.
- Exact-duplicate tests cover equal bytes, same-size different bytes, forced hash collision, file read error, oversize skip, and cancellation. Only byte-confirmed groups become selectable.
- Search, filters, sorting, 40-row pagination, preview, details, keyboard focus, review-plan export for selected files, and clear empty/error/partial states work.
- PNG prompt/workflow fields require explicit disclosure and are inserted using safe text rendering. The UI clearly labels PNG-only support and the 1 MiB/256,000-character bounds.
- No action mutates files; a review plan is temporary and explicitly says nothing was changed.
- Server security tests reject unexpected methods, paths, Host, Origin, and cross-site requests.

## Known limitations and next architecture boundary

- The browser file picker is suitable for a cross-browser, read-only workflow. `showDirectoryPicker()` has narrower support and does not solve portable writes. See the official [directory-input API](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory) and [showDirectoryPicker support notes](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).
- Folder traversal is capped at 250,000 entries and the app retains at most 10,000 largest image file handles for inspection; larger archives therefore produce partial duplicate coverage. Individual hashing remains capped at 64 MiB. Hashing reads each eligible file into memory for the browser's one-shot Web Crypto digest; cancellation is honored between asynchronous file operations but cannot abort an in-flight `arrayBuffer()` or digest. Do not raise these caps without measured stress tests and a streaming/native design.
- Metadata is parsed when a PNG is selected, not indexed across every file. Search does not yet index prompts, workflow graphs, model names, seeds, or parameters across the collection.
- Cross-platform file mutation is a separate product decision. Before reversible quarantine, choose supported OSes and packaging/signing/update behavior, then define a narrowly scoped native file-provider contract, path/symlink defenses, pre-move revalidation, collision-safe quarantine, operation journal, failure recovery, and tested restoration. Browser UI must not get general filesystem access.
- Visual/perceptual similarity, broad metadata formats (JPEG/WebP/EXIF), AI model analysis, automated cleanup, persistent catalogs, and cloud features remain out of scope until individually specified and tested.
