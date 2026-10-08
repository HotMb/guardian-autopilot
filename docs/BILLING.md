# Billing foundation

The repository now contains a local, dependency-free billing foundation in `src/billing.ts`:

- free, pro, and team entitlement maps;
- validation of untrusted entitlement snapshots;
- active/trialing and period-expiry checks;
- Stripe `Stripe-Signature` verification using the raw request body, HMAC-SHA256, `v1` signatures, constant-time comparison, and a five-minute default tolerance.

The Stripe coverage uses synthetic test-mode fixtures only. It does not call Stripe, create customers, receive webhooks, persist subscriptions, or verify a real transaction. A live test-mode endpoint still requires a Stripe account, webhook secret, HTTP service, persistence, and an explicit product decision about subscription events.

Stripe requires the unmodified raw request body for signature verification and recommends returning a successful `2xx` response quickly before complex processing. The implementation follows those constraints; the future HTTP adapter should use the official Stripe SDK where possible. See the [Stripe webhook guide](https://docs.stripe.com/webhooks) and its [manual signature verification steps](https://docs.stripe.com/webhooks#verify-manually).
