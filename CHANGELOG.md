# Changelog

## Unreleased

- Added the CleanCode shared contracts, guarded state machine, repository manifest, reference graph, policy engine, duplicate analysis, Knip adapter, planner, verifier, and isolated worktree executor.
- Added append-only JSONL audit events and compare-and-swap undo receipts for crash-safe cleanup recovery.
- Added CleanCode CLI commands for read-only discovery, analysis, planning, and guarded `apply --dry-run` / apply execution.
- Added read-only report rendering in JSON, Markdown, and HTML formats.
- Added offline Ed25519 license issue/verify primitives and CLI activation/status checks with expiration and tamper rejection.
- Added a separately namespaced CleanCode MCP stdio adapter with root containment and read-only tool annotations.
- Made the shared, core, license, and CLI packages npm-workspace aware with publishable metadata and package-boundary imports.
- Hardened the local webhook HTTP boundary with security headers, bounded rate limiting, and exact-origin CORS validation.
- Required a user-reviewed candidates file before any real CleanCode CLI cleanup; dry-run remains read-only.
- Validated candidate evidence types and confidence bounds before the cleanup policy runs.
- Protected tests, test directories and recognized project configuration from cleanup, as required by the verification policy.
- Added a JavaScript/TypeScript dynamic-usage hint scan for dynamic loading, DI markers, reflective containers and serialization annotations; hints are surfaced in plans and reports without authorizing deletion.
- Required a separate explicit approval flag before applying cleanup to more than 10 files, enforced in the core cleanup engine as well as the CLI.
- Rejected caller-asserted `positive_proof` evidence at policy and deletion boundaries; real CleanCode deletion stays fail-closed until a verified analyzer can issue in-process proof.
- Cross-referenced standard LCOV test reports: files with positively executed lines are excluded from cleanup candidates; zero coverage is explicitly not treated as proof of non-use.
