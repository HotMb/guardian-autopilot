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

test('production preflight allows the free GitHub audit service without Stripe billing', () => {
  const result = runPreflight({
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/guardian',
    DATABASE_MAX_CONNECTIONS: '3',
    GITHUB_WEBHOOK_SECRET: 'github-webhook-secret',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----',
  }, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.checks.find((check) => check.id === 'stripe-webhook-secret').status, 'pass');
  assert.match(result.checks.find((check) => check.id === 'stripe-webhook-secret').message, /Stripe billing is disabled/i);
  assert.equal(result.checks.find((check) => check.id === 'github-audit').status, 'pass');
});

test('production preflight validates the PostgreSQL connection pool cap', () => {
  const invalid = runPreflight({...base, DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/guardian', HOST: '0.0.0.0', DATABASE_MAX_CONNECTIONS: '0'}, true);
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.checks.find((check) => check.id === 'database-pool').status, 'fail');

  const valid = runPreflight({...base, DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/guardian', HOST: '0.0.0.0', DATABASE_MAX_CONNECTIONS: '10'}, true);
  assert.equal(valid.status, 'ready');
  assert.equal(valid.checks.find((check) => check.id === 'database-pool').status, 'pass');
});

test('preflight detects incomplete or mistyped GitHub audit credentials without revealing values', () => {
  const partial = runPreflight({...base, GITHUB_WEBHOOK_SECRET: 'do-not-print-this'});
  assert.equal(partial.status, 'blocked');
  assert.match(partial.checks.find((check) => check.id === 'github-audit').message, /require/i);
  assert.doesNotMatch(JSON.stringify(partial), /do-not-print-this/);

  const badPrivateKey = runPreflight({...base, DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/guardian', GITHUB_WEBHOOK_SECRET: 'webhook-secret', GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: 'client-secret-value', HOST: '0.0.0.0'}, true);
  assert.equal(badPrivateKey.status, 'blocked');
  assert.match(badPrivateKey.checks.find((check) => check.id === 'github-audit').message, /pem private key/i);
});

test('preflight accepts a complete GitHub audit setup and enforces its minimum database pool size', () => {
  const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
  const configured = {
    ...base,
    DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/guardian',
    GITHUB_WEBHOOK_SECRET: 'github-webhook-secret',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    HOST: '0.0.0.0',
  };
  const ready = runPreflight(configured, true);
  assert.equal(ready.checks.find((check) => check.id === 'github-audit').status, 'pass');
  assert.equal(ready.status, 'ready');

  const tooSmall = runPreflight({...configured, DATABASE_MAX_CONNECTIONS: '1'}, true);
  assert.equal(tooSmall.checks.find((check) => check.id === 'github-audit').status, 'fail');
  assert.equal(tooSmall.status, 'blocked');
});
