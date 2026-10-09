# GitHub App permission contract

`integrations/github-app/permissions.json` is the least-privilege contract for a future Guardian GitHub App. It is intentionally a permission specification, not an installed App or a credential.

The proposed audit-only installation requests:

| Scope | Level | Purpose |
| --- | --- | --- |
| Contents | Read | Inspect repository files and the selected revision. |
| Metadata | Read | Identify repositories and installation context. |
| Pull requests | Read | Correlate audits with pull-request changes without commenting or merging. |
| Checks | Read | Observe existing CI results without creating or modifying checks. |

The subscribed events are installation lifecycle, push, and pull request changes. The contract requests no write permission and does not contain an App private key, webhook secret, client secret, or callback URL. Those values must be configured only when an owner has selected a deployment endpoint and registered the App.

## Free beta registration checklist

The free beta can use the temporary Render HTTPS URL; no domain or paid cloud
resource is required. Register the App only in the GitHub account that owns the
test repository, then use:

- Homepage URL: `https://guardian-autopilot.onrender.com`
- Webhook URL: `https://guardian-autopilot.onrender.com/webhooks/github`
- Repository permissions: Contents, Metadata, Pull requests and Checks — Read-only
- Events: Installation, Push and Pull request
- No organization permissions and no write permissions
- Disable user authorization/OAuth unless a later product decision requires it

Generate a webhook secret during registration and store the same value in
Render as `GITHUB_WEBHOOK_SECRET`. Do not commit it or send it through chat.
The Render Blueprint declares this variable as a non-synchronized secret.

The current server verifies and acknowledges signed deliveries only; it does
not yet install repositories, exchange installation tokens or run audits from
GitHub webhooks. Those operations remain a later implementation step and are
intentionally not implied by registering the App.

`src/github.ts` contains the corresponding raw-body `X-Hub-Signature-256` verifier, covered by GitHub's published test vector, plus a short-lived RS256 App JWT builder tested against an ephemeral key. The local webhook server exposes `POST /webhooks/github` when `GITHUB_WEBHOOK_SECRET` is configured; it verifies and acknowledges signed deliveries without executing repository changes. Runtime private keys and the registration-time webhook secret are still required through deployment secrets.

GitHub Apps should request the minimum permissions needed for their API and webhook behavior. See GitHub's [permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-github-apps/choosing-permissions-for-a-github-app) and [App registration parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters).
