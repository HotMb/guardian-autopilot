# Security and launch gate

Guardian Autopilot is not ready for an unattended public deployment yet. The safe
default is to keep the service local and use Stripe CLI test-mode forwarding while
the architecture, data policy, and operational limits are being validated.

## What is protected today

- Stripe webhooks verify the raw request body with `STRIPE_WEBHOOK_SECRET` before
  changing subscription state.
- GitHub deliveries verify `X-Hub-Signature-256` and are acknowledged without
  running repository actions.
- Request bodies are bounded to 4 MiB by default.
- Checkout is disabled unless the Stripe configuration **and**
  `STRIPE_CHECKOUT_ACCESS_TOKEN` are present. Calls must send
  `Authorization: Bearer <token>`.
- Live Stripe keys are rejected by the local Checkout configuration.
- Subscription state can use PostgreSQL transactions and unique event IDs when
  the service is horizontally scaled.

## Free test path

1. Keep the webhook process local and use `stripe listen` for Stripe test events.
2. If an external GitHub or Stripe callback is needed temporarily, use a
   Cloudflare Quick Tunnel (`cloudflared tunnel --url http://localhost:8787`).
3. Treat the generated `trycloudflare.com` URL as a disposable development URL:
   Quick Tunnels are for testing and development, not production hosting.
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

The hosted test-mode webhook and database-backed deployment remain intentionally
uncompleted until these owner-controlled decisions are made.
