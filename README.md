# Guardian Autopilot

Guardian is a local-first toolkit for inspecting repositories and testing bounded cleanup changes with explicit verification and human review.

## Capabilities

- Scan common image and video assets, calculate SHA-256 hashes, and report exact duplicates without modifying files.
- Build an asset inventory and resolve local references in JavaScript/TypeScript, CSS, HTML, Markdown, and public asset paths.
- Analyze JavaScript/TypeScript repositories, explain possible unused-file candidates, and produce read-only plans.
- Test selected cleanup candidates in an isolated local Git worktree. Required checks run before a successful experiment is kept for review.
- Analyze a GitHub checkout locally through GitHub CLI credentials; source files are not uploaded to Guardian.
- Expose read-only analysis through the MCP adapter and the optional Claude Code plugin.

## Requirements

- Node.js 20 or later
- npm
- Git for worktree-based cleanup and GitHub checkout analysis

## Quick start

```bash
git clone https://github.com/HotMb/guardian-autopilot.git
cd guardian-autopilot
npm ci
npm run build
npm test
```

Run the original asset scanner and read-only planners against a local project:

```bash
node dist/cli.js scan /path/to/project
node dist/cli.js references /path/to/project
node dist/cli.js plan /path/to/project
```

The scan command does not change the target project. The inventory command is the exception: it writes or updates `.guardian/index.json` to cache asset hashes.

## CleanCode CLI

Build the CleanCode workspace CLI:

```bash
npm run build:cli
node packages/cli/dist/index.js analyze /path/to/project --format=json
node packages/cli/dist/index.js plan /path/to/project --format=json
node packages/cli/dist/index.js report /path/to/project --format=html --output report.html
```

Plans are review-only. Guardian does not treat a missing import, a duplicate hash, or a passing test suite as proof that a file is unused. Real CleanCode deletion remains blocked until the engine can produce its own verified positive-use evidence.

### GitHub commit reports (hosted beta)

The optional GitHub App can analyze each pushed commit and attach a `CleanCode audit` report to its Checks tab. Hosted analysis uses an ephemeral snapshot, runs no repository scripts, and has bounded archive limits. It reports review candidates; it does not delete, commit, or merge project code. Configure the App and host using the [GitHub audit setup guide](docs/GITHUB_APP.md). This hosted capability is in beta and still needs a live delivery check in the owner's GitHub installation.

The conservative string-reference scan reads PHP and PHTML files for literal references such as WordPress enqueue and include paths. This does not parse PHP or prove framework behavior; dynamic paths and external plugins still require review. Common WordPress template-hierarchy files are protected from cleanup.

Before Guardian automatically selects candidates for a batch experiment, create a human-review checklist outside the project repository:

```bash
node packages/cli/dist/index.js review /path/to/project --path src/unused-module.ts --output /tmp/guardian-review.json
```

The plan may display blocked paths for transparency, but Guardian refuses to create a human-review checklist for paths protected by built-in or repository-defined safeguards (including tests and project configuration).

Inspect the project’s runtime, package, framework, CLI, plugin, and deployment entrypoints, and check for external consumers or runtime configuration that may load the candidate. Only then set `allEntrypointsReviewed` and `noExternalUsageConfirmed` to `true` for that candidate in the JSON file. The checklist is tied to the current Git commit and candidate file hash; edits make it stale. Keep it outside the repository so the checkout stays clean.

Run a batch experiment only with the completed checklist and a verification file:

```bash
node packages/cli/dist/index.js experiment /path/to/project --from-plan --review-file /tmp/guardian-review.json --verification-file checks.json
```

These are human confirmations, not engine-verified proof. They only permit a reversible local experiment; they never authorize `apply`, push, or merge. Dynamic-loading hints and other automated safeguards still block automatic selection.

To evaluate a reviewed candidate safely, use `experiment` with an explicit verification file containing the target project's build, typecheck, and test commands:

```bash
node packages/cli/dist/index.js experiment /path/to/project --path src/unused-module.ts --verification-file checks.json
```

If dependencies are not installed, a verification file may declare an optional preparation phase:

```json
{
  "prepare": [{"command": "npm", "args": ["ci"], "timeoutMs": 600000}],
  "build": {"command": "npm", "args": ["run", "build"]},
  "typecheck": {"command": "npm", "args": ["run", "typecheck"]},
  "test": {"command": "npm", "args": ["test"]}
}
```

Review every preparation command, then explicitly enable it with `--allow-preparation`. Guardian runs it in the disposable worktree, with no command shell and a maximum total timeout of ten minutes, before the configured checks. This is not an OS security sandbox: package lifecycle scripts and other project commands can use your account permissions, access the network, or affect files outside the worktree. Only enable setup for a project you trust. A successful review branch can contain only the requested deletions; any other tracked or untracked changes cause rollback. Ignored dependency/build output stays in the temporary worktree and is removed afterward.

An experiment requires a clean Git checkout and operates in a new local review branch. It never changes the source branch or pushes to GitHub. Build and test commands also run with your user permissions; inspect them before running an experiment on an unfamiliar project. Passing checks are useful evidence, not a guarantee that no external or untested use exists.

The separate `guardian cleanup` command accepts explicitly named tracked files and previews a worktree diff by default. Its `--apply` option is required to apply a verified diff to the source repository.

## Safety and privacy

- Analysis and cleanup run on the user's computer. Guardian's hosted GitHub integration reads configured repository metadata only; it does not scan source code or create commits, pushes, or pull requests.
- Cleanup paths must be tracked regular files in a clean repository. Built-in and repository-configured protected paths are refused at the execution boundary.
- Cleanup experiments are bounded, isolated, verified, and rolled back on failure.
- The MCP adapter is read-only. Destructive operations are not exposed through MCP.
- The optional hosted billing service is test-mode only; real payments and customer fulfillment are not enabled.

Read the [security and launch checklist](docs/SECURITY.md) before connecting services or deploying publicly.

## Repository configuration

An optional `.guardian/config.json` can define `protectedPaths` and `ignoredPaths` relative to the project root. Protected files remain visible in plans but are ineligible for cleanup; ignored paths are excluded from the manifest. Invalid or unsafe configuration blocks planning and execution.

```json
{
  "version": 1,
  "protectedPaths": ["migrations", "src/secrets"],
  "ignoredPaths": ["fixtures"]
}
```

## Development

```bash
npm run build
npm test
npm run verify:package
```

The test suite covers the root CLI and the shared, license, core, and CLI packages. CI runs the project tests on supported Node.js versions. Package publication is a separate, owner-controlled release action.

## Project status

Guardian is in beta. Hosted source audits, scheduled GitHub scans, automated pull requests, a customer dashboard, and live Stripe billing are not implemented. The free deployment configuration is for testing and does not provide production availability or DDoS protection.

## Documentation

- [Security and launch checklist](docs/SECURITY.md)
- [Development backlog](docs/BACKLOG.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Free beta deployment](docs/FREE-BETA-DEPLOYMENT.md)
- [Production deployment requirements](docs/PRODUCTION-DEPLOYMENT.md)
- [Test billing setup](docs/BILLING.md)
- [GitHub App setup](docs/GITHUB_APP.md)
- [Telemetry and retention](docs/TELEMETRY.md)
- [Release process](docs/RELEASING.md)

The optional [Claude Code integration](integrations/claude-plugin/README.md) provides a debounced, read-only audit hook.
