# Guardian Architecture (As Built)

**Status:** Current implementation record, 2026-10-15
**Product boundary:** Guardian ships two related local-first workflows. The supplied CleanCode documents describe the repository-cleanup workflow; they do not describe Guardian Studio's image-storage workflow.

## Product promise

### Guardian Studio — generated-image storage review

Studio helps creators inspect large local image collections, exact byte duplicates, heuristic visual candidates, and large files. Scanning is read-only. Users choose exact files and confirm a recoverable archive operation; restore and permanent purge are separate actions. Image contents are processed locally by the browser or desktop app.

Primary paths: src/scanner.ts, src/inventory.ts, src/studio.ts, site/studio-*.js, packages/desktop/.

### Guardian CleanCode — repository cleanup review

The CLI inventories JavaScript/TypeScript repositories, analyzes references, produces review-only plans, and tests explicitly selected cleanup candidates in an isolated Git worktree. A successful experiment is kept on a local review branch after required checks; failed checks roll back. It does not push or merge.

Primary paths: packages/shared/, packages/core/, packages/license/, packages/cli/.

## Runtime boundaries

| Layer | Implemented responsibility | Boundary evidence |
|---|---|---|
| Studio UI | Local image scan, comparison, metadata disclosure, archive/restore/purge review | tests/studio-scan.test.mjs, tests/studio-file-ops.test.mjs, tests/studio-ui.test.mjs |
| Desktop shell | Electron window around Studio with isolated renderer and restricted navigation | packages/desktop/main.mjs, tests/desktop-security-policy.test.mjs |
| Guardian CLI | Asset scan, inventory, references, Studio launch, webhook and MCP commands | Root package.json bin and src/ |
| CleanCode shared/license | Contracts and offline Ed25519 license primitives | packages/shared/, packages/license/ |
| CleanCode core | Discovery, reference analysis, policy, proof, worktree execution, verification, rollback, receipts | packages/core/ and its tests |
| CleanCode CLI | Discovery, planning, reports, guarded experiments, recovery, read-only MCP | packages/cli/ and its tests |
| Hosted boundary | Metadata-only GitHub integration and test-mode billing/webhook infrastructure | src/github*.ts, src/server.ts, src/postgres-subscriptions.ts |

The internal package dependency graph is checked by npm run verify:architecture. Behavioral properties remain covered by the unit and integration tests; package metadata alone is not treated as proof of safe runtime behavior.

## Safety invariants

- Studio scans do not change source files. Archive, restore, and purge require separate user actions and confirmations.
- Exact duplicates require matching SHA-256, size, and byte comparison. Visual similarity is a review hint, not proof.
- CleanCode plans are review-only. Deletion experiments are bounded, isolated, verified, and reversible.
- MCP exposes read-only discovery, analysis, planning, and reporting.
- GitHub source analysis stays local; hosted GitHub access returns configured metadata only.
- The hosted billing service is test-mode only. Guardian is still beta.

## Differences from the supplied CleanCode target

These are implementation choices, not claims that the proposed target stack has been fully delivered:

| Target document proposes | Repository implements | Status |
|---|---|---|
| pnpm + Turborepo workspaces | npm workspaces and package scripts | Deliberate divergence |
| Vitest | Node's built-in test runner | Deliberate divergence |
| Clipanion CLI | Existing Node CLI entrypoints | Deliberate divergence |
| ts-morph/tree-sitter graph | Bounded JS/TS reference analysis plus optional Knip adapter | Partial; supported language scope is intentionally limited |
| Hono + Drizzle + Paddle SaaS backend | Node HTTP boundary, PostgreSQL subscription adapter, Stripe test-mode helpers | Partial; no production SaaS billing |
| Repository-cleanup product only | Repository cleanup plus Guardian Studio image-storage review | Studio is an additional product surface |

The project does not currently claim the proposed multi-language analysis, hosted device enrollment, production licensing or payments, customer dashboard, scheduled hosted audits, or automated pull requests. Payment and licensing expansion remain deferred.

## Verification contract

Run:

- npm test — builds and tests the root application plus shared, license, core, and CLI packages; includes the architecture verifier.
- npm run verify:architecture — checks the expected workspace package set, allowed internal dependency edges, CLI entrypoints, private desktop isolation, and test wiring.
- npm run verify:package — checks publishable package contents and entrypoints.
- npm run verify:desktop — checks desktop security policy and bundled assets.
- npm run desktop:make — builds the Windows installer.

The architecture verifier protects package boundaries and wiring. It does not certify all behavior, prove runtime usage of user code, measure coverage, or imply production readiness. The repository currently defines no lint command, coverage threshold, or performance benchmark, so those acceptance dimensions remain unmeasured. Feature tests and manual release checks remain necessary.
