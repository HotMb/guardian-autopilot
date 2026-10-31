# Webhook deployment checklist

The repository includes a provider-neutral Docker image for the webhook service. Stripe billing is optional; GitHub commit audits can run without Stripe. The image does not select a hosting provider, create cloud resources, or contain credentials.

## Build and run locally

```bash
docker build -t guardian-autopilot-webhook .
docker run --rm -p 8787:8787 guardian-autopilot-webhook
```

The image binds to `0.0.0.0`, exposes port `8787`, and runs as the unprivileged `node` user. Stripe endpoints are unavailable until Stripe configuration is supplied.

For a horizontally scaled service, provide `DATABASE_URL` instead of `STRIPE_SUBSCRIPTION_STORE_PATH`. The subscription store creates its two PostgreSQL tables at startup; enabling GitHub audits also creates the durable audit-queue table. Subscription events use transactions and a unique event constraint so retries remain safe across instances. Set a Cloud Run maximum instance count that matches the database connection budget.

## Recommended scalable target

For Guardian Autopilot, the recommended first hosted target is Cloud Run plus Cloud SQL for PostgreSQL:

- Cloud Run supplies a managed HTTPS endpoint and request-driven autoscaling for the Docker image.
- Cloud SQL supplies managed PostgreSQL with regional high availability when enabled.
- `DATABASE_URL` selects the PostgreSQL store; do not set `STRIPE_SUBSCRIPTION_STORE_PATH` in the horizontally scaled service.

This repository does not create the Google Cloud project, billing account, database, or secrets automatically. Those are the deployment owner's controlled steps.

## Before exposing it publicly

1. Choose a hosting provider with a stable HTTPS URL and a durable volume or database.
2. For hosted CleanCode commit reports, configure `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and `DATABASE_URL`; request Contents: read, Metadata: read, and Checks: write, subscribe to Push, then install/update the App. See the [GitHub audit setup](GITHUB_APP.md). Without all four settings, a push cannot be durably queued.
3. Configure `STRIPE_WEBHOOK_SECRET` only when enabling Stripe billing. Checkout additionally requires the Stripe test API key, price IDs, return URLs, and a long random `STRIPE_CHECKOUT_ACCESS_TOKEN`. Requests to Checkout must send `Authorization: Bearer <token>`.
4. When billing is enabled, register `https://<host>/webhooks/stripe` as a Stripe test-mode endpoint subscribed to the three subscription lifecycle events.
5. Configure the provider's health probe to `GET /healthz`.
6. Restrict logs and environment access; do not put secrets in the image, repository, or command history.
7. If a browser frontend calls Checkout, set `CORS_ORIGINS` to its exact HTTPS origin; never use `*`.
8. Put provider-level rate limiting and a WAF/CDN policy in front of the origin; the built-in limiter is per process and is not DDoS protection.
9. Run a Stripe CLI test-mode event and confirm a `2xx` response before accepting test Checkout traffic.

This checklist intentionally stops before provider registration and public deployment because those actions require the deployment owner, domain, secret storage, and persistence choice.

If no deployment budget is available yet, use the separate [free beta runbook](FREE-BETA-DEPLOYMENT.md). It uses Render Free and Supabase Free only for short-lived validation and must not receive live payments.
