import {randomBytes} from 'node:crypto';
import Stripe from 'stripe';
import type {BillingPlan} from './billing.js';

export type PaidPlan = Exclude<BillingPlan, 'free'>;

export type CheckoutConfiguration = {
  secretKey: string;
  priceIds: Record<PaidPlan, string>;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSessionRequest = {
  plan: PaidPlan;
  customerEmail?: string;
  clientReferenceId?: string;
};

const paidPlans: readonly PaidPlan[] = ['pro', 'team'];

function requireUrl(value: string, field: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${field} must be an absolute URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${field} must use HTTP or HTTPS`);
  return parsed.toString();
}

function requireTestSecretKey(value: string): string {
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(value)) throw new Error('STRIPE_SECRET_KEY must be a Stripe test-mode secret or restricted key');
  return value;
}

function requirePriceId(value: string, field: string): string {
  if (!/^price_[A-Za-z0-9]+$/.test(value)) throw new Error(`${field} must be a Stripe price id`);
  return value;
}

export function checkoutConfigurationFromEnv(env: NodeJS.ProcessEnv = process.env): CheckoutConfiguration {
  const secretKey = requireTestSecretKey(env.STRIPE_SECRET_KEY ?? '');
  const priceIds = {
    pro: requirePriceId(env.STRIPE_PRICE_PRO ?? '', 'STRIPE_PRICE_PRO'),
    team: requirePriceId(env.STRIPE_PRICE_TEAM ?? '', 'STRIPE_PRICE_TEAM'),
  };
  return {
    secretKey,
    priceIds,
    successUrl: requireUrl(env.STRIPE_CHECKOUT_SUCCESS_URL ?? '', 'STRIPE_CHECKOUT_SUCCESS_URL'),
    cancelUrl: requireUrl(env.STRIPE_CHECKOUT_CANCEL_URL ?? '', 'STRIPE_CHECKOUT_CANCEL_URL'),
  };
}

export function createStripeClient(configuration: CheckoutConfiguration): Stripe {
  requireTestSecretKey(configuration.secretKey);
  return new Stripe(configuration.secretKey);
}

function integrationIdentifier(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const suffix = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
  return `guardian-autopilot-${suffix}`;
}

function successUrlWithSessionId(value: string): string {
  const url = new URL(value);
  url.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  return url.toString();
}

export async function createCheckoutSession(
  client: Stripe,
  configuration: CheckoutConfiguration,
  request: CheckoutSessionRequest,
): Promise<Stripe.Checkout.Session> {
  if (!paidPlans.includes(request.plan)) throw new Error('Checkout plan is invalid');
  const price = configuration.priceIds[request.plan];
  if (request.customerEmail !== undefined && (!request.customerEmail.includes('@') || request.customerEmail.length > 320)) throw new Error('customerEmail is invalid');
  if (request.clientReferenceId !== undefined && (request.clientReferenceId.trim() === '' || request.clientReferenceId.length > 200)) throw new Error('clientReferenceId is invalid');

  return client.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{price, quantity: 1}],
    success_url: successUrlWithSessionId(configuration.successUrl),
    cancel_url: configuration.cancelUrl,
    ...(request.customerEmail === undefined ? {} : {customer_email: request.customerEmail}),
    ...(request.clientReferenceId === undefined ? {} : {client_reference_id: request.clientReferenceId}),
    metadata: {guardian_plan: request.plan},
    subscription_data: {metadata: {guardian_plan: request.plan}},
    integration_identifier: integrationIdentifier(),
  });
}
