# CleanCode behavior contract

**Status:** Implemented behavior, 2026-10-21. CLI and core tests cover the validation report and discovery gates described here. These checks report what Guardian observed in the local checkout; they do not prove universal non-use.

## Purpose and boundary

CleanCode helps a developer inspect a supported JavaScript/TypeScript repository, review possible cleanup candidates, and separately test an explicitly selected change. It does not establish universal non-use. Any unreachable-file proof remains conditional on the configured analyzer, declared runtime roots, supported repository snapshot, and documented limits in [closed-world proof](closed-world-proof.md).

This contract covers CleanCode only. Guardian Studio's image scan, archive, restore, and purge behavior is separate. Payment, checkout, subscriptions, licensing sales, and customer fulfillment are outside this work and are not acceptance criteria.

## Stages and allowed transitions

| Stage | Purpose | Side effects | Required result |
|---|---|---|---|
| `validate` | Inventory the requested repository, analyze supported local references, and summarize possible candidates. | Read-only. No Git, Knip, package-manager, or project commands run. | Text or JSON report with `status`, `discovery.status`, candidate count, evidence counts, safety flags, Git metadata, and effective ignored-path patterns. |
| `discover` | Enumerate supported in-scope files and record exclusions/errors. | Read-only. | Complete inventory or explicit incomplete result. |
| `analyze` / `plan` | Build references and evidence, then render review candidates and blockers. | Read-only with respect to the target. `plan` may invoke Knip and Git for external analysis. | Candidates are informational; they do not authorize a change. |
| Human review | Inspect each candidate, runtime roots, external consumers, configuration, and limitations. | No target mutation. Review files, if created, are separate inputs. | Explicit selection and required confirmations for any experiment. |
| `experiment` | Test only explicitly selected files in a disposable Git worktree and run the configured checks. | Creates/removes a worktree and runs project commands. | Keep a local review branch only when the experiment succeeds; otherwise roll back. Never push or merge. |
| `apply` | Apply a separately approved, eligible change under its own proof and verification gates. | Can change the source repository. | Must require its own explicit inputs and confirmations; never follow automatically from validation, planning, or experiment. |

The separate commands provide inspection and review stages: use `validate` for the no-external-tools report, or `plan` / `report` for the full read-only analysis; then review the candidates before an experiment. `apply` is a separate, explicit path with its own safeguards. A successful validation or experiment does not grant permission to apply.

## Validation contract

`validate <path> [--format=text|json]` is an inspection command, not a cleanup command. It:

- inspects only the requested repository and its supported configuration;
- returns text by default or a JSON report with `schemaVersion`, `command`, `status`, `repository`, `discovery`, `candidates`, `blockers`, `evidence`, `safety`, and `ignoredPaths` (`null` when the effective list could not be confirmed);
- uses `discovery.status` values `not_run`, `complete`, and `partial`, with inspected-file count and path-specific errors;
- reports `repository.gitMetadata` as `available` or `missing`, and always reports `repository.gitStatus: not_checked`; it does not run Git to inspect the working tree;
- reports `safety.readOnly`, `safety.externalTools`, `safety.projectCommandsExecuted`, `safety.targetFilesWritten`, and `safety.executionAuthorized`;
- uses the effective ignored-path patterns: the defaults plus the repository's configured `ignoredPaths`, deduplicated and sorted;
- does not write to the target or invoke Git, Knip, package managers, shell, or target-project commands. It skips Knip and closed-world analysis;
- does not treat validation as proof that a candidate is unused or safe to delete.

The report status meanings are:

- `blocked`: the root is invalid or an analysis/discovery error prevents a candidate claim. A partial discovery is reported as `discovery.status: partial`; candidate count is zero.
- `review_only`: discovery completed and no candidates were returned. This is an informational result, not proof that no cleanup opportunities exist.
- `ready_for_review`: discovery completed and candidates are available for human review. This never means safety is proven or execution is authorized.

Configured ignores are scope exclusions, not discovery errors. The `ignoredPaths` list shows the effective patterns, including the default ignored directories. Symlinks are never followed; because they may hide runtime references, every encountered non-ignored symlink is a discovery error and causes a partial plan with no candidates. Full `report` output carries `repositoryDiscovery.status`, path-specific errors, and whether dynamic-hint scanning completed or was skipped. Closed-world proof has additional, stricter coverage blockers described in [closed-world proof](closed-world-proof.md).

## Incomplete-discovery stop rule

If directory traversal or reference-graph discovery returns an error, the plan records `discoveryStatus: partial` and path-specific `discoveryErrors`; it returns no candidates and skips Knip and closed-world analysis. If the root, configuration, manifest, or discovery metadata cannot be inspected or validated, `validate` reports `status: blocked` and no candidates. For traversal errors it reports `discovery.status: partial`; when analysis cannot start or return valid metadata, it reports `not_run`. `experiment --from-plan` rejects incomplete or malformed discovery metadata before selecting candidates or starting an experiment. CleanCode does not infer that absence of a reference is evidence.

An empty candidate list is not a substitute for an incomplete status: the report distinguishes `review_only` with complete discovery from `blocked` with partial discovery.

## Experiment and apply are separate safety boundaries

An experiment evaluates a selected change in a local Git worktree. A Git worktree is **not** an operating-system security sandbox. Build, test, preparation, and other configured project commands run with the user's account permissions and may access the network, other files, or services available to that account. The operator must inspect commands before running them, especially on an unfamiliar project. A non-Git directory can be inspected by `validate`, but cannot support a Git-backed experiment.

The experiment must not push or merge. A passing build, typecheck, or test suite is useful evidence about that snapshot; it does not prove universal non-use or approve a source-repository mutation. `apply` remains a separate operation that requires its own explicit candidate selection, proof/policy checks, clean-state requirements, verification configuration, and per-run confirmation as applicable.

## Evidence and limits

Validation tests cover read-only output, no target-local Knip invocation, unchanged target files and Git status, non-Git inspection, blocked invalid paths, format validation, and JSON/text disclosure of effective ignored paths. Planner tests cover partial discovery with no candidates, skipped external analysis, and sorted default plus configured ignored-path patterns. `validation.test.mjs` covers the incomplete/malformed discovery metadata guard used by `experiment --from-plan`. The report does not inspect Git working-tree status; a Git-backed experiment performs its own prerequisites. Closed-world proof remains narrower than validation and is not universal proof of non-use.

Payments, checkout, subscriptions, and production readiness are outside this contract.
