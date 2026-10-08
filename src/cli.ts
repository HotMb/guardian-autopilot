#!/usr/bin/env node
import { scan } from './scanner.js';
import { buildInventory, writeInventory } from './inventory.js';
import { findAssetReferences } from './references.js';
import { planCandidates } from './candidates.js';
import { runCleanupTransaction } from './transaction.js';

const argumentsList = process.argv.slice(2);
const command = argumentsList.shift();
const target = argumentsList[0]?.startsWith('--') || argumentsList.length === 0 ? '.' : (argumentsList.shift() ?? '.');

if (command !== 'scan' && command !== 'inventory' && command !== 'references' && command !== 'plan' && command !== 'cleanup') {
  console.log('Guardian Autopilot\nUsage:\n  guardian scan [directory]\n  guardian inventory [directory]\n  guardian references [directory]\n  guardian plan [directory]\n  guardian cleanup [directory] [--apply] <tracked-file>...\nScan, references and plan are read-only; inventory writes only .guardian/index.json. Cleanup is a dry-run unless --apply is explicitly provided.');
  process.exit(command === undefined || command === '--help' ? 0 : 1);
}
try {
  if (command === 'inventory') {
    const result = await buildInventory(target);
    await writeInventory(target, result.index);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'references') {
    console.log(JSON.stringify(await findAssetReferences(target), null, 2));
  } else if (command === 'plan') {
    console.log(JSON.stringify(await planCandidates(target), null, 2));
  } else if (command === 'cleanup') {
    const apply = argumentsList.includes('--apply');
    const files = argumentsList.filter((argument) => argument !== '--apply');
    const result = await runCleanupTransaction(target, {files, dryRun: !apply});
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
