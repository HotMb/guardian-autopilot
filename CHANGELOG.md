# Changelog

## Unreleased

- Added the CleanCode shared contracts, guarded state machine, repository manifest, reference graph, policy engine, duplicate analysis, Knip adapter, planner, verifier, and isolated worktree executor.
- Added append-only JSONL audit events and compare-and-swap undo receipts for crash-safe cleanup recovery.
- Added CleanCode CLI commands for read-only discovery, analysis, planning, and guarded `apply --dry-run` / apply execution.
- Added read-only report rendering in JSON, Markdown, and HTML formats.
- Added offline Ed25519 license issue/verify primitives and CLI activation/status checks with expiration and tamper rejection.
- Added a separately namespaced CleanCode MCP stdio adapter with root containment and read-only tool annotations.
- Made the shared, core, license, and CLI packages npm-workspace aware with publishable metadata and package-boundary imports.
