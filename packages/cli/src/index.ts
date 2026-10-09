#!/usr/bin/env node
import {buildReferenceGraph, discoverRepository, planRepository} from '../../core/dist/index.js';

type OutputFormat = 'text' | 'json';

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

function format(args: string[]): OutputFormat {
  const inline = args.find((value) => value.startsWith('--format='));
  return (inline?.slice('--format='.length) ?? optionValue(args, '--format')) === 'json' ? 'json' : 'text';
}

function targetRoot(args: string[]): string {
  return args.find((value) => !value.startsWith('--') && value !== optionValue(args, '--format')) ?? '.';
}

function printUsage(): void {
  console.error('Usage: cleancode <discover|analyze|plan> [root] [--format=json]');
}

export async function runCli(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (command === undefined || command === '--help') {
    printUsage();
    return command === '--help' ? 0 : 1;
  }
  if (!['discover', 'analyze', 'plan'].includes(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }

  const values = [...args.slice(1)];
  const root = targetRoot(values);
  const outputFormat = format(values);
  if (command === 'discover') {
    const result = await discoverRepository(root);
    if (outputFormat === 'json') console.log(JSON.stringify({...result, mode: 'read-only'}, null, 2));
    else {
      console.log(`✓ ${result.files.length} files scanned`);
      if (result.errors.length > 0) console.log(`! ${result.errors.length} unreadable paths`);
      console.log('→ run `cleancode analyze` to inspect references');
    }
    return 0;
  }
  if (command === 'analyze') {
    const result = await buildReferenceGraph(root);
    if (outputFormat === 'json') console.log(JSON.stringify({...result, mode: 'read-only'}, null, 2));
    else {
      console.log(`✓ ${result.edges.length} local references resolved`);
      if (result.unresolved.length > 0) console.log(`! ${result.unresolved.length} local references unresolved`);
      console.log('→ run `cleancode plan` to review candidates');
    }
    return 0;
  }
  const result = await planRepository(root, {knipExecutable: optionValue(values, '--knip')});
  if (outputFormat === 'json') console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`✓ ${result.manifest.files.length} files scanned`);
    console.log(`✓ ${result.candidates.length} review-only candidates`);
    for (const candidate of result.candidates) {
      const status = candidate.decision.allowed ? 'eligible after approval' : 'blocked by safeguards';
      console.log(`→ ${candidate.path} (${candidate.kind}; ${status})`);
    }
  }
  return 0;
}

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
