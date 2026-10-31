# Free beta deployment

This path is for validating GitHub commit audits without paid Google Cloud
infrastructure, a domain, or Stripe. It is not a production availability promise.

## Architecture

```text
GitHub main
    |
Render Free Web Service (Docker + HTTPS + temporary onrender.com URL)
    |
Supabase Free PostgreSQL
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
5. The subscription store creates `guardian_processed_events` and
   `guardian_subscriptions`; the GitHub audit queue creates
   `guardian_github_audit_jobs` when audit settings are configured.

## 2. Create the free Render service

1. In Render, choose **New → Blueprint**.
2. Connect `HotMb/guardian-autopilot` and select the `main` branch.
3. Render detects [`render.yaml`](../render.yaml) and proposes the Free plan.
4. Set every `sync: false` variable in the dashboard; never commit these
   values.
5. GitHub webhooks are server-to-server and do not need a CORS setting. Add
   `CORS_ORIGINS` only if a browser client is introduced later.
6. Deploy and wait for `GET /healthz` to return HTTP 200.

## 3. Keep billing disabled during the free beta

Stripe is not required for GitHub commit audits. Leave all `STRIPE_*` variables
unset; `/billing/checkout` and `/webhooks/stripe` stay disabled while `/healthz`
and `/webhooks/github` remain available. This avoids collecting payment details
or starting subscriptions during product validation.

To test paid subscriptions later, configure the full Stripe sandbox setup in
the deployment guide and run its separate billing checks.

## 4. Verify the beta

Run the preflight with the GitHub and PostgreSQL variables before copying them
to Render:

```powershell
node dist/cli.js preflight --production
```

Then verify, in order:

1. `GET /healthz` returns 200;
2. GitHub sends a signed push and receives `202`;
3. the commit's Checks tab shows a `CleanCode audit` report;
4. a redelivered push is deduplicated;
5. the PostgreSQL audit queue contains metadata only, not source archives;
6. a restart still serves `/healthz` and resumes queued work.

## Limits and exit criteria

- Free Render services sleep and can have cold starts.
- Free Render storage is not durable; only PostgreSQL state is persistent.
- Free Supabase has no production backup or point-in-time recovery.
- Keep Cloud Run and Cloud SQL disabled while there is no budget.
- Do not accept live Stripe payments on this deployment.
- Move to Cloud Run + Cloud SQL only after validation, funding and a budget
  alert are available.
