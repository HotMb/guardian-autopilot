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
- **No automatic deletion yet.** Identical files may still be referenced under different names.

## Run

```bash
npm install
npm run build
node dist/cli.js scan /path/to/project
node dist/cli.js inventory /path/to/project
node dist/cli.js references /path/to/project
node dist/cli.js plan /path/to/project
npm test
```

`npm test` compiles the project before running the tests. The scan remains read-only and returns exit code 1 for an invalid root or an unrecoverable root-level error.

`inventory` builds or updates `.guardian/index.json`. Asset hashes are reused when file size and modification time are unchanged; the regular `scan` command never writes this index.

`references` reports local asset references found in JS/TS literals, CSS `url(...)`, HTML/JSON/Markdown strings and local `public/` URLs. Dynamic template values and external URLs are intentionally not treated as certain references.

`plan` combines duplicate detection and reference evidence into explainable `review-only` candidates. It never deletes or changes files.

`plan` also runs Knip when the target project provides a `knip` executable. The adapter requests only JSON analysis of dependency, unlisted and unresolved issues; it never invokes Knip's fix mode. If Knip is unavailable, the report returns `status: "unavailable"` and the rest of the plan still works.

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

Policy engine, automatic reversible cleanup, MCP adapter, GitHub integration, paid cloud service.

## Start here

- [Project brief](docs/PROJECT_BRIEF.md)
- [Architecture](docs/ARCHITECTURE.md)
- [MVP backlog](docs/BACKLOG.md)
- [Agent briefs](docs/agents/)
- [Monetization plan](docs/MONETIZATION.md)

## Safety

Never remove or rewrite assets from duplicate hashes alone. Do not run destructive actions on untracked or user-modified files. Future autonomous actions must be reversible, confined to the permitted repository, and verified in an isolated worktree.
