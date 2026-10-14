# Guardian Studio UX Contract

This contract records interface behavior only. Product scope and privacy constraints are maintained in [`docs/STUDIO-PRD.md`](docs/STUDIO-PRD.md); visual identity and token values are maintained in [`DESIGN.md`](DESIGN.md).

## Product context

- Audience: creators who locally generate and curate images, especially Stable Diffusion WebUI and ComfyUI users.
- Primary job: understand local AI-image storage consumption, then inspect supported generation metadata and review exact byte-identical files plus heuristic visual-variant candidates before making a human decision.
- Active locale: English (`en`).
- Accessibility baseline: semantic HTML, keyboard operation, visible focus, live scan status, reduced motion, and responsive page/document scrolling.
- Product boundary: Studio is a local image-archive tool with an optional one-folder watcher started from the CLI. Watch and browser scans are read-only; archive/restore/purge remain separately authorized local file operations. CleanCode remains a separate product capability.

## Business and privacy sources

| Scope | Authoritative source | Reviewed |
|---|---|---|
| Studio product scope, supported formats, privacy, size limits, and mutation lifecycle | [`docs/STUDIO-PRD.md`](docs/STUDIO-PRD.md) | 14 Oct 2026 |
| Design tokens and product visual language | [`DESIGN.md`](DESIGN.md) and the runtime tokens in `site/styles.css` | 14 Oct 2026 |
| Local server boundary | `src/studio.ts` and `tests/studio-server.test.mjs` | 14 Oct 2026 |

No account, permission-role, billing, or legal flow is part of Studio's current interface.

## Canonical UI map

| Capability | Owner | Behavior and verification |
|---|---|---|
| Image list and contact sheet | `site/studio.html` + `site/studio.js` | The labeled List / Contact sheet buttons are a single-choice presentation control with `aria-pressed` state. Both layouts project the same sorted, filtered page of 40 images and preserve inspector, search, folder/view filters, pagination, and manual review selection. The contact sheet uses local previews and keeps each complete path, name, size, and signal visible. |
| Similar candidates | `data-view="similar"` and `similarGroup` in `site/studio.js` | In contact-sheet mode, members on the current page are placed side by side under a candidate-group heading. Group counts disclose when remaining matches are on another page. Visual similarity is explicitly a heuristic; exact byte matches remain a separate signal, large size is informational, and no candidate is checked automatically. |
| Selection for review/archive | `state.selectedForPlan` in `site/studio.js` | Selection is always manual and spans pages/filters. Exact-match evidence and visual-candidate hints remain separate from user judgment. Archive requires a complete inventory/exact scan, at most 20 files, explicit write access, a reason, and an exact-path confirmation. |
| Search | Native labeled search input in `site/studio.html` | Immediate local filename/path filtering; clear action resets to page 1 and returns focus to search. No prompt/workflow full-archive search. |
| Notices/progress | `#scan-progress` and `#studio-notice` live regions | Inventory, hash, and visual-thumbnail stages report progress; byte confirmation is indeterminate. Cancellation and partial results are explicitly reported. |
| Metadata disclosure | Native `<details>` created by `site/studio.js` | Values are absent from the DOM until the user expands the metadata disclosure and then a field; content is inserted with `textContent`; selection change clears cached data. |
| File picker and permissions | `showDirectoryPicker({mode: 'read'})` plus native directory input fallback | Scanning asks only for read access. The fallback remains read-only. A separate user gesture requests source write access; a separate directory-picker gesture chooses a `readwrite` archive folder. |
| Archive operations | `site/studio-file-ops.js` + dialogs in `site/studio.html` | Stream-copy and verify before removing source; journal state is committed first. Failures preserve source. Archive stays recoverable; restore checks for an existing path and keeps an archive copy. A failed restore may leave a partial target to inspect. |
| Purge | `#purge-dialog` and `purgeQuarantined()` | Irreversible; lists exact paths and bytes, requires acknowledgement checkbox and typed `PURGE`, verifies hash, then removes only archive copies. |
| Archive journal | `.guardian-quarantine/manifest.json` in the user-selected archive folder | Local durable paths/reasons/hash/state; no browser database or upload. The server exposes only the fixed watcher status endpoint and has no archive mutation endpoint. Show a privacy note whenever the journal is opened. |

