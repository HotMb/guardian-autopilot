# Billing foundation

The repository now contains a local, dependency-free billing foundation in `src/billing.ts`:

- free, pro, and team entitlement maps;
- validation of untrusted entitlement snapshots;
- active/trialing and period-expiry checks;
- Stripe `Stripe-Signature` verification using the raw request body, HMAC-SHA256, `v1` signatures, constant-time comparison, and a five-minute default tolerance.
- fail-closed mapping of subscription created/updated/deleted events to entitlement snapshots; an absent `metadata.guardian_plan` becomes `free`, and a deleted subscription becomes `canceled`.
- a dependency-free signed webhook processor in `src/webhooks.ts` and an atomic `SubscriptionStore` contract in `src/subscriptions.ts`; the included memory store is for local tests, while a hosted adapter can replace it with a database transaction.
- a small Node HTTP boundary in `src/server.ts`, exposed locally as `guardian webhook`; it keeps the raw body, limits request size, verifies `Stripe-Signature`, and returns `2xx` only after the store accepts the event.

The repository can now receive locally forwarded Stripe test-mode events. The included CLI server uses in-memory persistence for development only; a hosted deployment still needs a durable database adapter and endpoint configuration. This verifies webhook delivery and signature handling, not a real-money transaction.

Stripe requires the unmodified raw request body for signature verification and recommends returning a successful `2xx` response quickly before complex processing. The implementation follows those constraints; the future HTTP adapter should use the official Stripe SDK where possible. See the [Stripe webhook guide](https://docs.stripe.com/webhooks) and its [manual signature verification steps](https://docs.stripe.com/webhooks#verify-manually).
