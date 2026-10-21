# Guardian Autopilot

Guardian is a local-first toolkit for inspecting repositories and testing bounded cleanup changes with explicit verification and human review.

## Capabilities

- Scan common image and video assets, calculate SHA-256 hashes, and report exact duplicates without modifying files.
- Review AI-image collections locally; optionally archive manually selected files with a verified recoverable copy and an explicit purge lifecycle.
- Build an asset inventory and resolve local references in JavaScript/TypeScript, CSS, HTML, Markdown, and public asset paths.
- Analyze JavaScript/TypeScript repositories, explain possible unused-file candidates, and produce read-only plans.
- Test selected cleanup candidates in an isolated local Git worktree. Required checks run before a successful experiment is kept for review.
- Analyze a GitHub checkout locally through GitHub CLI credentials; source files are not uploaded to Guardian.
- Expose read-only analysis through the MCP adapter and the optional Claude Code plugin.

## Requirements

- Node.js 20 or later for the CLI and running from source
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

Open the local Guardian Studio review interface:

```bash
npm run build
node dist/cli.js studio
```

Run the Guardian Studio desktop app from a source checkout on Windows with Node.js 22.13 or later:

```powershell
npm run desktop
```

Build the Windows installer with `npm run desktop:make`. The installer is currently unsigned; Windows may show an unknown-publisher warning. A signed installer and macOS/Linux packages are not available yet. Packaged desktop use does not require users to install Node.js. The desktop app currently supports the same browser-backed folder selection, scanning, archive, restore, and purge flows as Studio; its optional CLI folder watcher is not included in the desktop app.

To watch one local image-generation folder while Studio is open, pass its path explicitly:

```bash
node dist/cli.js studio --watch /path/to/generated-images
```

On PowerShell, quote paths that contain spaces:

```powershell
node dist/cli.js studio --watch "C:\Users\you\Pictures\ComfyUI"
```

For the browser version, open the printed `127.0.0.1` address in a supported Chromium-based desktop browser. Studio starts with clearly labeled synthetic data. Browser scanning requests read access only. The optional watcher reads metadata from its CLI-selected folder on the same computer and shows new/changed files plus images of at least 10 MiB. This is a human review queue, not automatic cleanup; the watcher never moves or deletes a file. The compatibility folder picker remains read-only. The archive workflow asks for source write permission only after you select files and choose **Archive selection**. Guardian creates a managed `Corbeille` inside the selected folder; it does not ask you to choose another archive folder.

Archive is never automatic: select up to 20 files and review every exact path and size shown inline. Guardian copies in 1 MiB chunks to `Corbeille/.guardian-quarantine`, verifies byte equality and a streaming SHA-256, records the operation, then removes the source entry. Failed/cancelled copies keep the source. Restore stops when the target already exists at its preflight check and retains the verified archive copy; a failed write may leave a partial target that must be inspected before retrying. Permanent deletion is a separate inline action: review the paths and sizes, check the acknowledgement, then choose **Delete permanently**. Guardian verifies each stored file before deletion. The local archive journal contains sensitive relative paths and stays in the selected folder; it is not uploaded. Guardian reports only verified bytes moved into or deleted from Corbeille, never operating-system free space. Archived copies remain on the device until permanently deleted.

The watcher monitors one folder per Guardian process; restarting it resets the new-file baseline. It reconciles the folder every 60 seconds to recover missed events and may report partial coverage at its entry cap. The browser does not provide a portable atomic no-replace guarantee against another program editing the selected folders during an operation. Keep those folders unchanged and do not run concurrent Guardian instances while archiving or restoring; maintain an independent backup for valuable data. For a selected PNG, Studio can reveal supported Stable Diffusion WebUI `parameters` and ComfyUI `prompt`/`workflow` text after an explicit disclosure. This is bounded PNG text-chunk support, not general EXIF or JPEG/WebP metadata support. Duplicate candidates are hashed and then byte-compared; large files and incomplete scans are called out.

The scan command does not change the target project. The inventory command is the exception: it writes or updates `.guardian/index.json` to cache asset hashes.

## CleanCode CLI

Build the CleanCode workspace CLI:

```bash
npm run build:cli
node packages/cli/dist/index.js analyze /path/to/project --format=json
node packages/cli/dist/index.js plan /path/to/project --format=json
node packages/cli/dist/index.js report /path/to/project --format=html --output report.html
```

Reports show analysis-phase progress on stderr. The analysis phase has a 30-second default timeout; set `--timeout-ms` from 1000 to 600000 for larger projects. Rendering and output are outside that timeout. If analysis times out, no report is written. `--output` writes to the exact path you provide (and may replace an existing file), so choose a path outside the target repository when you want its working tree unchanged. `apply` returns its local review branch in JSON and text output; inspect that branch before merging. Guardian does not push or merge it.

Run the read-only validation report before reviewing a repository:

```bash
node packages/cli/dist/index.js validate /path/to/project --format=json
```

Validation starts no child process or project command. Its report lists the effective ignored-path patterns, candidate count, safety flags, Git metadata, and `gitStatus: not_checked`. The full `plan` command may invoke Knip and Git for analysis. Incomplete discovery returns `status: blocked` and no candidates; `ready_for_review` only means a person can inspect the candidates and does not authorize an experiment or apply.

Plans are review-only by default. A positive unreachable-file proof is available only through the opt-in, closed-world `node-application-v1` profile; missing imports, duplicate hashes, coverage gaps, and passing tests do not create proof. The proof is conditional on the declared roots and the supported tracked snapshot, not a guarantee against external consumers or infrastructure-injected runtime configuration. See [the proof profile and its limits](docs/closed-world-proof.md).

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
