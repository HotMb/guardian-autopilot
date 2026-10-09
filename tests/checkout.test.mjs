import assert from 'node:assert/strict';
import test from 'node:test';
import {checkoutConfigurationFromEnv, createCheckoutSession, createStripeClient} from '../dist/checkout.js';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_123456789',
  STRIPE_PRICE_PRO: 'price_pro123',
  STRIPE_PRICE_TEAM: 'price_team123',
  STRIPE_CHECKOUT_SUCCESS_URL: 'http://localhost:3000/success?source=guardian',
  STRIPE_CHECKOUT_CANCEL_URL: 'http://localhost:3000/cancel',
};

test('Checkout configuration is test-only and validates prices and URLs', () => {
  assert.deepEqual(checkoutConfigurationFromEnv(env), {
    secretKey: env.STRIPE_SECRET_KEY,
    priceIds: {pro: env.STRIPE_PRICE_PRO, team: env.STRIPE_PRICE_TEAM},
    successUrl: 'http://localhost:3000/success?source=guardian',
    cancelUrl: 'http://localhost:3000/cancel',
  });
  assert.throws(() => checkoutConfigurationFromEnv({...env, STRIPE_SECRET_KEY: 'sk_live_123'}), /test-mode/);
  assert.throws(() => checkoutConfigurationFromEnv({...env, STRIPE_PRICE_PRO: 'prod_123'}), /price id/);
  assert.throws(() => checkoutConfigurationFromEnv({...env, STRIPE_CHECKOUT_SUCCESS_URL: '/success'}), /absolute URL/);
});

test('Checkout client uses an instance and creates a subscription session with plan metadata', async () => {
  const configuration = checkoutConfigurationFromEnv(env);
  assert.equal(createStripeClient(configuration).constructor.name, 'Stripe');
  let received;
  const client = {checkout: {sessions: {create: async (params) => { received = params; return {id: 'cs_test_guardian'}; }}}};
  const session = await createCheckoutSession(client, configuration, {plan: 'pro', customerEmail: 'buyer@example.com', clientReferenceId: 'user_123'});
  assert.deepEqual(session, {id: 'cs_test_guardian'});
  assert.equal(received.mode, 'subscription');
  assert.deepEqual(received.line_items, [{price: 'price_pro123', quantity: 1}]);
  assert.equal(received.customer_email, 'buyer@example.com');
  assert.equal(received.client_reference_id, 'user_123');
  assert.deepEqual(received.metadata, {guardian_plan: 'pro'});
  assert.deepEqual(received.subscription_data, {metadata: {guardian_plan: 'pro'}});
  assert.equal(received.success_url, 'http://localhost:3000/success?source=guardian&session_id={CHECKOUT_SESSION_ID}');
});

test('Checkout rejects free plans and invalid customer inputs', async () => {
  const configuration = checkoutConfigurationFromEnv(env);
  const client = {checkout: {sessions: {create: async () => ({id: 'unused'})}}};
  await assert.rejects(() => createCheckoutSession(client, configuration, {plan: 'free'}), /plan is invalid/);
  await assert.rejects(() => createCheckoutSession(client, configuration, {plan: 'team', customerEmail: 'not-an-email'}), /customerEmail/);
});
