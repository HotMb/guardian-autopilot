# Final production path

This is the recommended deployment sequence for a finished Guardian Autopilot
service. It is intentionally a runbook: it does not create cloud resources,
buy a domain, or handle credentials automatically.

## Target topology

```text
Cloudflare DNS/proxy
        |
Google HTTPS Load Balancer + Cloud Armor
        |
Cloud Run (ingress: internal-and-cloud-load-balancing)
        |
Cloud SQL PostgreSQL (private access, backups, PITR)
```

For the first controlled test, Cloud Run can use its HTTPS endpoint directly
with a small maximum instance count. Before accepting real users, put the
service behind the load balancer and disable direct public access to the
`run.app` URL.

## Step 1 — domain

1. Register the approved product domain with Cloudflare Registrar when the TLD
   is supported; otherwise use a reputable registrar and delegate DNS to
   Cloudflare.
2. Create `api.<domain>` for this service and `app.<domain>` for the browser
   application.
3. Keep the API origin uncached. Only the public frontend may use CDN caching.
4. Configure HTTPS with strict origin validation. Never use Flexible SSL.

## Step 2 — Google Cloud project

1. Create or select the billing project owned by the deployment operator.
2. Enable Cloud Run, Artifact Registry, Cloud SQL Admin and Secret Manager.
3. Configure a billing budget and alerts before deploying anything.
4. Use one European region for Cloud Run, Cloud SQL and the load balancer when
   possible. Paris (`europe-west9`) is the default candidate for a France-first
   product, subject to service availability and the operator's data policy.

## Step 3 — PostgreSQL

1. Create a managed PostgreSQL instance in the same region as Cloud Run.
2. Enable automated backups and point-in-time recovery.
3. Prefer private connectivity; do not expose PostgreSQL directly to the public
   internet.
4. Create a dedicated application role with only the required database access.
5. Store `DATABASE_URL` in Secret Manager with TLS enabled.
6. Set `DATABASE_MAX_CONNECTIONS=10` initially and keep Cloud Run at a maximum
   of 3 instances. Review the total connection budget before increasing either
   value.
7. Do not set `STRIPE_SUBSCRIPTION_STORE_PATH` in the horizontally scaled
   deployment.

The current service creates its two required tables transactionally at startup
and uses a unique processed-event row to make Stripe retries safe across
instances. Backups and restore tests remain deployment-owner obligations.

## Step 4 — Cloud Run

1. Build and push the repository's `Dockerfile` to Artifact Registry.
2. Deploy with `HOST=0.0.0.0`; Cloud Run supplies the listening `PORT`.
3. Start with request-based billing, minimum instances `0`, maximum instances
   `3`, and a conservative request timeout.
4. Inject secrets from Secret Manager, never from a committed `.env` file.
5. Set `CORS_ORIGINS` to the exact browser origin, for example
   `https://app.<domain>`; never use `*`.
6. Configure the health probe as `GET /healthz`.

## Step 5 — public edge

1. Put `api.<domain>` behind the Google HTTPS load balancer.
2. Apply Cloud Armor rate-limit and WAF rules to the API.
3. Configure Cloud Run ingress as `internal-and-cloud-load-balancing`.
4. Disable or restrict the direct `run.app` endpoint so traffic cannot bypass
   the edge controls.
5. Add an explicit exception or tested rule for Stripe webhook delivery; do not
   challenge signed webhook requests with an interactive browser challenge.

## Step 6 — Stripe test launch

1. Keep the Stripe sandbox key and sandbox price IDs in Secret Manager.
2. Register `https://api.<domain>/webhooks/stripe` as a sandbox endpoint.
3. Subscribe to the three supported subscription lifecycle events.
4. Run created, updated, deleted, duplicate and invalid-signature deliveries.
5. Run a Checkout test and verify that the webhook, PostgreSQL record and
   entitlement state agree after a restart.
6. Do not switch to live mode until failed payments, refunds, fulfillment,
   support, privacy, tax and incident procedures are approved.

## Step 7 — go-live gate

The deployment is not finished until all of these are evidenced:

- production preflight passes;
- backups have been restored successfully in a separate test instance;
- load and abuse tests use only test data;
- Cloud Run, Cloud SQL and edge alerts are configured;
- the monthly spending ceiling is documented and monitored;
- secrets are absent from Git, images, logs and shell history;
- Stripe test transactions and retry behavior are recorded;
- the privacy notice, terms, support process and data-retention policy are live.

The repository-side configuration template is
[`deploy/production.env.example`](../deploy/production.env.example). The
deployment owner must supply the project ID, domain, billing account and
secret values before any cloud command can be run safely.
