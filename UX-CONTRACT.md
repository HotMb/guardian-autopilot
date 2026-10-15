# Guardian Studio UX Contract

This contract records interface behavior only. Product scope and privacy constraints are maintained in [`docs/STUDIO-PRD.md`](docs/STUDIO-PRD.md); visual identity and token values are maintained in [`DESIGN.md`](DESIGN.md).

## Product context

- Audience: creators who locally generate and curate images, especially Stable Diffusion WebUI and ComfyUI users.
- Primary job: understand local AI-image storage consumption, then inspect supported generation metadata and review exact byte-identical files plus heuristic visual-variant candidates before making a human decision.
- Active locale: English (`en`).
- Accessibility baseline: semantic HTML, keyboard operation, visible focus, live scan status, reduced motion, 44px important targets, 12px minimum text, and responsive page scrolling. At 200% zoom, only the file table may scroll horizontally.
- Product boundary: Studio is a local image-archive tool with an optional one-folder watcher started from the CLI. Watch and browser scans are read-only; archive/restore/purge remain separately authorized local file operations. CleanCode remains a separate product capability.

## Business and privacy sources

| Scope | Authoritative source | Reviewed |
|---|---|---|
| Studio product scope, supported formats, privacy, size limits, and mutation lifecycle | [`docs/STUDIO-PRD.md`](docs/STUDIO-PRD.md) | 14 Oct 2026 |
| Design tokens and product visual language | [`DESIGN.md`](DESIGN.md) and the runtime tokens in `site/styles.css` | 14 Oct 2026 |
| Local server boundary | `src/studio.ts` and `tests/studio-server.test.mjs` | 14 Oct 2026 |

No account, permission-role, billing, or legal flow is part of Studio's current interface.

## Canonical UI map

The component map below uses the five-column schema required by the strict interface audit. The detailed flow ownership map that follows remains the product-specific source of truth.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Table Selection | Manual review state in site/studio.js | state.selectedForPlan and the selection rules in this contract | List and contact-sheet controls share manual selection; archive recovery rows keep a separate selection | tests/studio-contact-sheet.test.mjs and tests/studio-file-ops.test.mjs |
| Select/Listbox | No native select or custom listbox is used | Folder picker and labeled search/filter controls in site/studio.html | Keep browser directory pickers and buttons; introduce a listbox only with a defined search need | tests/studio-contact-sheet.test.mjs |
| Date | No date or time input is used | File timestamps are informational scan metadata | No date-picker variant in the current interface | tests/studio-contact-sheet.test.mjs |
| Form | Inline archive review and purge acknowledgement in site/studio.html and site/studio.js | Exact path/size review before archiving; separate checkbox before permanent deletion | Inline controls for archive and purge; restore and recovery retain focused dialogs; no hosted form submission | tests/studio-file-ops.test.mjs |
| Scrollbar | Global tokens in site/styles.css; scoped overflow in site/studio.css | Design tokens and table, journal, preview, and restore/recovery dialog scroll surfaces in DESIGN.md | Standards-based global color/width with browser fallback; scoped overflow only where content requires it | tests/studio-contact-sheet.test.mjs |
| Toast | No toast component; #studio-notice and operation status are persistent live regions | Notice and progress behavior in this contract | Inline status with text and aria-live; no disappearing success toast | tests/studio-contact-sheet.test.mjs and tests/studio-file-ops.test.mjs |
| CRUD | Local file-operation engine in site/studio-file-ops.js | Archive, restore, permanent deletion, and recovery rules in this contract | Inline archive and delete actions; restore/recovery keep explicit review dialogs; no HTTP mutation route | tests/studio-file-ops.test.mjs and tests/studio-archive-destination.test.mjs |

