import {entitlementSnapshotFromStripeEvent, verifyStripeWebhookSignature, type EntitlementSnapshot} from './billing.js';
import type {SubscriptionStore} from './subscriptions.js';

type StripeEventEnvelope = {
  id?: unknown;
  created?: unknown;
  type?: unknown;
  data?: {object?: {id?: unknown; customer?: unknown}};
};

export type StripeWebhookResult = {
  status: 'updated' | 'duplicate' | 'ignored';
  eventId: string;
  timestamp: number;
  subscriptionId?: string;
  snapshot?: EntitlementSnapshot;
};

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function asRequiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value;
}

function parseJsonBody(rawBody: string | Uint8Array): StripeEventEnvelope {
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Stripe webhook body is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return asObject(parsed, 'Stripe webhook body must be an object') as StripeEventEnvelope;
}

function eventCreatedAt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('Stripe event created timestamp is invalid');
  return value as number;
}

/**
 * Verify and apply a Stripe subscription webhook without depending on a web
 * framework or the Stripe SDK. The raw body must be passed unchanged.
 */
export function processStripeSubscriptionWebhook(
  rawBody: string | Uint8Array,
  signatureHeader: string,
  endpointSecret: string,
  store: SubscriptionStore,
  options: {nowSeconds?: number; toleranceSeconds?: number} = {},
): StripeWebhookResult {
  const verification = verifyStripeWebhookSignature(rawBody, signatureHeader, endpointSecret, options);
  const event = parseJsonBody(rawBody);
  const eventId = asRequiredIdentifier(event.id, 'Stripe event id');
  const type = asRequiredIdentifier(event.type, 'Stripe event type');
  const snapshot = entitlementSnapshotFromStripeEvent(event);
  if (snapshot === null) return {status: 'ignored', eventId, timestamp: verification.timestamp};

  const data = asObject(event.data, 'Stripe event data is required');
  const subscription = asObject(data.object, 'Stripe subscription object is required');
  const subscriptionId = asRequiredIdentifier(subscription.id, 'Stripe subscription id');
  const customerId = subscription.customer === undefined ? undefined : asRequiredIdentifier(subscription.customer, 'Stripe customer id');
  const record = {
    subscriptionId,
    ...(customerId === undefined ? {} : {customerId}),
    eventId,
    updatedAt: eventCreatedAt(event.created, verification.timestamp),
    snapshot,
  };
  const status = store.apply(eventId, record);
  return {status: status === 'duplicate' ? 'duplicate' : 'updated', eventId, timestamp: verification.timestamp, subscriptionId, snapshot};
}
