# Free beta deployment

This path is for validation without a paid Google Cloud database or a domain.
It is not a production availability promise and must use Stripe sandbox keys
and sandbox prices only.

## Architecture

```text
GitHub main
    |
Render Free Web Service (Docker + HTTPS + temporary onrender.com URL)
    |
Supabase Free PostgreSQL
    |
Stripe Sandbox
```

Render's free web service sleeps after inactivity and has an ephemeral
filesystem. Supabase's free database has a small storage limit, can pause after
inactivity, and does not provide production backups. Do not use either free
plan for real customers or live payments.

## 1. Create the free database

1. Create a Supabase project on the Free plan.
2. Choose a European region close to the Render service.
3. Copy the pooled PostgreSQL connection string, not a password pasted into
   GitHub or this repository.
4. Keep SSL enabled in the connection string, for example with
   `sslmode=require` when Supabase provides that form.
5. The application creates its two required tables on startup. Confirm that
   `guardian_processed_events` and `guardian_subscriptions` appear after the
   first healthy deployment.

## 2. Create the free Render service

1. In Render, choose **New → Blueprint**.
2. Connect `HotMb/guardian-autopilot` and select the `main` branch.
3. Render detects [`render.yaml`](../render.yaml) and proposes the Free plan.
4. Set every `sync: false` variable in the dashboard; never commit these
   values.
5. Use the service URL Render assigns as `CORS_ORIGINS` when a browser client
   calls Checkout. If there is no browser client yet, leave it empty.
6. Deploy and wait for `GET /healthz` to return HTTP 200.

## 3. Configure Stripe sandbox

Use only values from the connected Stripe sandbox:

- `STRIPE_SECRET_KEY` must start with `sk_test_` or `rk_test_`;
- `STRIPE_PRICE_PRO` and `STRIPE_PRICE_TEAM` must belong to the same sandbox;
- `STRIPE_CHECKOUT_ACCESS_TOKEN` must be a long random value;
- `STRIPE_CHECKOUT_SUCCESS_URL` and `STRIPE_CHECKOUT_CANCEL_URL` must point to
  a real frontend or a temporary test page;
- `STRIPE_WEBHOOK_SECRET` must come from the Stripe test-mode endpoint, not
  from a different account or environment.

Register this test endpoint in Stripe:

```text
https://<render-service>.onrender.com/webhooks/stripe
```

Subscribe to `customer.subscription.created`,
`customer.subscription.updated`, and `customer.subscription.deleted`.

## 4. Verify the beta

Run the preflight with the same variables locally before copying them to
Render:

```powershell
node dist/cli.js preflight --production
```

Then verify, in order:

1. `GET /healthz` returns 200;
2. Stripe sends a signed test subscription event and receives 200;
3. the Supabase tables contain the subscription and processed event;
4. a duplicate event is acknowledged without creating a second record;
5. Checkout returns a sandbox URL;
6. a restart still reads the subscription state.

## Limits and exit criteria

- Free Render services sleep and can have cold starts.
- Free Render storage is not durable; only PostgreSQL state is persistent.
- Free Supabase has no production backup or point-in-time recovery.
- Keep Cloud Run and Cloud SQL disabled while there is no budget.
- Do not accept live Stripe payments on this deployment.
- Move to Cloud Run + Cloud SQL only after validation, funding and a budget
  alert are available.
