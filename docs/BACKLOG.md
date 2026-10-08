# Initial backlog

## P0
- [x] Starter CLI: read-only exact duplicate scan
- [x] Build tests against fixture repositories; symlinks, permissions, large assets, exclusions
  - [x] Next.js fixture repository and regression matrix
  - [x] Symlink, large-asset, and generated-directory exclusion coverage
  - [x] Permission-denied coverage on POSIX CI runners; skipped where Windows permissions are not reliable
- [x] .guardian config schema and protected path policies
- [x] Inventory with incremental hashes and safe event coalescing
- [x] Reference resolver for JS/TS, CSS, public URL paths, Next.js conventions
- [x] Knip integration, candidate confidence and explainable evidence
- [x] Git worktree transaction with dry-run diff, checks, and rollback

## P1
- [x] Claude Code plugin manifest and hooks matching currently documented format
  - [x] Stop-hook smoke coverage for read-only output, debounce, and recursion guard
- [x] E2E React/Next.js fixture apps and regression test matrix
- [x] npm publishing and final release policy
  - [x] Tag/manual release artifact workflow with GitHub build attestation
  - [x] Read-only package content verification in the release workflow
  - [x] Release and future npm trusted-publishing documentation
  - [x] Manual tag-only npm workflow with explicit confirmation and OIDC
  - [x] Exact release-tag and package-version match check
  - [x] Node 24-compatible GitHub Actions majors

## P2
- [ ] Entitlements API and Stripe test mode
  - [x] Local plan and entitlement policy foundation
  - [x] Synthetic Stripe signature verification fixtures
  - [x] Fail-closed subscription event mapping
  - [x] Dependency-free signed webhook processor, retry deduplication, and persistence contract
  - [x] Local HTTP webhook boundary with bounded raw-body handling
  - [x] Test-only Checkout Session builder with plan metadata and live-key guard
  - [x] Test sandbox Pro and Team products with recurring price fixtures
  - [x] Durable local subscription store with restart-safe webhook de-duplication
  - [x] Provider-neutral container and healthcheck for hosted deployment
  - [ ] Hosted test-mode webhook endpoint and database-backed subscription persistence (requires deployment configuration)
- [ ] GitHub App installation and audit permissions
  - [x] Least-privilege read-only permission contract
  - [x] Raw-body webhook signature verification fixture
  - [x] Short-lived GitHub App JWT helper
  - [ ] App registration, webhook endpoint, and installation (requires deployment owner/configuration)
- [ ] Team reporting, telemetry consent and data retention
  - [x] Local opt-in anonymous telemetry contract
  - [x] Aggregation and bounded retention policy
  - [ ] Hosted storage, consent UI, deletion workflow, and team dashboard (requires product/deployment decisions)
- [x] Read-only MCP stdio adapter
  - [x] JSON-RPC error and unknown-request coverage
  - [x] Notification handling without response noise
  - [x] Oversized-message rejection and continued service
  - [x] Real-path containment against symlink escapes
  - [x] Empty resources and prompts capability responses
  - [x] Read-only and non-destructive tool annotations
