# Releasing Guardian Autopilot

The repository currently produces a versioned package artifact; it does not publish to npm automatically. This keeps a tag push from becoming an irreversible registry operation while the package API and ownership policy are still being finalized.

## Build a release artifact

1. Update `version` in `package.json` and commit the change.
2. Push a protected tag matching `v*.*.*`, or start the `Release artifact` workflow manually.
3. The workflow installs from the lockfile, runs the complete test suite, creates the npm tarball, uploads it as a workflow artifact, and creates a signed GitHub artifact attestation.

The workflow also runs `npm run verify:package`. This read-only smoke test checks that the built `guardian` executable, matching plugin metadata, Claude hook, audit skill, and read-only MCP entry point will be included in the package.

The release workflow requires only repository read access plus the short-lived OIDC and attestation permissions used by GitHub Actions. It does not need an npm token.

## Future npm publishing

Before enabling npm publication, make the package public deliberately, configure npm trusted publishing for this exact repository and workflow, and add an approval gate for release tags. npm's trusted-publishing flow uses OIDC and automatically creates npm provenance attestations; no long-lived npm token should be added to this repository.