## Dataset navigation

- Search, view filter, folder filter, sort, and page are transient in-memory state; no path, prompt, or filter is put in the URL or persistent storage.
- Contact-sheet thumbnails use the same local object URLs or bundled synthetic demo images as list previews. Paths are rendered as text and wrap instead of being hidden in a tooltip or truncated; similarity and size signals never imply an automatic selection.
- Page size is fixed at 40 images in both list and contact-sheet modes. Page navigation replaces the visible rows/cards rather than accumulating them; changing layout preserves the current page.
- Search/filter/sort changes return to page 1. Previous/Next stay present and disable at boundaries.
- Switching List / Contact sheet does not reset search, filters, sorting, page, selected inspector item, or manual review candidates. In Similar candidates, cards are grouped for side-by-side visual review; page-split groups say when more candidates appear on another page.
- Empty collection and no-result filters use the empty state, with a reset action.
- Selection persists across pages and filters in one scan and is cleared on rescan/folder selection or tab close.
- The review-plan view lists selected paths and candidate sizes; JSON is downloaded only after the user activates Export. It does not claim that candidate bytes are recovered. Paths may be sensitive; the user is warned to keep the export private.
- Archive journal rows are paged in batches of 20. Selection scopes only checked rows, not all journal results. Purge/restore dialogs enumerate every selected path and total stored bytes before confirmation.

## Flow ledger

| Operation | Pending | Success / feedback | Failure or cancellation |
|---|---|---|---|
| Watch one local folder | User passes one folder to `guardian studio --watch` at launch | Show new/changed and at least 10 MiB image candidates; only names, relative paths, byte counts, and times are sent to the same-origin Studio page | Watcher is off by default. Partial coverage, periodic polling fallback, pending file stability, queue truncation, and no-candidate states are visible; no file is modified. |
| Choose local folder | User-selected read-only picker; no remote upload | Show inventory counts/bytes and largest files retained for review | Empty selection preserves the current view; read errors are reported and coverage becomes partial. |
| Scan duplicate candidates | Progressive local inventory, exact-byte pass, then bounded visual-hint pass; Stop scan available | Same-size candidates are SHA-256 grouped and byte-compared before being called exact. PNG/JPEG/WebP/AVIF perceptual hashes create a separate candidate view; GIF/SVG are skipped and pair-cap, decode, worker, or cancellation limits are visible. Visual hints never imply interchangeability or select files. |
| Change list/contact-sheet layout | Activate the labeled presentation button | Replace only the visual layout for the same current page; preserve filters, search, sort, inspector item, and manual review checks | Keep the same page and selection when switching either way; keyboard focus stays on the activated control. Similar candidates appear side by side only as human-review hints, with full paths visible. |
| Inspect PNG metadata | Only selected PNG is read; 1 MiB bounded read | Show recognized supported fields behind explicit disclosure | Unsupported format/compression, malformed, truncated, and read-error states are distinct from “no supported fields.” |
| Search/sort/page | Local synchronous view update | Preserve current scan and selected review items | Reset to first page; no server request. |
| Export review plan | User-initiated JSON download | List selected relative paths and candidate size separately from actual bytes freed (0 B); state that files are unchanged | No plan if selection is empty or scan is in progress; warn that paths can be sensitive. |
| Enable source write | Direct click invokes `requestPermission({mode:'readwrite'})` | Show granted/not-granted state; scan remains available without it | Denial leaves archive disabled and does not alter files. Permission is rechecked before each file operation. |
| Choose archive folder | Direct click invokes `showDirectoryPicker({mode:'readwrite'})` | Load/validate the local journal and show its local-only status | Cancellation preserves the current selection; malformed journal blocks archive/restore/purge without rewriting it. |
| Archive selected files | App-owned modal lists path/count/bytes/reason; copy, verify, journal, then source removal | Remove successfully archived files from the source scan; say exact source bytes removed and that OS free space is not measured | Copy, write, permission, quota, or verification failure keeps source; interrupted journal entries can be resumed only after rescan/review. Errors stay in the dialog/status area. |
| Restore selected files | App-owned modal and explicit confirmation that the selected source is the original | Write original relative paths after checking absence; retain verified archive copy and report restored bytes | A target already present at the check stops the item. The check/write sequence is not atomic; a failed write can leave a partial target. Wrong source-folder name or permission error preserves archive. User is told to keep selected folders unchanged during operations. |
| Purge selected archive copies | App-owned high-risk dialog; exact paths/bytes, acknowledgement, typed `PURGE` | Delete only verified archive data and persist purged journal state; report bytes removed from archive, not OS free space | Cancel before deletion preserves data; interrupted purge is recoverable from `purging` journal state and a fresh explicit confirmation. Hash mismatch blocks purge. |
| Cancel/rescan | Stop is cooperative; a newer scan invalidates older results | Keep only results confirmed before cancellation; rescan clears transient state | Explain partial coverage; never present partial results as a complete scan. |

