# Security and launch gate

Guardian Autopilot is in a free validation beta, not ready for unattended
production. GitHub commit audits do not require Stripe; keep billing disabled
until paid subscriptions are deliberately introduced.

Run `npm exec guardian -- preflight` for a local check, or
`npm exec guardian -- preflight --production` before a hosted test deployment. It
only reads configuration and never creates cloud resources.

## What is protected today

- Stripe webhooks verify the raw request body with `STRIPE_WEBHOOK_SECRET` before
  changing subscription state.
- GitHub deliveries verify `X-Hub-Signature-256` and are acknowledged without
  running repository actions.
- Request bodies are bounded to 4 MiB by default.
- The HTTP boundary emits restrictive security headers and applies a bounded
  per-process rate limit (120 requests per minute per source address by default).
- Browser requests are denied unless their exact origin is listed in
  `CORS_ORIGINS`; wildcard origins are not accepted.
- Stripe webhook handling is unavailable without `STRIPE_WEBHOOK_SECRET`;
  GitHub audit startup does not depend on Stripe.
- Checkout is disabled unless the Stripe test configuration, webhook secret,
  and `STRIPE_CHECKOUT_ACCESS_TOKEN` are present. Calls must send
  `Authorization: Bearer <token>`.
- Live Stripe keys are rejected by the local Checkout configuration.
- Subscription state can use PostgreSQL transactions and unique event IDs when
  the service is horizontally scaled.

## Free test path

1. Use Render Free and Supabase Free as described in the
   [free beta runbook](FREE-BETA-DEPLOYMENT.md).
2. Leave every `STRIPE_*` variable unset; `/billing/checkout` and
   `/webhooks/stripe` remain unavailable.
3. Verify the GitHub webhook and commit Check Run before considering the hosted
   integration usable.
4. Do not create a Google Cloud project, Cloud SQL instance, or live Stripe
   endpoint until the preflight below is complete.

This path avoids Google Cloud request charges while the product is being tested.
It is not a production availability or security promise.

## Why Google Cloud is deferred

A public Cloud Run URL can receive a large number of requests. Autoscaling and a
free tier do not create a hard spending ceiling. Before any public deployment:

- use request-based billing;
- configure a low Cloud Run maximum instance count initially (for example, 3);
- configure billing alerts and, where available, an explicit spend cap;
- verify that the service stops or degrades safely when the cap is reached;
- do not add Cloud SQL until PostgreSQL backups, access control, and monthly cost
  are understood;
- put a rate-limiting/WAF layer in front of the origin for a production service;
- never expose a database directly to the internet.

These controls reduce cost exposure; they do not guarantee that a DDoS attack
will cost zero. The free Quick Tunnel is therefore the temporary choice, not a
production DDoS mitigation plan.

The built-in rate limiter is intentionally small and local: it is in-memory,
per process, and keyed by the source address visible to the Node process. It
does not coordinate across replicas and must not be treated as a WAF, bot
filter, or volumetric DDoS defense. A hosted service still needs provider-level
rate limits and an upstream WAF/CDN policy before the origin is exposed.

When Checkout is called from a browser, set `CORS_ORIGINS` to a comma-separated
list of exact `http` or `https` origins such as `https://app.example.com`.
Do not use `*`, paths, credentials in the URL, or a broad origin pattern.

## Pre-launch obligations

Before accepting real users or real payments, the owner must confirm:

- separate Stripe test and live environments, with a least-privilege restricted
  key where supported;
- secrets stored in a secrets manager or protected runtime configuration, never in
  Git, images, logs, or shell history;
- HTTPS, webhook signature verification, replay/idempotency handling, and alerting;
- a real fulfillment path driven by Stripe webhooks, including delayed and failed
  payment events;
- backups, restore testing, retention/deletion rules, and access logging for
  subscription data;
- privacy notice, terms of service, support/contact process, cookie/consent rules
  where applicable, and the tax/invoicing obligations for the operator's country;
- an incident plan for leaked keys, abusive traffic, failed payments, and data
  deletion requests;
- a load/abuse test using only test data and an explicit monthly cost ceiling.

Local contract tests cover the webhook and database boundaries. The hosted
health check and a real GitHub delivery must succeed before the hosted beta is
considered validated. Production availability, backups, cost controls and the
remaining owner-controlled launch decisions are still intentionally uncompleted.
