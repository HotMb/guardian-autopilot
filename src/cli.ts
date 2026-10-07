#!/usr/bin/env node
import { scan } from './scanner.js';
import { buildInventory, writeInventory } from './inventory.js';
import { findAssetReferences } from './references.js';
import { planCandidates } from './candidates.js';
const [command, target = '.'] = process.argv.slice(2);
if (command !== 'scan' && command !== 'inventory' && command !== 'references' && command !== 'plan') {
  console.log('Guardian Autopilot\nUsage:\n  guardian scan [directory]\n  guardian inventory [directory]\n  guardian references [directory]\n  guardian plan [directory]\nScan, references and plan are read-only; inventory writes only .guardian/index.json.');
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
  } else {
    const result = await scan(target);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (err) {
  console.error('Guardian scan failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
