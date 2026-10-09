import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {request} from 'node:http';
import test from 'node:test';
import {createBillingWebhookServer} from '../dist/server.js';
import {MemorySubscriptionStore} from '../dist/subscriptions.js';

const secret = 'whsec_server_test_secret';
const timestamp = 1_800_000_100;

function signature(body) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function githubSignature(body) {
  return `sha256=${createHmac('sha256', 'github_webhook_test').update(body).digest('hex')}`;
}

async function call(server, path, method, body = '', headers = {}) {
  const address = server.address();
  const result = await new Promise((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port: address.port, path, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
  return {statusCode: result.statusCode, json: JSON.parse(result.body)};
}

async function callWithHeaders(server, path, method, body = '', headers = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port: address.port, path, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('billing webhook HTTP boundary preserves signed raw bodies and returns health', async () => {
  const server = createBillingWebhookServer({endpointSecret: secret, store: new MemorySubscriptionStore(), nowSeconds: timestamp});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.deepEqual(await call(server, '/healthz', 'GET'), {statusCode: 200, json: {ok: true, service: 'guardian-autopilot'}});
    const body = JSON.stringify({id: 'evt_http_001', created: timestamp, type: 'customer.subscription.updated', data: {object: {id: 'sub_http_001', metadata: {guardian_plan: 'pro'}, status: 'active'}}});
    const result = await call(server, '/webhooks/stripe', 'POST', body, {'content-type': 'application/json', 'stripe-signature': signature(body)});
    assert.equal(result.statusCode, 200);
    assert.equal(result.json.status, 'updated');
    assert.equal(result.json.subscriptionId, 'sub_http_001');
    const invalid = await call(server, '/webhooks/stripe', 'POST', `${body} `, {'stripe-signature': signature(body)});
    assert.equal(invalid.statusCode, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('billing webhook HTTP boundary rejects oversized bodies and unknown routes', async () => {
  const server = createBillingWebhookServer({endpointSecret: secret, store: new MemorySubscriptionStore(), maxBodyBytes: 16});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await call(server, '/unknown', 'GET')).statusCode, 404);
    assert.equal((await call(server, '/webhooks/stripe', 'POST', '12345678901234567')).statusCode, 413);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('billing server emits security headers and applies bounded rate limiting', async () => {
  const server = createBillingWebhookServer({
    endpointSecret: secret,
    store: new MemorySubscriptionStore(),
    rateLimit: {maxRequests: 1, windowMs: 60_000},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const first = await callWithHeaders(server, '/healthz', 'GET');
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['x-content-type-options'], 'nosniff');
    assert.equal(first.headers['x-frame-options'], 'DENY');
    assert.equal(first.headers['referrer-policy'], 'no-referrer');
    assert.equal(first.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

    const limited = await callWithHeaders(server, '/healthz', 'GET');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '60');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('billing server validates rate limits and restricts browser origins', async () => {
  assert.throws(
    () => createBillingWebhookServer({endpointSecret: secret, store: new MemorySubscriptionStore(), rateLimit: {maxRequests: 0}}),
    /rateLimit\.maxRequests must be a positive safe integer/,
  );
  assert.throws(
    () => createBillingWebhookServer({endpointSecret: secret, store: new MemorySubscriptionStore(), allowedOrigins: ['*']}),
    /allowedOrigins must contain explicit http or https origins/,
  );

  const server = createBillingWebhookServer({
    endpointSecret: secret,
    store: new MemorySubscriptionStore(),
    allowedOrigins: ['http://localhost:3000'],
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const denied = await callWithHeaders(server, '/healthz', 'GET', '', {origin: 'https://attacker.example'});
    assert.equal(denied.statusCode, 403);

    const preflight = await callWithHeaders(server, '/billing/checkout', 'OPTIONS', '', {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal(preflight.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
    assert.equal(preflight.headers['access-control-allow-headers'], 'authorization, content-type');

    const allowed = await callWithHeaders(server, '/healthz', 'GET', '', {origin: 'http://localhost:3000'});
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('billing server exposes Checkout only when configured', async () => {
  const unavailable = createBillingWebhookServer({endpointSecret: secret, store: new MemorySubscriptionStore()});
  await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await call(unavailable, '/billing/checkout', 'POST', '{}')).statusCode, 503);
  } finally {
    await new Promise((resolve, reject) => unavailable.close((error) => error ? reject(error) : resolve()));
  }

  let received;
  const configured = createBillingWebhookServer({
    endpointSecret: secret,
    store: new MemorySubscriptionStore(),
    stripeClient: {checkout: {sessions: {create: async (params) => {received = params; return {id: 'cs_test_http', url: 'https://checkout.stripe.com/test'};}}}},
    checkoutConfiguration: {
      secretKey: 'sk_test_123456789',
      priceIds: {pro: 'price_pro123', team: 'price_team123'},
      successUrl: 'http://localhost:3000/success',
      cancelUrl: 'http://localhost:3000/cancel',
    },
    checkoutAccessToken: 'checkout_test_token',
  });
  await new Promise((resolve) => configured.listen(0, '127.0.0.1', resolve));
  try {
    const unauthorized = await call(configured, '/billing/checkout', 'POST', JSON.stringify({plan: 'team'}), {'content-type': 'application/json'});
    assert.equal(unauthorized.statusCode, 401);
    const result = await call(configured, '/billing/checkout', 'POST', JSON.stringify({plan: 'team'}), {'content-type': 'application/json', authorization: 'Bearer checkout_test_token'});
    assert.deepEqual(result, {statusCode: 201, json: {id: 'cs_test_http', url: 'https://checkout.stripe.com/test'}});
    assert.equal(received.metadata.guardian_plan, 'team');
  } finally {
    await new Promise((resolve, reject) => configured.close((error) => error ? reject(error) : resolve()));
  }
});

test('billing server verifies GitHub webhook deliveries without executing actions', async () => {
  const unavailable = createBillingWebhookServer({endpointSecret: secret, store: new MemorySubscriptionStore()});
  await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await call(unavailable, '/webhooks/github', 'POST', '{}')).statusCode, 503);
  } finally {
    await new Promise((resolve, reject) => unavailable.close((error) => error ? reject(error) : resolve()));
  }

  const server = createBillingWebhookServer({endpointSecret: secret, githubWebhookSecret: 'github_webhook_test', store: new MemorySubscriptionStore()});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = JSON.stringify({zen: 'Keep it logically awesome.'});
    const accepted = await call(server, '/webhooks/github', 'POST', body, {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-github-delivery': 'delivery-001',
      'x-hub-signature-256': githubSignature(body),
    });
    assert.deepEqual(accepted, {statusCode: 200, json: {status: 'accepted', event: 'ping', deliveryId: 'delivery-001'}});

    const invalid = await call(server, '/webhooks/github', 'POST', body, {
      'x-github-event': 'ping',
      'x-github-delivery': 'delivery-002',
      'x-hub-signature-256': 'sha256=bad',
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
