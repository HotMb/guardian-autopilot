import {checkoutConfigurationFromEnv} from './checkout.js';

export type PreflightCheck = {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
};

export type PreflightResult = {
  mode: 'local' | 'production';
  status: 'ready' | 'blocked';
  checks: PreflightCheck[];
};

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function add(checks: PreflightCheck[], id: string, status: PreflightCheck['status'], message: string): void {
  checks.push({id, status, message});
}

/** Validate deployment inputs without contacting Stripe, GitHub, or a cloud provider. */
export function runPreflight(env: NodeJS.ProcessEnv = process.env, production = false): PreflightResult {
  const checks: PreflightCheck[] = [];
  const mode = production ? 'production' : 'local';
  if (present(env.STRIPE_WEBHOOK_SECRET)) add(checks, 'stripe-webhook-secret', 'pass', 'Stripe webhook secret is configured.');
  else add(checks, 'stripe-webhook-secret', 'fail', 'STRIPE_WEBHOOK_SECRET is missing.');

  const stripeKey = env.STRIPE_SECRET_KEY?.trim();
  if (!present(stripeKey)) {
    add(checks, 'stripe-api-key', 'pass', 'Stripe API key is not configured; Checkout remains disabled.');
  } else if (/^(sk|rk)_live_/.test(stripeKey ?? '')) {
    add(checks, 'stripe-api-key', 'fail', 'A live Stripe key is configured; this project is test-only until launch approval.');
  } else if (/^(sk|rk)_test_/.test(stripeKey ?? '')) {
    add(checks, 'stripe-api-key', 'pass', 'Stripe API key is test-mode.');
  } else {
    add(checks, 'stripe-api-key', 'fail', 'STRIPE_SECRET_KEY must be a recognized Stripe test-mode key.');
  }

  if (present(stripeKey)) {
    try {
      checkoutConfigurationFromEnv(env);
      add(checks, 'checkout-configuration', 'pass', 'Checkout prices and return URLs are valid.');
    } catch (error) {
      add(checks, 'checkout-configuration', 'fail', error instanceof Error ? error.message : String(error));
    }
    const accessToken = env.STRIPE_CHECKOUT_ACCESS_TOKEN?.trim();
    if (accessToken === undefined || accessToken.length < 32) add(checks, 'checkout-access-token', 'fail', 'STRIPE_CHECKOUT_ACCESS_TOKEN must contain at least 32 characters.');
    else add(checks, 'checkout-access-token', 'pass', 'Checkout access token is configured with sufficient length.');
  } else if (present(env.STRIPE_CHECKOUT_ACCESS_TOKEN)) {
    add(checks, 'checkout-access-token', 'warn', 'Checkout token is present but Checkout is disabled because no Stripe API key is configured.');
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  const storePath = env.STRIPE_SUBSCRIPTION_STORE_PATH?.trim();
  if (databaseUrl !== undefined && databaseUrl !== '' && storePath !== undefined && storePath !== '') {
    add(checks, 'subscription-storage', 'fail', 'Set either DATABASE_URL or STRIPE_SUBSCRIPTION_STORE_PATH, not both.');
  } else if (databaseUrl !== undefined && databaseUrl !== '') {
    add(checks, 'subscription-storage', 'pass', 'PostgreSQL subscription storage is configured.');
  } else if (storePath !== undefined && storePath !== '') {
    add(checks, 'subscription-storage', production ? 'warn' : 'pass', production ? 'File storage is single-instance; use PostgreSQL for horizontal scaling.' : 'Durable single-process file storage is configured.');
  } else {
    add(checks, 'subscription-storage', production ? 'fail' : 'warn', production ? 'Production mode requires DATABASE_URL or a deliberately durable single-instance store.' : 'Subscription state is in memory and will be lost on restart.');
  }

  const host = env.HOST?.trim() || '127.0.0.1';
  if (production && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) add(checks, 'network-bind', 'fail', 'Production mode cannot bind only to localhost.');
  else add(checks, 'network-bind', 'pass', `${production ? 'Production' : 'Local'} mode binds to ${host}.`);

  const hasFailure = checks.some((check) => check.status === 'fail');
  return {mode, status: hasFailure ? 'blocked' : 'ready', checks};
}