## Navigation, feedback, and privacy

- Document title: `Guardian Studio — AI image storage`.
- The page is a single route. The persistent header and folder/navigation rail adapt at narrow widths; the document remains vertically scrollable.
- Tables retain visible horizontal overflow at narrow widths rather than silently hiding comparison data.
- Prompt/workflow values are treated as potentially sensitive. They stay in page memory for the selected file only and appear only after explicit disclosure. No clipboard copy, URL, console output, local/session storage, telemetry, upload, or remote service is part of the flow. Watch mode makes one same-origin request to the local Guardian process for bounded relative paths and file metadata; no image bytes, hashes, or prompts leave the machine. Operation journal metadata is deliberately persisted only in the user-selected archive folder and may contain sensitive paths/reasons.
- Scanning never asks for write permission. Archive/restore/purge are separate direct user actions; no automatic candidate is selected. Browser fallback remains read-only.
- Every removal is preceded by byte verification; app success copy states whether bytes were removed from the selected source or Guardian archive. Never claim device free space. A same-volume archive preserves device storage until separately purged.
- The browser cannot guarantee atomic no-replace operations against external folder changes. Dialogs warn users to keep selected folders unchanged and not run concurrent Guardian instances; this residual beta limitation is explicit in the PRD.
- The synthetic demo and its embedded sample metadata are always labeled synthetic; they are not results from the user's files.

## Verification

- Unit tests: `tests/studio-metadata.test.mjs`, `tests/studio-scan.test.mjs`, `tests/studio-contact-sheet.test.mjs`, `tests/studio-file-ops.test.mjs`, `tests/studio-watcher.test.mjs`.
- HTTP safety tests: `tests/studio-server.test.mjs`; browser polling is restricted to the fixed local `/api/watch/status` route.
- Browser checks: synthetic demo and temporary-folder fixtures only, exact and visual-candidate views, resized/re-encoded raster fixtures, skipped/corrupt/cancelled/capped visual scans, metadata disclosure, filters/sort/pages, list/contact-sheet state preservation and candidate grouping, permission denial/grant, archive journal, copy verification, restore conflict, typed purge confirmation, keyboard focus, reduced motion, and narrow viewport. Never exercise destructive controls against a user folder during automated smoke tests.
- Package check: `npm run verify:package` and `npm pack --dry-run --json`.
- Architecture boundary: browser-local APIs are a limited beta and not a substitute for native transactional file operations; see the residual concurrency limitation in the PRD.
