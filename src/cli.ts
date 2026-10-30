#!/usr/bin/env node
import { scan } from './scanner.js';
import { buildInventory, writeInventory } from './inventory.js';
import { findAssetReferences } from './references.js';
import { planCandidates } from './candidates.js';
import { runCleanupTransaction } from './transaction.js';
import { serveMcp } from './mcp.js';
import { createBillingWebhookServer } from './server.js';
import {createGitHubAppJwt} from './github.js';
import {GitHubInstallationClient} from './github-installation.js';
import {PostgresGitHubAuditQueue} from './github-audit-queue.js';
import {processGitHubAuditJob} from './github-audit.js';
import {startGitHubAuditWorker} from './github-audit-worker.js';
import { FileSubscriptionStore, MemorySubscriptionStore } from './subscriptions.js';
import { PostgresSubscriptionStore } from './postgres-subscriptions.js';
import { checkoutConfigurationFromEnv, createStripeClient } from './checkout.js';
import { runPreflight } from './preflight.js';

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

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

const argumentsList = process.argv.slice(2);
const command = argumentsList.shift();
const target = argumentsList[0]?.startsWith('--') || argumentsList.length === 0 ? '.' : (argumentsList.shift() ?? '.');

if (command !== 'scan' && command !== 'inventory' && command !== 'references' && command !== 'plan' && command !== 'cleanup' && command !== 'mcp' && command !== 'webhook' && command !== 'preflight') {
  console.log('Guardian Autopilot\nUsage:\n  guardian scan [directory]\n  guardian inventory [directory]\n  guardian references [directory]\n  guardian plan [directory]\n  guardian cleanup [directory] [--apply] [--check <command>] [--check-json <json>] <tracked-file>...\n  guardian mcp\n  guardian webhook\n  guardian preflight [--production]\nScan, references and plan are read-only; inventory writes only .guardian/index.json. Cleanup is a dry-run unless --apply is explicitly provided. MCP exposes read-only tools only. Webhook listens on HOST/PORT (defaults 127.0.0.1:8787), requires STRIPE_WEBHOOK_SECRET, and optionally verifies GitHub deliveries with GITHUB_WEBHOOK_SECRET. Preflight only validates local configuration and never creates cloud resources.');
  process.exit(command === undefined || command === '--help' ? 0 : 1);
}
try {
  if (command === 'mcp') {
    await serveMcp();
  } else if (command === 'preflight') {
    const result = runPreflight(process.env, argumentsList.includes('--production'));
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'blocked') process.exitCode = 1;
  } else if (command === 'webhook') {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is required');
    const port = Number.parseInt(process.env.PORT ?? '8787', 10);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid TCP port');
    const host = process.env.HOST?.trim() || '127.0.0.1';
    const checkoutEnabled = process.env.STRIPE_SECRET_KEY !== undefined;
    const checkoutConfiguration = checkoutEnabled ? checkoutConfigurationFromEnv() : undefined;
    const stripeClient = checkoutConfiguration === undefined ? undefined : createStripeClient(checkoutConfiguration);
    const checkoutAccessToken = process.env.STRIPE_CHECKOUT_ACCESS_TOKEN?.trim();
    const corsOriginsValue = process.env.CORS_ORIGINS?.trim();
    const allowedOrigins = corsOriginsValue === undefined || corsOriginsValue === '' ? undefined : corsOriginsValue.split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
    const storePath = process.env.STRIPE_SUBSCRIPTION_STORE_PATH?.trim();
    const databaseUrl = process.env.DATABASE_URL?.trim();
    const databaseMaxConnections = optionalPositiveInteger(process.env.DATABASE_MAX_CONNECTIONS, 'DATABASE_MAX_CONNECTIONS');
    const githubValues = [process.env.GITHUB_INSTALLATION_ID, process.env.GITHUB_REPOSITORY_ID, process.env.GITHUB_REPOSITORY_OWNER, process.env.GITHUB_REPOSITORY_NAME, process.env.GITHUB_API_ACCESS_TOKEN];
    const githubConfiguredCount = githubValues.filter((value) => value?.trim() !== undefined && value.trim() !== '').length;
    if (githubConfiguredCount !== 0 && githubConfiguredCount !== githubValues.length) throw new Error('GitHub repository metadata access configuration is incomplete');
    const githubAppId = process.env.GITHUB_APP_ID?.trim();
    const githubPrivateKeyValue = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
    if ((githubAppId === undefined || githubAppId === '') !== (githubPrivateKeyValue === undefined || githubPrivateKeyValue === '')) throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured together');
    if (githubConfiguredCount > 0 && (githubAppId === undefined || githubAppId === '' || githubPrivateKeyValue === undefined || githubPrivateKeyValue === '')) throw new Error('GitHub repository metadata access requires the GitHub App id and private key');
    const githubInstallationId = githubConfiguredCount === 0 ? undefined : Number(process.env.GITHUB_INSTALLATION_ID);
    const githubRepositoryId = githubConfiguredCount === 0 ? undefined : Number(process.env.GITHUB_REPOSITORY_ID);
    if (githubConfiguredCount > 0 && (!Number.isSafeInteger(githubInstallationId) || !Number.isSafeInteger(githubRepositoryId) || (githubInstallationId ?? 0) <= 0 || (githubRepositoryId ?? 0) <= 0)) throw new Error('GitHub installation and repository ids must be positive safe integers');
    const githubPrivateKey = githubPrivateKeyValue?.replace(/\\n/g, '\n');
    const githubAccessToken = process.env.GITHUB_API_ACCESS_TOKEN?.trim();
    const githubOwner = process.env.GITHUB_REPOSITORY_OWNER?.trim();
    const githubName = process.env.GITHUB_REPOSITORY_NAME?.trim();
    const githubClient = githubConfiguredCount === 0 ? undefined : new GitHubInstallationClient({
      installationId: githubInstallationId as number,
      repositoryId: githubRepositoryId as number,
      createJwt: () => createGitHubAppJwt(githubAppId as string, githubPrivateKey as string),
    });
    if (databaseUrl && storePath) throw new Error('Set either DATABASE_URL or STRIPE_SUBSCRIPTION_STORE_PATH, not both');
    const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
    const auditConfigured = githubWebhookSecret !== undefined && githubWebhookSecret !== '';
    if (auditConfigured && (githubAppId === undefined || githubAppId === '' || githubPrivateKey === undefined || githubPrivateKey.trim() === '' || databaseUrl === undefined || databaseUrl === '')) {
      throw new Error('Automatic GitHub audits require GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET and DATABASE_URL');
    }
    if (auditConfigured && databaseMaxConnections !== undefined && databaseMaxConnections < 2) throw new Error('DATABASE_MAX_CONNECTIONS must be at least 2 when GitHub audits and PostgreSQL subscriptions share the service');
    const auditQueue = auditConfigured ? new PostgresGitHubAuditQueue({
      connectionString: databaseUrl,
      maxConnections: 1,
      maxAttempts: 3,
    }) : undefined;
    const subscriptionConnections = auditConfigured
      ? Math.max(1, (databaseMaxConnections ?? 3) - 1)
      : databaseMaxConnections;
    const postgresStore = databaseUrl === undefined || databaseUrl === '' ? undefined : new PostgresSubscriptionStore({connectionString: databaseUrl, ...(subscriptionConnections === undefined ? {} : {maxConnections: subscriptionConnections})});
    if (postgresStore !== undefined) await postgresStore.initialize();
    if (auditQueue !== undefined) await auditQueue.initialize();
    const store = postgresStore ?? (storePath === undefined || storePath === '' ? new MemorySubscriptionStore() : new FileSubscriptionStore(storePath));
    const server = createBillingWebhookServer({
      endpointSecret: secret,
      ...(githubWebhookSecret === undefined || githubWebhookSecret === '' ? {} : {githubWebhookSecret}),
      ...(auditQueue === undefined ? {} : {githubAuditEnqueue: (job) => auditQueue.enqueue(job)}),
      ...(githubClient === undefined || githubAccessToken === undefined || githubOwner === undefined || githubName === undefined ? {} : {githubClient, githubAccessToken, githubRepository: {owner: githubOwner, name: githubName}}),
      store,
      ...(allowedOrigins === undefined ? {} : {allowedOrigins}),
      ...(stripeClient === undefined || checkoutConfiguration === undefined || checkoutAccessToken === undefined || checkoutAccessToken === '' ? {} : {stripeClient, checkoutConfiguration, checkoutAccessToken}),
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        console.error(`Guardian webhook listening on http://${host}:${port}/webhooks/stripe`);
        resolve();
      });
    });
    const auditWorker = auditQueue === undefined || githubAppId === undefined || githubPrivateKey === undefined
      ? undefined
      : startGitHubAuditWorker(auditQueue, (job, saveCheckRunId) => processGitHubAuditJob(job, (item) => new GitHubInstallationClient({
        installationId: item.installationId,
        repositoryId: item.repositoryId,
        createJwt: () => createGitHubAppJwt(githubAppId, githubPrivateKey),
      }), saveCheckRunId));
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await auditWorker?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await auditQueue?.close();
      await postgresStore?.close();
    };
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
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
