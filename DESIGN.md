---
version: alpha
name: Guardian Studio
description: A quiet, local-first workbench for reviewing generated-image storage. Scans are read-only; archive, restore, and purge require separate user confirmation.
colors:
  forest: "#20372d"
  lime: "#c6f36a"
  paper: "#f3f2ed"
  surface: "#fbfaf7"
  ink: "#17201d"
  muted: "#5c6661"
  line: "#d4d5cd"
typography:
  display:
    fontFamily: "'Arial Black', Arial, Helvetica, sans-serif"
  sans:
    fontFamily: "Arial, Helvetica, sans-serif"
  mono:
    fontFamily: "ui-monospace, 'Cascadia Code', 'Segoe UI Mono', monospace"
rounded:
  control: "3px"
  panel: "3px"
  badge: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "28px"
components:
  primary-action:
    background: "colors.lime"
    foreground: "colors.ink"
  panel:
    background: "colors.surface"
    border: "colors.line"
  selected-row:
    background: "#eef4e6"
omitted:
  - section: elevation
    reason: "The selected Storage Triage direction uses tonal surfaces and fine borders; shadows are not needed."
---

# Guardian Studio Design System

## Overview

### Creative North Star

A quiet archive desk for creators: a calm paper workspace, a readable file list, and a clear lime marker for human review. Studio stays focused on finding and comparing local image files.

### Product context and register

- **Audience and primary job:** Creators who keep AI-generated image collections locally; understand storage consumption, then review exact duplicates and visual-variant candidates without handing file access to a cloud service.
- **Target market(s) and evidence:** Individual desktop creators; selected Studio brief and the Storage Triage reference mock.
- **Locale(s) and language policy:** English for this MVP, matching the selected mock and existing Guardian site. No locale switching is implemented.
- **Usage scene:** Desktop browser on the creator's own machine, often with many image files and a need to compare previews and paths.
- **Register:** Product utility. The existing Guardian wordmark and palette are retained.
- **Memorable signature:** Storage totals stay separate from operating-system free space. Large previews, visible file paths, and a lime selection state support human review before a verified archive.
- **Restraint:** No automatic cleanup, probability/percent similarity score, cloud account, or decorative dashboard metric. Visual groups are low-resolution heuristic candidates only. Permanent purge remains separate from recoverable archive. Never claim or infer operating-system free space from file byte counts.
- **Anti-references:** Generic SaaS gradient dashboards, image galleries that conceal file paths, and any claim that the perceptual-hash hint performs semantic or AI similarity analysis.
- **Token ownership/runtime mapping:** site/styles.css owns shared brand colors; site/studio.css owns Studio type and local contrast tokens. DESIGN.md records those values and the responsive geometry. No token generator is used.

## Colors

The canonical values come from `site/styles.css`: paper `#f3f2ed`, surface `#fbfaf7`, ink `#17201d`, muted text `#5c6661`, border `#d4d5cd`, forest `#20372d`, and lime `#c6f36a`. Paper is the application canvas; surface is for the file table and inspector; forest anchors the brand; lime is reserved for selected review items and the single primary action. Status always includes text, never color alone. The MVP is light theme only; high-contrast and forced-colors behavior must preserve system outlines and text.

## Typography

Use the system UI font stack for headings and body copy, plus system monospace for paths and file metadata. Body text starts at 12px; key copy is 14px or larger. Keep paths readable by wrapping them, never through hover-only disclosure.

## Layout

Use a three-part desktop layout: collection navigation, a flexible sortable file list, and a selected-file inspector. Below 1180px, move the inspector beneath the list. At intermediate widths, show summary metrics in a 2x2 grid. Below 960px, stack the workspace. At narrow widths, keep navigation labeled and scrollable. Tables may scroll horizontally; the page remains naturally scrollable. Preserve image aspect ratios.

## Accessibility and scale

- Use visible focus, semantic controls, keyboard operation, and live scan status.
- Make important controls at least 44px high. Keep text at 12px or larger.
- At 200% zoom, let the page reflow; only the image table may scroll horizontally.
- Respect reduced motion and preserve borders, focus, and text in forced-colors mode.
- Keep archive confirmation, restore, and permanent purge distinct.
## Shapes

Use square, fine-bordered panels and 3px control corners, with pill badges only for short status labels. Avoid floating-card stacks and ornamental shadows.

## Components

### Foundational visual states

Hover and focus use clear contrast; focus-visible retains a high-contrast browser outline. Selected rows use the pale green tint and a text/checkbox state. Disabled controls are visibly disabled and explain why. Scan progress is determinate only when the file count is known; otherwise show a labeled indeterminate state. Reduced motion removes nonessential transitions.

### Buttons and actions

Primary is lime with dark text; secondary is paper/surface with a fine border. Reversible archive uses a warning/outline treatment; permanent purge uses a visually distinct danger treatment only in its final confirmation. The review plan remains informational.

### Navigation and data display

Use labeled navigation, real buttons for sorting and filters, and semantic tables. The review-plan badge counts manually selected files. Label exact byte matches and visual candidates separately; neither count means files were removed. Folder sizes are image bytes only and state that scope.

### Forms and overlays

Use a user-activated browser directory picker in read-only mode, with a multiple-file directory input fallback. Request source write access only after a separate user click; the fallback remains read-only. Search is local and has an explicit clear button. Use app-owned dialogs for exact archive review, restore confirmation, and typed irreversible purge. Keep review plans in memory for the current tab only; persist only the explicit local archive journal and its data in the user-chosen folder.

### Iconography

Reuse the existing Guardian mark. Use descriptive text labels for controls; the current repository has no maintained icon library, so do not introduce hand-drawn icons.

### Motion

Motion is limited to brief hover and selected-state feedback. Respect `prefers-reduced-motion`.

### Content and data visualization

Use plain language: “Exact duplicate” means identical file bytes. “Visual candidate” means a low-resolution perceptual-hash pattern fell within the review threshold; it is a heuristic, not proof that images are interchangeable. “Candidate size” is not recovered storage; Guardian does not measure operating-system free space. Report only verified source/archive bytes changed by the explicit operation. Explain that same-volume archive does not reduce total device storage until purge. Never expose embedded prompts until the user explicitly opens the metadata disclosure.

## Do's and Don'ts

- **Do:** Keep file access in the browser after the user deliberately selects one folder.
- **Do:** Make every candidate a human review choice and say nothing was modified.
- **Do:** Label perceptual groups as heuristic visual candidates and make image previews and paths available for comparison.
- **Don't:** Imply semantic/AI similarity, generation provenance, or actual recovery without evidence.
- **Don't:** Use the first sorted path as an automatic decision about which file is valuable.
