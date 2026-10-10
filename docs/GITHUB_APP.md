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

The current server verifies and acknowledges signed deliveries only. The
library client in `src/github-installation.ts` can exchange an App JWT for an
installation token restricted to one repository and read-only permissions,
then return that repository's metadata. It checks the returned permissions and
repository scope, rejects redirects and applies a request timeout. Credentials
and remote error bodies are not returned to callers.

The client and its HTTP route are covered by local mocked API tests; a real
authenticated API call still requires the App private key and numerical
App/repository identifiers. The route is not triggered by webhooks. Repository
audit scheduling, installation persistence and account authorization remain
pending. Successful webhook deliveries do not prove these later features work.

## Read-only repository connection test

The server exposes `POST /github/repository` only when all seven
`GITHUB_*` variables in `.env.example` are configured. Set them in the hosting
dashboard, keeping the private key and `GITHUB_API_ACCESS_TOKEN` secret. The
App ID is on the App's General settings page; the installation ID is the number
in the installation settings URL; the repository ID is available from the
repository's API URL. Download a new private key from the App's **Private keys**
section and paste its PEM contents into the secret field. Render accepts
multiline environment values; escaped `\n` is also normalized by the server.

Use a unique random bearer token for `GITHUB_API_ACCESS_TOKEN`; never reuse the
Stripe Checkout token. After Render deploys, call the route with
`Authorization: Bearer <GITHUB_API_ACCESS_TOKEN>`. It returns only the
configured repository ID, full name, default branch and visibility. It does not
return the installation token or private key. The route cannot select a
different repository. Remove these GitHub API variables from Render to disable
the connection.

`src/github.ts` contains the corresponding raw-body `X-Hub-Signature-256` verifier, covered by GitHub's published test vector, plus a short-lived RS256 App JWT builder tested against an ephemeral key. The local webhook server exposes `POST /webhooks/github` when `GITHUB_WEBHOOK_SECRET` is configured; it verifies and acknowledges signed deliveries without executing repository changes. Runtime private keys and the registration-time webhook secret are still required through deployment secrets.

GitHub Apps should request the minimum permissions needed for their API and webhook behavior. See GitHub's [permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-github-apps/choosing-permissions-for-a-github-app) and [App registration parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters).
