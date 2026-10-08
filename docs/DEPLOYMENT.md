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
  -v guardian-autopilot-data:/var/lib/guardian \
  guardian-autopilot-webhook
```

The image binds to `0.0.0.0`, exposes port `8787`, runs as the unprivileged `node` user, and stores subscription state in `/var/lib/guardian/subscriptions.json`. The volume must be durable for webhook de-duplication and subscription state to survive replacement of the container.

## Before exposing it publicly

1. Choose a hosting provider with a stable HTTPS URL and a durable volume or database.
2. Supply `STRIPE_WEBHOOK_SECRET`, and provide the Checkout variables only when Checkout is enabled.
3. Register `https://<host>/webhooks/stripe` as a Stripe test-mode endpoint subscribed to the three subscription lifecycle events.
4. Configure the provider's health probe to `GET /healthz`.
5. Restrict logs and environment access; do not put secrets in the image, repository, or command history.
6. Run a Stripe CLI test-mode event and confirm a `2xx` response before accepting test Checkout traffic.

This checklist intentionally stops before provider registration and public deployment because those actions require the deployment owner, domain, secret storage, and persistence choice.
