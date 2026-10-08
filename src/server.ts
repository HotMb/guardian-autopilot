import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import type Stripe from 'stripe';
import {createCheckoutSession, type CheckoutConfiguration} from './checkout.js';
import {verifyGitHubWebhookSignature} from './github.js';
import {processStripeSubscriptionWebhook} from './webhooks.js';
import type {SubscriptionStore} from './subscriptions.js';

const defaultMaxBodyBytes = 4 * 1024 * 1024;

export type BillingWebhookServerOptions = {
  endpointSecret: string;
  store: SubscriptionStore;
  githubWebhookSecret?: string;
  stripeClient?: Stripe;
  checkoutConfiguration?: CheckoutConfiguration;
  checkoutAccessToken?: string;
  maxBodyBytes?: number;
  nowSeconds?: number;
};

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function readRawBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBodyBytes) {
        settled = true;
        reject(new Error('request body exceeds the configured limit'));
        request.resume();
        return;
      }
      chunks.push(bytes);
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function signatureHeader(request: IncomingMessage): string {
  const value = request.headers['stripe-signature'];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function hasValidBearerToken(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = headerValue(request, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (match === null) return false;
  const presentedDigest = createHash('sha256').update(match[1]).digest();
  const expectedDigest = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

function parseGitHubPayload(rawBody: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('GitHub webhook body is invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('GitHub webhook body must be an object');
  return parsed as Record<string, unknown>;
}

/** Framework-free HTTP boundary for signed Stripe subscription webhooks. */
export function createBillingWebhookServer(options: BillingWebhookServerOptions): Server {
  if (options.endpointSecret.trim() === '') throw new Error('Stripe webhook endpoint secret is required');
  if (options.githubWebhookSecret !== undefined && options.githubWebhookSecret.trim() === '') throw new Error('GitHub webhook secret is required');
  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('maxBodyBytes must be a positive safe integer');
  if ((options.stripeClient === undefined) !== (options.checkoutConfiguration === undefined)) throw new Error('Stripe client and Checkout configuration must be provided together');

  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, 200, {ok: true, service: 'guardian-autopilot'});
      return;
    }
    if (request.method === 'POST' && request.url === '/billing/checkout') {
      if (options.stripeClient === undefined || options.checkoutConfiguration === undefined || options.checkoutAccessToken === undefined) {
        sendJson(response, 503, {error: 'checkout unavailable'});
        return;
      }
      if (!hasValidBearerToken(request, options.checkoutAccessToken)) {
        response.setHeader('www-authenticate', 'Bearer');
        sendJson(response, 401, {error: 'Checkout authorization required'});
        return;
      }
      try {
        const body = await readRawBody(request, maxBodyBytes);
        const parsed = JSON.parse(body.toString('utf8')) as {plan?: unknown; customerEmail?: unknown; clientReferenceId?: unknown};
        const session = await createCheckoutSession(options.stripeClient, options.checkoutConfiguration, {
          plan: parsed.plan as 'pro' | 'team',
          ...(parsed.customerEmail === undefined ? {} : {customerEmail: parsed.customerEmail as string}),
          ...(parsed.clientReferenceId === undefined ? {} : {clientReferenceId: parsed.clientReferenceId as string}),
        });
        sendJson(response, 201, {id: session.id, url: session.url ?? null});
      } catch {
        sendJson(response, 400, {error: 'invalid Checkout request'});
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/webhooks/github') {
      if (options.githubWebhookSecret === undefined) {
        sendJson(response, 503, {error: 'GitHub webhook unavailable'});
        return;
      }
      try {
        const body = await readRawBody(request, maxBodyBytes);
        const event = headerValue(request, 'x-github-event').trim();
        const deliveryId = headerValue(request, 'x-github-delivery').trim();
        if (event === '' || deliveryId === '') throw new Error('GitHub webhook headers are required');
        verifyGitHubWebhookSignature(body, headerValue(request, 'x-hub-signature-256'), options.githubWebhookSecret);
        parseGitHubPayload(body);
        sendJson(response, 200, {status: 'accepted', event, deliveryId});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('exceeds the configured limit') ? 413 : 400;
        sendJson(response, statusCode, {error: statusCode === 413 ? 'request body too large' : 'invalid GitHub webhook'});
      }
      return;
    }
    if (request.method !== 'POST' || request.url !== '/webhooks/stripe') {
      sendJson(response, 404, {error: 'not found'});
      return;
    }
    try {
      const body = await readRawBody(request, maxBodyBytes);
      const result = await processStripeSubscriptionWebhook(body, signatureHeader(request), options.endpointSecret, options.store, {
        ...(options.nowSeconds === undefined ? {} : {nowSeconds: options.nowSeconds}),
      });
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.includes('exceeds the configured limit') ? 413 : 400;
      sendJson(response, statusCode, {error: statusCode === 413 ? 'request body too large' : 'invalid Stripe webhook'});
    }
  });
}
