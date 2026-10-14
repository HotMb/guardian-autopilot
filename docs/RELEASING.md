# Releasing Guardian Autopilot

The repository can produce a versioned npm package artifact, but normal pushes and version tags do not publish to npm. Publication is a separate, owner-controlled action.

## Build a release artifact

1. Update `version` in `package.json` and commit the change.
2. Push a matching version tag (`vX.Y.Z`), or start the `Release artifact` workflow manually.
3. The workflow installs from the lockfile, runs the complete test suite, creates the npm tarball, uploads it as a workflow artifact, and creates a signed GitHub artifact attestation.

The workflow also runs `npm run verify:package`. This read-only smoke test checks that the built `guardian` executable, matching plugin metadata, Claude hook, audit skill, and read-only MCP entry point will be included in the package.

The release workflow requires only repository read access plus the short-lived OIDC and attestation permissions used by GitHub Actions. It does not need an npm token.

## Build Guardian Studio for Windows

The desktop app is a separate Electron workspace. From a Windows checkout with Node.js 22.13+ and npm installed, run:

```powershell
npm ci
npm run desktop:make
```

The x64 Squirrel installer and its update package are written to `packages/desktop/out/make/squirrel.windows/x64/`. Running `npm run desktop` starts the app from source; installing the packaged app does not require Node.js. The `Guardian Studio desktop artifact` workflow builds the same unsigned x64 installer on pushes to `main` and `codex/**` and retains it as a downloadable workflow artifact for 14 days.

These artifacts are for testing. The Windows installer is unsigned, may show an unknown-publisher warning, and must not be presented as a trusted public release. Code signing, macOS/Linux installers, auto-updates, and public distribution remain separate release work. The desktop app keeps file access in the local Chromium renderer and uses the existing explicit permission and confirmation flow; its CLI-only folder watcher is not included.

## Manual npm publication

The package is now explicitly configured as a public package, but normal pushes and version tags still do not publish it. Publication is available only through the separate `Publish npm package` workflow:

1. Update `version` in `package.json`, run the tests, commit, and push the change.
2. Create and push the matching `v*` tag.
3. Configure npm trusted publishing for the public `guardian-autopilot` package and this exact `HotMb/guardian-autopilot` repository, workflow file, and `npm-release` environment.
4. Run `Publish npm package` from that tag, leave `confirm_publish` unchecked for a dry skipped run, or check it only when publication is intended.

The workflow requires the explicit confirmation, a `v*` tag, the `npm-release` environment, and the GitHub OIDC permission before it can reach `npm publish`. It uses no long-lived npm token. npm trusted publishing requires a current npm CLI and automatically creates provenance for supported public GitHub Actions releases; see the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
