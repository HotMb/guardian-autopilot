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

`src/github.ts` contains the corresponding raw-body `X-Hub-Signature-256` verifier, covered by GitHub's published test vector, plus a short-lived RS256 App JWT builder tested against an ephemeral key. It performs HMAC-SHA256 and constant-time comparison; it does not receive, store, or forward webhook requests by itself. Runtime private keys are still required through deployment secrets.

GitHub Apps should request the minimum permissions needed for their API and webhook behavior. See GitHub's [permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-github-apps/choosing-permissions-for-a-github-app) and [App registration parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters).
