# CleanCode GitHub App audits

CleanCode can receive a signed GitHub `push` delivery, analyze that exact commit snapshot, and publish a Markdown report as a GitHub Check Run. This hosted audit is read-only with respect to repository files: it never runs scripts from the repository, edits files, commits, or merges. It uses the CleanCode core with external tools disabled; results are advisory and deletion readiness stays blocked unless a separate workflow proves its own requirements.

## Permissions and events

Configure the GitHub App with only:

| Permission | Level | Use |
| --- | --- | --- |
| Contents | Read-only | Download the repository snapshot at the pushed commit. |
| Metadata | Read-only | Confirm repository and installation identity. |
| Checks | Read and write | Create and complete the `CleanCode audit` Check Run containing the report. |

Subscribe to `Push` and `Installation`. The webhook secret must be configured in the App and copied to the host as `GITHUB_WEBHOOK_SECRET`. After changing requested permissions, approve the permissions update for the existing installation in GitHub.

The App private key comes from **Developer settings → GitHub Apps → Guardian Autopilot Beta → Credentials → Key pairs → Generate a private key**. A **Client secret** is an OAuth credential and is not the App private key. Keep the downloaded PEM private key only in Render's secret environment variable `GITHUB_APP_PRIVATE_KEY`.

## Hosting configuration

Automatic audits require all four variables below. `DATABASE_URL` is required because GitHub deliveries are acknowledged only after durable queue insertion.

- `GITHUB_APP_ID`: numeric App ID from the App's General page.
- `GITHUB_APP_PRIVATE_KEY`: PEM from Key pairs, not a Client secret.
- `GITHUB_WEBHOOK_SECRET`: the webhook secret created in App settings.
- `DATABASE_URL`: PostgreSQL connection string.

`DATABASE_MAX_CONNECTIONS` is the service budget. The audit queue reserves one connection; subscription storage uses the remaining configured connections. The Render template defaults this to three. Do not reduce it below two while both PostgreSQL features are enabled.

Set the App webhook URL to `https://<service-host>/webhooks/github`. Install or update the App on the repository. For a push, the server verifies the raw-body HMAC signature, validates repository, installation, branch and commit identifiers, and stores only commit metadata in PostgreSQL. It queues every commit SHA in the signed push payload, including the pushed head if GitHub did not include it in the commit list. A single push is limited to 20 commits to bound archive downloads, Check Run API calls, and queue growth; larger pushes are rejected whole with HTTP `422` and no partial jobs, so split them into smaller pushes. A serial worker downloads each commit tarball, verifies GitHub's archive redirect host and path, enforces compressed/expanded/file-count limits, extracts to a temporary directory, calls `planRepository(..., {runExternalTools:false})`, and removes the temporary directory in a `finally` block. Each completed report is published to a Check Run for its exact SHA.

Ignored events (including tags and branch deletion) are acknowledged without a job. Duplicate commits are deduplicated by repository and SHA. Completed queue metadata is retained for up to 30 days; source archives and report contents are not stored in PostgreSQL. A failed queue insertion returns `503` so GitHub can retry; jobs already inserted are safe to deduplicate on retry. Worker failures are retried up to three times, then the queue records a generic error code; provider details and source text are not logged.

## Analysis boundaries

- The hosted scan has hard archive, file-count and byte limits. Unsupported archive entries fail closed and produce a blocked Check Run.
- Hosted mode does not invoke Knip, Git, package managers, build tools, tests, or any repository-defined command. A report can therefore contain candidates for human review but cannot certify every external/runtime reference.
- The app has no `Contents: write` permission. It cannot delete files or push a cleanup branch. After reviewing a report, use the local CLI or the separately invoked GitHub Actions review experiment described in the [README](../README.md#review-a-cleanup-on-github-actions).
- This beta does not run an independent queue worker service. The web process polls the durable queue; cold starts and free-tier sleep may delay reports. Check GitHub's delivery page and Render logs when a Check Run does not appear.

## Manual verification

1. In GitHub App settings, confirm Contents: Read-only, Metadata: Read-only, Checks: Read and write, plus Push and Installation events.
2. In the App's installation settings, approve the permission update and confirm the intended repository is selected.
3. In Render, confirm the four required variables above are present. Do not paste their values into chat or commit them.
4. Wait for the new service version to deploy, then use **GitHub App → Advanced → Recent Deliveries → Redeliver** on a `push` delivery, or push one or more harmless commits to the test repository (no more than 20 per push).
5. Confirm a successful delivery response (`202` for queued commit reports), then open each pushed commit's **Checks** tab and find `CleanCode audit`.
6. Confirm the report says hosted analysis did not execute scripts and does not claim deletion readiness. Review Render logs for generic queue errors only.

The local mocked API, webhook, queue, worker, archive and report tests cover the application boundary. Verify a successful GitHub delivery and Check Run for each installation.
