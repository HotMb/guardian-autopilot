import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import type Stripe from 'stripe';
import {createCheckoutSession, type CheckoutConfiguration} from './checkout.js';
import {verifyGitHubWebhookSignature} from './github.js';
import {processStripeSubscriptionWebhook} from './webhooks.js';
import type {SubscriptionStore} from './subscriptions.js';

const defaultMaxBodyBytes = 4 * 1024 * 1024;
const defaultRateLimit = {windowMs: 60_000, maxRequests: 120, maxEntries: 10_000} as const;

export type BillingWebhookServerOptions = {
  endpointSecret: string;
  store: SubscriptionStore;
  githubWebhookSecret?: string;
  stripeClient?: Stripe;
  checkoutConfiguration?: CheckoutConfiguration;
  checkoutAccessToken?: string;
  maxBodyBytes?: number;
  rateLimit?: Partial<typeof defaultRateLimit>;
  allowedOrigins?: readonly string[];
  nowSeconds?: number;
};

type RateLimitConfig = typeof defaultRateLimit;

class RateLimiter {
  private readonly config: RateLimitConfig;
  private readonly buckets = new Map<string, {startedAt: number; count: number}>();

  constructor(options: Partial<RateLimitConfig> = {}) {
    const config = {...defaultRateLimit, ...options};
    if (!Number.isSafeInteger(config.windowMs) || config.windowMs <= 0) throw new Error('rateLimit.windowMs must be a positive safe integer');
    if (!Number.isSafeInteger(config.maxRequests) || config.maxRequests <= 0) throw new Error('rateLimit.maxRequests must be a positive safe integer');
    if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) throw new Error('rateLimit.maxEntries must be a positive safe integer');
    this.config = config;
  }

  consume(key: string, now = Date.now()): {allowed: boolean; retryAfterSeconds: number} {
    const existing = this.buckets.get(key);
    if (existing === undefined || now - existing.startedAt >= this.config.windowMs) {
      this.buckets.set(key, {startedAt: now, count: 1});
      this.trim();
      return {allowed: true, retryAfterSeconds: 0};
    }
    if (existing.count >= this.config.maxRequests) {
      return {allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.config.windowMs - (now - existing.startedAt)) / 1000))};
    }
    existing.count += 1;
    return {allowed: true, retryAfterSeconds: 0};
  }

  private trim(): void {
    while (this.buckets.size > this.config.maxEntries) {
      const first = this.buckets.keys().next().value;
      if (first === undefined) return;
      this.buckets.delete(first);
    }
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=()');
}

function normalizeAllowedOrigins(origins: readonly string[] | undefined): string[] {
  if (origins === undefined) return [];
  const normalized = origins.map((origin) => {
    const value = origin.trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('allowedOrigins must contain explicit http or https origins');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error('allowedOrigins must contain explicit http or https origins');
    }
    return parsed.origin;
  });
  return [...new Set(normalized)];
}

function normalizeRequestOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b(?:sk|rk|whsec)_[A-Za-z0-9_]+\b/g, '[redacted-secret]');
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
  const rateLimiter = new RateLimiter(options.rateLimit);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    const rate = rateLimiter.consume(request.socket.remoteAddress ?? 'unknown');
    if (!rate.allowed) {
      response.setHeader('retry-after', String(rate.retryAfterSeconds));
      sendJson(response, 429, {error: 'rate limit exceeded'});
      return;
    }
    const requestOrigin = typeof request.headers.origin === 'string' ? normalizeRequestOrigin(request.headers.origin) : undefined;
    if (request.headers.origin !== undefined && (requestOrigin === undefined || !allowedOrigins.includes(requestOrigin))) {
      sendJson(response, 403, {error: 'origin not allowed'});
      return;
    }
    if (requestOrigin !== undefined) {
      response.setHeader('access-control-allow-origin', requestOrigin);
      response.setHeader('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'authorization, content-type');
        response.statusCode = 204;
        response.setHeader('content-length', '0');
        response.end();
        return;
      }
    }
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
      } catch (error) {
        console.error(`Checkout request failed: ${safeErrorMessage(error)}`);
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
