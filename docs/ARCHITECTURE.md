# Technical architecture

## Layers
- Integrations: CLI first; Claude Code hooks; later MCP and GitHub App.
- Local core: repository discovery, file manifest, reference graph, exact duplicate hashing, Knip adapter, policy engine.
- Execution: candidate planner -> sandbox/worktree -> bounded changes -> build/typecheck/tests -> acceptance criteria -> patch or rollback.
- SaaS later: auth, organizations, entitlements, Stripe webhooks, scheduled GitHub audits, aggregated metadata reports.

## Execution states
DISCOVERED -> ANALYZED -> PLANNED -> ISOLATED -> APPLIED -> VERIFIED -> COMMITTED; failures -> REVERTED, ambiguous -> SKIPPED.

## Must-have safeguards
- No deletion based solely on a negative import search or duplicate hash.
- Don't follow symlinks or traverse outside configured root.
- No writes to user worktree without explicit configuration; all automatic updates in isolated Git worktrees.
- Skip dirty/untracked paths and protected patterns; don't modify `.env*`, key material, databases, migrations or generated lockfiles blindly.
- Tests/build are necessary but insufficient evidence; require conservative rules and audit log.
- No upload of proprietary source by default; telemetry opt-in.

## Cloud data model (future)
users, organizations, memberships, subscriptions, entitlements, repositories, audit_runs, cleanup_actions, usage_events.

## API (future)
POST /auth/device; POST /billing/checkout; POST /webhooks/stripe; GET /license; POST /audits; GET /audits/:id.

## Plugins
Claude Code plugin wraps CLI commands; plugin not sole source of business logic. MCP exposes audit/plan/report with destructive actions requiring policy approval and reversible execution.