| Capability | Owner | Behavior and verification |
|---|---|---|
| Image list and contact sheet | `site/studio.html` + `site/studio.js` | The labeled List / Contact sheet buttons are a single-choice presentation control with `aria-pressed` state. Both layouts project the same sorted, filtered page of 40 images and preserve inspector, search, folder/view filters, pagination, and manual review selection. The contact sheet uses local previews and keeps each complete path, name, size, and signal visible. |
| Similar candidates | `data-view="similar"` and `similarGroup` in `site/studio.js` | In contact-sheet mode, members on the current page are placed side by side under a candidate-group heading. Group counts disclose when remaining matches are on another page. Visual similarity is explicitly a heuristic; exact byte matches remain a separate signal, large size is informational, and no candidate is checked automatically. |
| Selection for review/archive | `state.selectedForPlan` in `site/studio.js` | Selection is always manual and spans pages/filters. Exact-match evidence and visual-candidate hints remain separate from user judgment. Archive requires a complete inventory/exact scan and at most 20 files; exact paths and sizes stay visible inline before the archive action. |
| Search | Native labeled search input in `site/studio.html` | Immediate local filename/path filtering; clear action resets to page 1 and returns focus to search. No prompt/workflow full-archive search. |
| Notices/progress | `#scan-progress` and `#studio-notice` live regions | Inventory, hash, and visual-thumbnail stages report progress; byte confirmation is indeterminate. Cancellation and partial results are explicitly reported. |
| Metadata disclosure | Native `<details>` created by `site/studio.js` | Values are absent from the DOM until the user expands the metadata disclosure and then a field; content is inserted with `textContent`; selection change clears cached data. |
| File picker and permissions | `showDirectoryPicker({mode: 'read'})` plus native directory input fallback | Scanning asks only for read access. The fallback remains read-only. The Archive selection action requests write access to the selected source folder and creates or opens its marked `Corbeille` child. |
| Archive operations | `site/studio-file-ops.js` + inline review in `site/studio.html` | Stream-copy into `Corbeille`, verify bytes, commit journal state, then remove source. Failures preserve source. Archive stays recoverable; restore checks for an existing path and keeps the Corbeille copy. A failed restore may leave a partial target to inspect. |
| Permanent deletion | Inline `#purge-selected` and `purgeQuarantined()` | Irreversible; lists every eligible Corbeille path and byte count, requires a separate acknowledgement checkbox, verifies hashes, then removes only Guardian archive copies. |
| Archive journal | `Corbeille/.guardian-quarantine/manifest.json` in the selected source folder | Local durable paths/reasons/hash/state; no browser database or upload. Managed Corbeille is excluded from image scans. The server exposes only the fixed watcher status endpoint and has no archive mutation endpoint. |

## Dataset navigation

- Search, view filter, folder filter, sort, and page are transient in-memory state; no path, prompt, or filter is put in the URL or persistent storage.
- Contact-sheet thumbnails use the same local object URLs or bundled synthetic demo images as list previews. Paths are rendered as text and wrap instead of being hidden in a tooltip or truncated; similarity and size signals never imply an automatic selection.
- Page size is fixed at 40 images in both list and contact-sheet modes. Page navigation replaces the visible rows/cards rather than accumulating them; changing layout preserves the current page.
- Search/filter/sort changes return to page 1. Previous/Next stay present and disable at boundaries.
- Switching List / Contact sheet does not reset search, filters, sorting, page, selected inspector item, or manual review candidates. In Similar candidates, cards are grouped for side-by-side visual review; page-split groups say when more candidates appear on another page.
- Empty collection and no-result filters use the empty state, with a reset action.
- Selection persists across pages and filters in one scan and is cleared on rescan/folder selection or tab close.
- The review-plan view lists selected paths and candidate sizes; JSON is downloaded only after the user activates Export. It does not claim that candidate bytes are recovered. Paths may be sensitive; the user is warned to keep the export private.
- Corbeille journal rows are paged in batches of 20. Recovery selection scopes only checked rows. The permanent-delete panel lists every eligible path and stored byte total inline before its acknowledgement checkbox.

## Flow ledger

