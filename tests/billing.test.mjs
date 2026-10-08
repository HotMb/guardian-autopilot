import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import test from 'node:test';
import {
  entitlementsForPlan,
  hasEntitlement,
  normalizeEntitlementSnapshot,
  verifyStripeWebhookSignature,
} from '../dist/billing.js';

const secret = 'whsec_guardian_test_secret';
const payload = JSON.stringify({id: 'evt_test_guardian', type: 'customer.subscription.updated'});

function signature(timestamp, body = payload) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

test('billing plans expose conservative local and hosted entitlements', () => {
  assert.deepEqual(entitlementsForPlan('free'), ['local_reports', 'reversible_cleanup', 'mcp_audit']);
  assert.equal(entitlementsForPlan('pro').includes('hosted_audits'), true);
  assert.equal(entitlementsForPlan('team').includes('team_reporting'), true);
  assert.equal(hasEntitlement({plan: 'pro', status: 'active'}, 'scheduled_reports'), true);
  assert.equal(hasEntitlement({plan: 'pro', status: 'past_due'}, 'scheduled_reports'), false);
  assert.equal(hasEntitlement({plan: 'pro', status: 'active', currentPeriodEnd: 100}, 'scheduled_reports', 100), false);
});

test('billing snapshots reject malformed untrusted values', () => {
  assert.deepEqual(normalizeEntitlementSnapshot({plan: 'team', status: 'trialing', currentPeriodEnd: 123}), {
    plan: 'team',
    status: 'trialing',
    currentPeriodEnd: 123,
  });
  assert.throws(() => normalizeEntitlementSnapshot({plan: 'enterprise', status: 'active'}), /plan is invalid/);
  assert.throws(() => normalizeEntitlementSnapshot({plan: 'free', status: 'unknown'}), /status is invalid/);
  assert.throws(() => normalizeEntitlementSnapshot({plan: 'free', status: 'active', currentPeriodEnd: 0}), /currentPeriodEnd/);
});

test('Stripe test-mode fixture signatures verify from the raw body', () => {
  const timestamp = 1_700_000_000;
  const valid = verifyStripeWebhookSignature(payload, `t=${timestamp},v0=ignored,v1=${signature(timestamp)}`, secret, {nowSeconds: timestamp + 10});
  assert.deepEqual(valid, {timestamp});

  const rawBytes = Buffer.from(payload, 'utf8');
  assert.deepEqual(verifyStripeWebhookSignature(rawBytes, `t=${timestamp},v1=${signature(timestamp)}`, secret, {nowSeconds: timestamp}), {timestamp});
  assert.throws(() => verifyStripeWebhookSignature(`${payload} `, `t=${timestamp},v1=${signature(timestamp)}`, secret, {nowSeconds: timestamp}), /verification failed/);
  assert.throws(() => verifyStripeWebhookSignature(payload, `t=${timestamp - 301},v1=${signature(timestamp - 301)}`, secret, {nowSeconds: timestamp}), /outside the allowed tolerance/);
  assert.throws(() => verifyStripeWebhookSignature(payload, `t=${timestamp},v0=${signature(timestamp)}`, secret, {nowSeconds: timestamp}), /missing a valid timestamp or v1 signature/);
});
