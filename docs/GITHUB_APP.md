# GitHub App permission contract

`integrations/github-app/permissions.json` documents the least-privilege permissions for Guardian's optional GitHub integration. It is a permission contract, not a credential. The hosted integration currently verifies and acknowledges signed webhook deliveries and can return configured repository metadata; it does not scan source code or trigger audits.

The proposed audit-only installation requests:

| Scope | Level | Purpose |
| --- | --- | --- |
| Contents | Read | Inspect repository files and the selected revision. |
| Metadata | Read | Identify repositories and installation context. |
| Pull requests | Read | Correlate audits with pull-request changes without commenting or merging. |
| Checks | Read | Observe existing CI results without creating or modifying checks. |

The subscribed events are installation lifecycle, push, and pull request changes. The contract requests no write permission and does not contain an App private key, webhook secret, client secret, or callback URL. For a self-hosted instance, configure those values only after selecting an endpoint and registering the App.

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

## Beta analysis boundary

The hosted GitHub connection is currently for installation validation and
repository metadata only. It does not download, cache, or analyze repository
contents. Keep the private key and API bearer token on the hosting service;
do not copy them into a user workstation or expose an installation token to a
browser.

For the beta, analyze code on the user's computer. The user checks out the
target repository with their own GitHub CLI credentials. The CleanCode package
CLI is not yet published; from a Guardian checkout, install GitHub CLI, sign in
with `gh auth login`, build it once and run:

```powershell
npm install
npm run build:cli
node packages/cli/dist/index.js github analyze OWNER/REPOSITORY --destination C:\path\to\new-local-folder
```

The command refuses an existing destination, reads the cloned files locally,
and does not execute project scripts or upload repository source to Guardian's
hosted service. Hosted source analysis is a separate future feature and must
remain disabled until explicit consent, retention/deletion behavior, and
deployment security are designed.

`src/github.ts` contains the corresponding raw-body `X-Hub-Signature-256` verifier, covered by GitHub's published test vector, plus a short-lived RS256 App JWT builder tested against an ephemeral key. The local webhook server exposes `POST /webhooks/github` when `GITHUB_WEBHOOK_SECRET` is configured; it verifies and acknowledges signed deliveries without executing repository changes. Runtime private keys and the registration-time webhook secret are still required through deployment secrets.

GitHub Apps should request the minimum permissions needed for their API and webhook behavior. See GitHub's [permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-github-apps/choosing-permissions-for-a-github-app) and [App registration parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters).
