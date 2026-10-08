import {createHmac, timingSafeEqual} from 'node:crypto';

export type BillingPlan = 'free' | 'pro' | 'team';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';
export type Entitlement =
  | 'local_reports'
  | 'reversible_cleanup'
  | 'mcp_audit'
  | 'hosted_audits'
  | 'scheduled_reports'
  | 'multi_repo_history'
  | 'team_reporting'
  | 'shared_policies';

export type EntitlementSnapshot = {
  plan: BillingPlan;
  status: SubscriptionStatus;
  currentPeriodEnd?: number;
};

export type StripeSignatureVerification = {
  timestamp: number;
};

const planEntitlements: Record<BillingPlan, readonly Entitlement[]> = {
  free: ['local_reports', 'reversible_cleanup', 'mcp_audit'],
  pro: ['local_reports', 'reversible_cleanup', 'mcp_audit', 'hosted_audits', 'scheduled_reports', 'multi_repo_history'],
  team: ['local_reports', 'reversible_cleanup', 'mcp_audit', 'hosted_audits', 'scheduled_reports', 'multi_repo_history', 'team_reporting', 'shared_policies'],
};

const subscriptionStatuses = new Set<SubscriptionStatus>([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
]);

export function entitlementsForPlan(plan: BillingPlan): readonly Entitlement[] {
  return planEntitlements[plan];
}

export function hasEntitlement(snapshot: EntitlementSnapshot, entitlement: Entitlement, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (snapshot.status !== 'active' && snapshot.status !== 'trialing') return false;
  if (snapshot.currentPeriodEnd !== undefined && snapshot.currentPeriodEnd <= nowSeconds) return false;
  return planEntitlements[snapshot.plan].includes(entitlement);
}

export function normalizeEntitlementSnapshot(value: unknown): EntitlementSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Entitlement snapshot must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.plan !== 'free' && raw.plan !== 'pro' && raw.plan !== 'team') throw new Error('Entitlement plan is invalid');
  if (typeof raw.status !== 'string' || !subscriptionStatuses.has(raw.status as SubscriptionStatus)) throw new Error('Subscription status is invalid');
  if (raw.currentPeriodEnd !== undefined && (!Number.isSafeInteger(raw.currentPeriodEnd) || (raw.currentPeriodEnd as number) <= 0)) {
    throw new Error('currentPeriodEnd must be a positive safe integer');
  }
  return {
    plan: raw.plan,
    status: raw.status as SubscriptionStatus,
    ...(raw.currentPeriodEnd === undefined ? {} : {currentPeriodEnd: raw.currentPeriodEnd as number}),
  };
}

function parseSignatureHeader(header: string): {timestamp: number; signatures: string[]} {
  let timestamp;
  const signatures: string[] = [];
  for (const item of header.split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const prefix = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (prefix === 't' && timestamp === undefined) timestamp = Number.parseInt(value, 10);
    if (prefix === 'v1' && value !== '') signatures.push(value);
  }
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0 || signatures.length === 0) {
    throw new Error('Stripe-Signature header is missing a valid timestamp or v1 signature');
  }
  return {timestamp: timestamp as number, signatures};
}

function constantTimeHexEqual(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const receivedBytes = Buffer.from(received, 'hex');
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

export function verifyStripeWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string,
  endpointSecret: string,
  options: {nowSeconds?: number; toleranceSeconds?: number} = {},
): StripeSignatureVerification {
  if (endpointSecret.trim() === '') throw new Error('Stripe webhook endpoint secret is required');
  const {timestamp, signatures} = parseSignatureHeader(signatureHeader);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds <= 0) {
    throw new Error('Stripe signature verification timing options are invalid');
  }
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) throw new Error('Stripe webhook signature timestamp is outside the allowed tolerance');

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
  const expected = createHmac('sha256', endpointSecret).update(signedPayload).digest('hex');
  if (!signatures.some((signature) => constantTimeHexEqual(expected, signature))) throw new Error('Stripe webhook signature verification failed');
  return {timestamp};
}
