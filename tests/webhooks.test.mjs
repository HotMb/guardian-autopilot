import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import test from 'node:test';
import {MemorySubscriptionStore} from '../dist/subscriptions.js';
import {processStripeSubscriptionWebhook} from '../dist/webhooks.js';

const secret = 'whsec_guardian_webhook_test';
const timestamp = 1_800_000_000;

function signed(body) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function event(overrides = {}) {
  return JSON.stringify({
    id: 'evt_sub_001',
    created: timestamp,
    type: 'customer.subscription.updated',
    data: {object: {id: 'sub_001', customer: 'cus_001', metadata: {guardian_plan: 'pro'}, status: 'active', current_period_end: timestamp + 86400}},
    ...overrides,
  });
}

test('Stripe webhook processor verifies, persists, and deduplicates subscriptions', async () => {
  const store = new MemorySubscriptionStore();
  const body = event();
  const first = await processStripeSubscriptionWebhook(body, signed(body), secret, store, {nowSeconds: timestamp});
  assert.equal(first.status, 'updated');
  assert.deepEqual(store.get('sub_001'), {
    subscriptionId: 'sub_001',
    customerId: 'cus_001',
    eventId: 'evt_sub_001',
    updatedAt: timestamp,
    snapshot: {plan: 'pro', status: 'active', currentPeriodEnd: timestamp + 86400},
  });

  const duplicate = await processStripeSubscriptionWebhook(body, signed(body), secret, store, {nowSeconds: timestamp});
  assert.equal(duplicate.status, 'duplicate');
});

test('Stripe webhook processor handles cancellation and ignores unrelated events', async () => {
  const store = new MemorySubscriptionStore();
  const deleted = event({id: 'evt_sub_deleted', type: 'customer.subscription.deleted', data: {object: {id: 'sub_001', customer: 'cus_001', metadata: {guardian_plan: 'team'}, status: 'active'}}});
  const result = await processStripeSubscriptionWebhook(deleted, signed(deleted), secret, store, {nowSeconds: timestamp});
  assert.equal(result.status, 'updated');
  assert.deepEqual(store.get('sub_001')?.snapshot, {plan: 'team', status: 'canceled'});

  const invoice = event({id: 'evt_invoice', type: 'invoice.paid', data: {object: {id: 'in_001'}}});
  assert.equal((await processStripeSubscriptionWebhook(invoice, signed(invoice), secret, store, {nowSeconds: timestamp})).status, 'ignored');
});

test('Stripe webhook processor rejects malformed signed events', async () => {
  const store = new MemorySubscriptionStore();
  const body = event({id: ''});
  await assert.rejects(() => processStripeSubscriptionWebhook(body, signed(body), secret, store, {nowSeconds: timestamp}), /event id is required/);
  const invalidJson = '{';
  await assert.rejects(() => processStripeSubscriptionWebhook(invalidJson, signed(invalidJson), secret, store, {nowSeconds: timestamp}), /invalid JSON/);
  await assert.rejects(() => processStripeSubscriptionWebhook(event(), 't=1800000000,v1=bad', secret, store, {nowSeconds: timestamp}), /verification failed/);
});
