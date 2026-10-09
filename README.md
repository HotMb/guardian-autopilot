# Guardian Autopilot (starter)

An agent-agnostic, local-first foundation for safe cleanup of AI-generated codebases and assets.

## Repository

The canonical public repository is [HotMb/guardian-autopilot](https://github.com/HotMb/guardian-autopilot). Clone it with:

```bash
git clone https://github.com/HotMb/guardian-autopilot.git
```

## Current working scope

- Read-only scanning of files in a selected local directory.
- SHA-256 exact duplicate detection for common image/video formats.
- Ignores `.git`, `node_modules`, common build folders, and symlinks.
- Hashes assets as a stream, so large files are not loaded entirely into memory.
- Stable JSON report to stdout with schema version, relative POSIX paths, and non-fatal read errors.
- The original `guardian` CLI remains conservative and asset-focused.
- The CleanCode packages under `packages/` now provide guarded TypeScript cleanup discovery, analysis, planning, isolated apply, verification, audit JSONL, and crash-safe receipts.

## Run

```bash
npm install
npm run build
node dist/cli.js scan /path/to/project
node dist/cli.js inventory /path/to/project
node dist/cli.js references /path/to/project
node dist/cli.js plan /path/to/project
npm exec guardian -- cleanup /path/to/project path/to/tracked-file.png
npm exec guardian -- cleanup /path/to/project --apply --check-json '{"command":"npm","args":["test"]}' path/to/tracked-file.png
npm exec guardian -- mcp
npm exec guardian -- preflight
npm exec guardian -- preflight --production
npm install --global guardian-autopilot
npm test
```

`npm test` compiles the project before running the tests. The scan remains read-only and returns exit code 1 for an invalid root or an unrecoverable root-level error.

`inventory` builds or updates `.guardian/index.json`. Asset hashes are reused when file size and modification time are unchanged; the regular `scan` command never writes this index.

`references` reports local asset references found in JS/TS literals, CSS `url(...)`, HTML/JSON/Markdown strings and local `public/` URLs. Dynamic template values and external URLs are intentionally not treated as certain references.

`plan` combines duplicate detection and reference evidence into explainable `review-only` candidates. It never deletes or changes files.

`plan` also runs Knip when the target project provides a `knip` executable. The adapter requests only JSON analysis of dependency, unlisted and unresolved issues; it never invokes Knip's fix mode. If Knip is unavailable, the report returns `status: "unavailable"` and the rest of the plan still works.

### CleanCode packages

Build and test the CleanCode implementation with:

```bash
npm run build:shared
npm run test:core
npm run test:cli
```

The package CLI is available after building `packages/cli`:

```bash
node packages/cli/dist/index.js discover /path/to/project
node packages/cli/dist/index.js analyze /path/to/project --format=json
node packages/cli/dist/index.js plan /path/to/project --format=json
node packages/cli/dist/index.js report /path/to/project --format=html --output cleancode-report.html
node packages/cli/dist/index.js apply /path/to/project --dry-run --candidates-file approved-candidates.json
node packages/cli/dist/index.js license activate --license-file license.key --public-key-file cleancode-public-key.pem --output .cleancode-license.key
node packages/cli/dist/index.js license status --license-file .cleancode-license.key --public-key-file cleancode-public-key.pem
node packages/cli/dist/index.js mcp
```

`apply --dry-run` never creates a worktree or writes the target repository. A real `apply` requires an explicit candidates file whose evidence contains positive proof, creates a backup branch and isolated worktree, runs build/typecheck/tests, writes an audit log, and commits only after every verification passes. Failed verification rolls back the isolated change. Verification commands can be supplied with `--verification-file`; no source code is uploaded.

`report` produces a compact read-only summary in JSON, Markdown (`md`) or HTML. It writes a file only when `--output` is explicitly provided.

The four packages are workspace-linked for development and have publishable package metadata. Publishing is still an explicit owner-controlled release action; no package is published automatically by the test or CI workflow.

Licences are Ed25519-signed and checked offline. `license activate` refuses an invalid or expired key and uses an exclusive output write when storage is requested; `license status` only reads the key and public key.

The CleanCode MCP adapter is read-only and exposes only `discover`, `analyze`, `plan` and `report`. Set `CLEANCODE_MCP_ROOT` to the permitted project root; destructive operations remain CLI-only.

`cleanup` accepts an explicit list of tracked files and produces a worktree diff by default. Passing `--apply` is required to apply the verified diff to the source repository. Use repeated `--check <executable>` or `--check-json '{"command":"npm","args":["test"]}'` to add checks; commands are executed without a shell, and post-apply checks and rollback remain enforced by the transaction API.

`mcp` starts a newline-delimited stdio adapter with the read-only tools `guardian_scan`, `guardian_references`, and `guardian_plan`. It restricts requested roots to `GUARDIAN_MCP_ROOT`, `CLAUDE_PROJECT_DIR`, or the current directory, in that order. Cleanup is intentionally not exposed through MCP yet.

### Stripe test billing

The local webhook server and Checkout route are opt-in. Copy `.env.example` to `.env`, fill in test-mode price ids and the signing secret from `stripe listen`, then run:

```bash
npm run start:webhook
```

It exposes `GET /healthz`, `POST /webhooks/stripe`, optional `POST /webhooks/github` when `GITHUB_WEBHOOK_SECRET` is configured, and — only when the Checkout variables plus `STRIPE_CHECKOUT_ACCESS_TOKEN` are configured — `POST /billing/checkout`. Checkout requests require `Authorization: Bearer <token>`; live keys are rejected by the local Checkout configuration. The HTTP boundary emits restrictive security headers, limits request bodies, and applies a bounded per-process rate limit. Browser calls require exact origins in `CORS_ORIGINS`; wildcard origins are rejected. By default the development server uses in-memory subscription state; set `STRIPE_SUBSCRIPTION_STORE_PATH` to an absolute path to persist subscriptions and webhook de-duplication across restarts.

For a provider-neutral container deployment, build the included `Dockerfile`. It binds to `0.0.0.0`, runs as the unprivileged `node` user, exposes `/healthz`, and can store single-instance local state in the mounted `/var/lib/guardian` volume. For horizontal scaling, set `DATABASE_URL` and use PostgreSQL instead. See [the deployment checklist](docs/DEPLOYMENT.md); public hosting and Stripe endpoint registration remain owner-controlled steps.

The final recommended topology is documented in [the production deployment runbook](docs/PRODUCTION-DEPLOYMENT.md), with a non-secret reference configuration in [`deploy/production.env.example`](deploy/production.env.example).

Before any public deployment, run `npm exec guardian -- preflight --production` and read the [security and launch gate](docs/SECURITY.md). The preflight is local-only and returns a non-zero status when it finds a blocking configuration. The recommended zero-cost test path is local execution plus Stripe CLI; a Cloudflare Quick Tunnel is acceptable only as a temporary development callback and is not production hosting.

To enable it in a target JavaScript/TypeScript project, install Knip there with `npm install --save-dev knip`. Guardian consumes Knip's machine-readable JSON reporter and uses `--no-exit-code`; it does not install packages or modify the target project.

The transactional cleanup API in `src/transaction.ts` requires a clean Git repository, accepts tracked regular files only, creates an isolated worktree, generates a binary-safe diff, runs optional checks without a shell, and removes the worktree afterward. Its default mode is dry-run; `dryRun: false` applies only the verified diff and rolls back the source repository if post-apply checks fail. Protected paths and failed checks are rolled back automatically.

Every push to `main` and every pull request runs the test suite on Node.js 20 and 22 through GitHub Actions.

### Optional configuration

Create `.guardian/config.json` inside the scanned project:

```json
{
  "version": 1,
  "protectedPaths": ["migrations", "src/secrets"],
  "ignoredPaths": ["fixtures"],
  "maxAssetBytes": 52428800
}
```

All configured paths must be relative to the project root. `.env*` files and common certificate/key extensions are protected by default. Protected paths are not modified by the current read-only scanner; they will be enforced by the future cleanup transaction.

### Claude Code plugin

The repository includes an optional Claude Code plugin under `integrations/claude-plugin`. It follows the current plugin layout with `.claude-plugin/plugin.json`, `hooks/hooks.json`, and a namespaced read-only audit skill. Validate and load it for one session with:

```bash
claude plugin validate ./integrations/claude-plugin
claude --plugin-dir ./integrations/claude-plugin
```

The `Stop` hook is debounced for five minutes per project, runs `guardian plan` only, and never performs cleanup. It does not create a permanent background process. The explicit skill is `/guardian-autopilot:audit`.

## Planned, not yet implemented

Policy engine, GitHub integration, paid cloud service, and team reporting. The local read-only MCP adapter is implemented; destructive cleanup remains behind the explicit CLI transaction path.

## Start here

- [Project brief](docs/PROJECT_BRIEF.md)
- [Architecture](docs/ARCHITECTURE.md)
- [MVP backlog](docs/BACKLOG.md)
- [Agent briefs](docs/agents/)
- [Monetization plan](docs/MONETIZATION.md)

## Safety

Never remove or rewrite assets from duplicate hashes alone. Do not run destructive actions on untracked or user-modified files. Future autonomous actions must be reversible, confined to the permitted repository, and verified in an isolated worktree.