| Operation | Pending | Success / feedback | Failure or cancellation |
|---|---|---|---|
| Watch one local folder | User passes one folder to guardian studio --watch | Show new/changed and at least 10 MiB image candidates; only names, relative paths, byte counts, and times are sent to the same-origin Studio page | Watcher is off by default. Its current state stays visible in the optional expandable panel. Partial coverage, periodic polling fallback, pending file stability, queue truncation, and no-candidate states are visible; no file is modified. |
| Choose local folder | User-selected read-only picker; no remote upload | Show inventory counts/bytes and largest files retained for review | Empty selection preserves the current view; read errors are reported and coverage becomes partial. |
| Scan duplicate candidates | Progressive local inventory, exact-byte pass, then bounded visual-hint pass; Stop scan available | Same-size candidates are SHA-256 grouped and byte-compared before being called exact. PNG/JPEG/WebP/AVIF perceptual hashes create a separate candidate view; GIF/SVG are skipped and pair-cap, decode, worker, or cancellation limits are visible. Visual hints never imply interchangeability or select files. |
| Change list/contact-sheet layout | Activate the labeled presentation button | Replace only the visual layout for the same current page; preserve filters, search, sort, inspector item, and manual review checks | Keep the same page and selection when switching either way; keyboard focus stays on the activated control. Similar candidates appear side by side only as human-review hints, with full paths visible. |
| Inspect PNG metadata | Only selected PNG is read; 1 MiB bounded read | Show recognized supported fields behind explicit disclosure | Unsupported format/compression, malformed, truncated, and read-error states are distinct from “no supported fields.” |
| Search/sort/page | Local synchronous view update | Preserve current scan and selected review items | Reset to first page; no server request. |
| Export review plan | User-initiated JSON download | List selected relative paths and candidate size separately from actual bytes freed (0 B); state that files are unchanged | No plan if selection is empty or scan is in progress; warn that paths can be sensitive. |
| Prepare Corbeille and archive selected files | Inline exact path/count/size review; Archive selection requests source write permission and creates `Corbeille` in that folder | Copy, verify, journal, then remove source; show verified source bytes removed and say OS free space is not measured | Permission, collision, quota, or verification failure leaves source in place. A non-empty unmarked `Corbeille` is never adopted. Interrupted journal entries can be reviewed and resumed. |
| Restore selected files | App-owned modal and explicit confirmation that the selected source is the original | Write original relative paths after checking absence; retain verified archive copy and report restored bytes | A target already present at the check stops the item. The check/write sequence is not atomic; a failed write can leave a partial target. Wrong source-folder name or permission error preserves archive. User is told to keep selected folders unchanged during operations. |
| Permanently delete Corbeille copies | Inline exact paths/bytes and acknowledgement checkbox; separate Delete permanently button | Delete only verified Guardian archive data and persist purged journal state; report bytes removed from Corbeille, not OS free space | Unchecked acknowledgement or no eligible files keeps action disabled. Interrupted purge is recoverable from `purging` journal state and a fresh explicit confirmation. Hash mismatch blocks purge. |
| Cancel/rescan | Stop is cooperative; a newer scan invalidates older results | Keep only results confirmed before cancellation; rescan clears transient state | Explain partial coverage; never present partial results as a complete scan. |

## Navigation, feedback, and privacy

- Document title: `Guardian Studio — AI image storage`.
- The page is a single route. The persistent header and folder/navigation rail adapt at narrow widths; the document remains vertically scrollable.
- Tables retain visible horizontal overflow at narrow widths rather than silently hiding comparison data.
- Prompt/workflow values are treated as potentially sensitive. They stay in page memory for the selected file only and appear only after explicit disclosure. No clipboard copy, URL, console output, local/session storage, telemetry, upload, or remote service is part of the flow. Watch mode makes one same-origin request to the local Guardian process for bounded relative paths and file metadata; no image bytes, hashes, or prompts leave the machine. Operation journal metadata is persisted inside the selected source folder's Corbeille and may contain sensitive paths.
- Scanning never asks for write permission. Archive, restore, and permanent deletion are direct user actions; no automatic candidate is selected. The compatibility browser fallback remains read-only.
- Every removal is preceded by byte verification; app success copy states whether bytes were moved into Corbeille or deleted from Guardian's archive. Never claim device free space. Archiving keeps copies on the same device until the user permanently deletes them.
- The browser cannot guarantee atomic no-replace operations against external folder changes. Restore and recovery dialogs warn users to keep selected folders unchanged and not run concurrent Guardian instances; this residual limitation is explicit in the PRD.
- The synthetic demo and its embedded sample metadata are always labeled synthetic; they are not results from the user's files.

## Verification

- Unit tests: `tests/studio-metadata.test.mjs`, `tests/studio-scan.test.mjs`, `tests/studio-contact-sheet.test.mjs`, `tests/studio-file-ops.test.mjs`, `tests/studio-watcher.test.mjs`.
- HTTP safety tests: `tests/studio-server.test.mjs`; browser polling is restricted to the fixed local `/api/watch/status` route.
- Browser checks: synthetic demo and temporary-folder fixtures only, exact and visual-candidate views, resized/re-encoded raster fixtures, skipped/corrupt/cancelled/capped visual scans, metadata disclosure, filters/sort/pages, list/contact-sheet state preservation and candidate grouping, permission denial/grant, marked Corbeille creation and scan exclusion, copy verification, restore conflict, retained archive copy, inline permanent-delete acknowledgement, keyboard focus, reduced motion, and narrow viewport. Never exercise destructive controls against a user folder during automated smoke tests.
- Package check: `npm run verify:package` and `npm pack --dry-run --json`.
- Architecture boundary: browser-local APIs are a limited beta and not a substitute for native transactional file operations; see the residual concurrency limitation in the PRD.
