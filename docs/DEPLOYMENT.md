# Webhook deployment checklist

The repository includes a provider-neutral Docker image for the Stripe webhook server. It does not select a hosting provider, create cloud resources, or contain credentials.

## Build and run locally

```bash
docker build -t guardian-autopilot-webhook .
docker run --rm -p 8787:8787 \
  -e STRIPE_WEBHOOK_SECRET=whsec_test_value \
  -e STRIPE_SECRET_KEY=sk_test_value \
  -e STRIPE_PRICE_PRO=price_test_pro \
  -e STRIPE_PRICE_TEAM=price_test_team \
  -e STRIPE_CHECKOUT_SUCCESS_URL=https://example.invalid/billing/success \
  -e STRIPE_CHECKOUT_CANCEL_URL=https://example.invalid/billing/cancel \
  -e STRIPE_CHECKOUT_ACCESS_TOKEN=replace_with_a_long_random_value \
  -e STRIPE_SUBSCRIPTION_STORE_PATH=/var/lib/guardian/subscriptions.json \
  -v guardian-autopilot-data:/var/lib/guardian \
  guardian-autopilot-webhook
```

The image binds to `0.0.0.0`, exposes port `8787`, and runs as the unprivileged `node` user. The example uses the mounted volume for single-instance local persistence; the volume must be durable for webhook de-duplication and subscription state to survive replacement of the container.

For a horizontally scaled service, provide `DATABASE_URL` instead of `STRIPE_SUBSCRIPTION_STORE_PATH`. The service creates the two required PostgreSQL tables at startup and uses a transaction plus a unique event constraint so retries remain safe across instances. Set a Cloud Run maximum instance count that matches the database connection budget.

## Recommended scalable target

For Guardian Autopilot, the recommended first hosted target is Cloud Run plus Cloud SQL for PostgreSQL:

- Cloud Run supplies a managed HTTPS endpoint and request-driven autoscaling for the Docker image.
- Cloud SQL supplies managed PostgreSQL with regional high availability when enabled.
- `DATABASE_URL` selects the PostgreSQL store; do not set `STRIPE_SUBSCRIPTION_STORE_PATH` in the horizontally scaled service.

This repository does not create the Google Cloud project, billing account, database, or secrets automatically. Those are the deployment owner's controlled steps.

## Before exposing it publicly

1. Choose a hosting provider with a stable HTTPS URL and a durable volume or database.
2. Supply `STRIPE_WEBHOOK_SECRET`, and provide the Checkout variables plus a long random `STRIPE_CHECKOUT_ACCESS_TOKEN` only when Checkout is enabled. Requests to Checkout must send `Authorization: Bearer <token>`.
3. If a GitHub App is registered, supply `GITHUB_WEBHOOK_SECRET`; the same server then accepts signed deliveries at `/webhooks/github` without performing actions.
4. Register `https://<host>/webhooks/stripe` as a Stripe test-mode endpoint subscribed to the three subscription lifecycle events.
5. Configure the provider's health probe to `GET /healthz`.
6. Restrict logs and environment access; do not put secrets in the image, repository, or command history.
7. Run a Stripe CLI test-mode event and confirm a `2xx` response before accepting test Checkout traffic.

This checklist intentionally stops before provider registration and public deployment because those actions require the deployment owner, domain, secret storage, and persistence choice.
