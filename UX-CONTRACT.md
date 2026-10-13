# Guardian Studio UX Contract

This contract records interface behavior only. Product scope and privacy constraints are maintained in [`docs/STUDIO-PRD.md`](docs/STUDIO-PRD.md); visual identity and token values are maintained in [`DESIGN.md`](DESIGN.md).

## Product context

- Audience: creators who locally generate and curate images, especially Stable Diffusion WebUI and ComfyUI users.
- Primary job: understand local AI-image storage consumption, then inspect supported generation metadata and review exact byte-identical files before making a human decision.
- Active locale: English (`en`).
- Accessibility baseline: semantic HTML, keyboard operation, visible focus, live scan status, reduced motion, and responsive page/document scrolling.
- Product boundary: Studio is a local, read-only image-archive tool. CleanCode remains a separate product capability.

## Business and privacy sources

| Scope | Authoritative source | Reviewed |
|---|---|---|
| Studio product scope, supported formats, privacy, size limits, and mutation boundary | [`docs/STUDIO-PRD.md`](docs/STUDIO-PRD.md) | 14 Oct 2026 |
| Design tokens and product visual language | [`DESIGN.md`](DESIGN.md) and the runtime tokens in `site/styles.css` | 14 Oct 2026 |
| Local server boundary | `src/studio.ts` and `tests/studio-server.test.mjs` | 14 Oct 2026 |

No account, permission-role, billing, or legal flow is part of Studio's current interface.

## Canonical UI map

| Capability | Owner | Behavior and verification |
|---|---|---|
| Image table | `site/studio.html` + `site/studio.js` | Semantic table; sortable headers are buttons; 40 rows per page; previous/next controls; browser test at narrow and desktop widths. |
| Selection for review | `state.selectedForPlan` in `site/studio.js` | Any retained image may be selected for human review; exact-match evidence is shown separately. Selection spans pages and filters; estimated candidate bytes and actual bytes freed (always 0 B) remain distinct; rescan clears selection. |
| Search | Native labeled search input in `site/studio.html` | Immediate local filename/path filtering; clear action resets to page 1 and returns focus to search. No prompt/workflow full-archive search. |
| Notices/progress | `#scan-progress` and `#studio-notice` live regions | Hash stage is determinate; byte-confirmation stage is indeterminate; cancellation and partial results are explicitly reported. |
| Metadata disclosure | Native `<details>` created by `site/studio.js` | Values are absent from the DOM until the user expands the metadata disclosure and then a field; content is inserted with `textContent`; selection change clears cached data. |
| File picker | `showDirectoryPicker({mode: 'read'})` plus native directory input fallback | Read-only, explicit user action, no write permission; browser support limitations are documented in the PRD. |

## Dataset navigation

- Search, view filter, folder filter, sort, and page are transient in-memory state; no path, prompt, or filter is put in the URL or persistent storage.
- Page size is fixed at 40. Page navigation replaces the table rows rather than accumulating them.
- Search/filter/sort changes return to page 1. Previous/Next stay present and disable at boundaries.
- Empty collection and no-result filters use the empty state, with a reset action.
- Selection persists across pages and filters in one scan and is cleared on rescan/folder selection or tab close.
- The review-plan view lists selected paths and candidate sizes; JSON is downloaded only after the user activates Export. It always states that actual space freed is 0 B and applies no changes. Paths may be sensitive; the user is warned to keep the export private.

## Flow ledger

| Operation | Pending | Success / feedback | Failure or cancellation |
|---|---|---|---|
| Choose local folder | User-selected read-only picker; no remote upload | Show inventory counts/bytes and largest files retained for review | Empty selection preserves the current view; read errors are reported and coverage becomes partial. |
| Scan duplicate candidates | Progressive local inventory, then worker-backed hashing when available; Stop scan available | Same-size candidates are SHA-256 grouped, then compared by bytes before being called exact matches | Stop is cooperative; entry cap, 10,000-file review cap, 64 MiB hash cap, worker errors, and read failures must be visible and make coverage partial. |
| Inspect PNG metadata | Only selected PNG is read; 1 MiB bounded read | Show recognized supported fields behind explicit disclosure | Unsupported format/compression, malformed, truncated, and read-error states are distinct from “no supported fields.” |
| Search/sort/page | Local synchronous view update | Preserve current scan and selected review items | Reset to first page; no server request. |
| Export review plan | User-initiated JSON download | List selected relative paths and candidate size separately from actual bytes freed (0 B); state that files are unchanged | No plan if selection is empty or scan is in progress; warn that paths can be sensitive. |
| Cancel/rescan | Stop is cooperative; a newer scan invalidates older results | Keep only results confirmed before cancellation; rescan clears transient state | Explain partial coverage; never present partial results as a complete scan. |

## Navigation, feedback, and privacy

- Document title: `Guardian Studio — AI image storage`.
- The page is a single route. The persistent header and folder/navigation rail adapt at narrow widths; the document remains vertically scrollable.
- Tables retain visible horizontal overflow at narrow widths rather than silently hiding comparison data.
- Prompt/workflow values are treated as potentially sensitive. They stay in page memory for the selected file only and appear only after explicit disclosure. No clipboard copy, URL, console output, local/session storage, telemetry, upload, or remote service is part of the flow.
- No delete/move/rename/overwrite action or write permission exists. Quarantine remains disabled; export is a human-review aid, not a deletion recommendation or proof of recoverable space.
- The synthetic demo and its embedded sample metadata are always labeled synthetic; they are not results from the user's files.

## Verification

- Unit tests: `tests/studio-metadata.test.mjs`, `tests/studio-scan.test.mjs`.
- HTTP safety tests: `tests/studio-server.test.mjs`.
- Browser checks: synthetic demo, real folder fixture, metadata disclosure, filters/sort/pages, empty/error/partial scan, keyboard focus, reduced motion, and narrow viewport.
- Package check: `npm run verify:package` and `npm pack --dry-run --json`.
- Architecture boundary: no OS-level writes until a separate FileProvider/quarantine contract and recovery tests are approved.
