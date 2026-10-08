#!/usr/bin/env node
import { scan } from './scanner.js';
import { buildInventory, writeInventory } from './inventory.js';
import { findAssetReferences } from './references.js';
import { planCandidates } from './candidates.js';
import { runCleanupTransaction } from './transaction.js';
import { serveMcp } from './mcp.js';
import { createBillingWebhookServer } from './server.js';
import { MemorySubscriptionStore } from './subscriptions.js';
import { checkoutConfigurationFromEnv, createStripeClient } from './checkout.js';

function cleanupArguments(values: string[]): {apply: boolean; files: string[]; checks: Array<{command: string; args?: string[]}>} {
  const files: string[] = [];
  const checks: Array<{command: string; args?: string[]}> = [];
  let apply = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--apply') {
      apply = true;
      continue;
    }
    if (value === '--check' || value === '--check-json') {
      const raw = values[++index];
      if (!raw) throw new Error(`${value} requires a value`);
      if (value === '--check') {
        checks.push({command: raw});
        continue;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (error) {
        throw new Error(`--check-json must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--check-json must be an object');
      const check = parsed as {command?: unknown; args?: unknown};
      if (typeof check.command !== 'string' || check.command.trim() === '' || (check.args !== undefined && (!Array.isArray(check.args) || !check.args.every((arg) => typeof arg === 'string')))) {
        throw new Error('--check-json requires {"command":"...","args":["..."]}');
      }
      checks.push({command: check.command, args: check.args as string[] | undefined});
      continue;
    }
    if (value.startsWith('--')) throw new Error(`Unknown cleanup option: ${value}`);
    files.push(value);
  }
  return {apply, files, checks};
}

const argumentsList = process.argv.slice(2);
const command = argumentsList.shift();
const target = argumentsList[0]?.startsWith('--') || argumentsList.length === 0 ? '.' : (argumentsList.shift() ?? '.');

if (command !== 'scan' && command !== 'inventory' && command !== 'references' && command !== 'plan' && command !== 'cleanup' && command !== 'mcp' && command !== 'webhook') {
  console.log('Guardian Autopilot\nUsage:\n  guardian scan [directory]\n  guardian inventory [directory]\n  guardian references [directory]\n  guardian plan [directory]\n  guardian cleanup [directory] [--apply] [--check <command>] [--check-json <json>] <tracked-file>...\n  guardian mcp\n  guardian webhook\nScan, references and plan are read-only; inventory writes only .guardian/index.json. Cleanup is a dry-run unless --apply is explicitly provided. MCP exposes read-only tools only. Webhook listens on PORT (default 8787) and requires STRIPE_WEBHOOK_SECRET.');
  process.exit(command === undefined || command === '--help' ? 0 : 1);
}
try {
  if (command === 'mcp') {
    await serveMcp();
  } else if (command === 'webhook') {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is required');
    const port = Number.parseInt(process.env.PORT ?? '8787', 10);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid TCP port');
    const checkoutEnabled = process.env.STRIPE_SECRET_KEY !== undefined;
    const checkoutConfiguration = checkoutEnabled ? checkoutConfigurationFromEnv() : undefined;
    const stripeClient = checkoutConfiguration === undefined ? undefined : createStripeClient(checkoutConfiguration);
    const server = createBillingWebhookServer({
      endpointSecret: secret,
      store: new MemorySubscriptionStore(),
      ...(stripeClient === undefined || checkoutConfiguration === undefined ? {} : {stripeClient, checkoutConfiguration}),
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        console.error(`Guardian webhook listening on http://127.0.0.1:${port}/webhooks/stripe`);
        resolve();
      });
    });
  } else if (command === 'inventory') {
    const result = await buildInventory(target);
    await writeInventory(target, result.index);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'references') {
    console.log(JSON.stringify(await findAssetReferences(target), null, 2));
  } else if (command === 'plan') {
    console.log(JSON.stringify(await planCandidates(target), null, 2));
  } else if (command === 'cleanup') {
    const {apply, files, checks} = cleanupArguments(argumentsList);
    const result = await runCleanupTransaction(target, {files, checks, dryRun: !apply});
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'rolled-back' || result.status === 'failed') process.exitCode = 1;
  } else {
    const result = await scan(target);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (err) {
  console.error('Guardian scan failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
