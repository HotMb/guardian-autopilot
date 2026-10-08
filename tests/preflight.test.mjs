import assert from 'node:assert/strict';
import test from 'node:test';
import {runPreflight} from '../dist/preflight.js';

const base = {
  STRIPE_WEBHOOK_SECRET: 'whsec_preflight_test',
  STRIPE_SECRET_KEY: 'sk_test_preflight',
  STRIPE_PRICE_PRO: 'price_pro123',
  STRIPE_PRICE_TEAM: 'price_team123',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.test/success',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://example.test/cancel',
  STRIPE_CHECKOUT_ACCESS_TOKEN: 'a'.repeat(32),
};

test('preflight passes a complete local test configuration', () => {
  const result = runPreflight({...base, STRIPE_SUBSCRIPTION_STORE_PATH: 'C:\\guardian\\subscriptions.json'});
  assert.equal(result.status, 'ready');
  assert.equal(result.mode, 'local');
  assert.equal(result.checks.some((check) => check.status === 'fail'), false);
});

test('preflight blocks live keys and incomplete Checkout access', () => {
  const result = runPreflight({...base, STRIPE_SECRET_KEY: 'sk_live_not_allowed', STRIPE_CHECKOUT_ACCESS_TOKEN: 'short'});
  assert.equal(result.status, 'blocked');
  assert.equal(result.checks.find((check) => check.id === 'stripe-api-key').status, 'fail');
  assert.equal(result.checks.find((check) => check.id === 'checkout-access-token').status, 'fail');
});

test('production preflight requires durable storage and a non-local bind', () => {
  const result = runPreflight(base, true);
  assert.equal(result.status, 'blocked');
  assert.equal(result.checks.find((check) => check.id === 'subscription-storage').status, 'fail');
  assert.equal(result.checks.find((check) => check.id === 'network-bind').status, 'fail');
});

test('production preflight accepts PostgreSQL and a public container bind', () => {
  const result = runPreflight({...base, DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/guardian', HOST: '0.0.0.0'}, true);
  assert.equal(result.status, 'ready');
});
