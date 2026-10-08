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
  });
  await new Promise((resolve) => configured.listen(0, '127.0.0.1', resolve));
  try {
    const result = await call(configured, '/billing/checkout', 'POST', JSON.stringify({plan: 'team'}), {'content-type': 'application/json'});
    assert.deepEqual(result, {statusCode: 201, json: {id: 'cs_test_http', url: 'https://checkout.stripe.com/test'}});
    assert.equal(received.metadata.guardian_plan, 'team');
  } finally {
    await new Promise((resolve, reject) => configured.close((error) => error ? reject(error) : resolve()));
  }
});
