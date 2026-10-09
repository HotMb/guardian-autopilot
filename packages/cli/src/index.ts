#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {AuditLog, buildReferenceGraph, discoverRepository, executeCleanup, planRepository, renderReport, type ReportFormat, type VerificationConfig} from '@cleancode/core';
import {verifyLicense} from '@cleancode/license';
import {CleanCodeError, isCleanCodeError} from '@cleancode/shared/errors';
import type {Candidate, Evidence} from '@cleancode/shared/types';
import {serveMcp} from './mcp.js';

type OutputFormat = 'text' | 'json';

function optionValue(args: string[], option: string): string | undefined {
  const inline = args.find((value) => value.startsWith(`${option}=`));
  if (inline !== undefined) return inline.slice(option.length + 1);
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

function format(args: string[]): OutputFormat {
  const inline = args.find((value) => value.startsWith('--format='));
  return (inline?.slice('--format='.length) ?? optionValue(args, '--format')) === 'json' ? 'json' : 'text';
}

function targetRoot(args: string[]): string {
  const valueOptions = new Set(['--format', '--knip', '--candidates-file', '--verification-file', '--audit-file', '--receipt-directory', '--output']);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--dry-run' || value.startsWith('--')) {
      if (valueOptions.has(value)) index += 1;
      continue;
    }
    return value;
  }
  return '.';
}

function printUsage(): void {
  console.error('Usage: cleancode <discover|analyze|plan|apply|report> [root] [options]');
  console.error('  apply --dry-run [--candidates-file file] [--format=json]');
  console.error('  apply --candidates-file file [--verification-file file] [--format=json]');
  console.error('  report [--format=json|md|html] [--output file]');
  console.error('  license <activate|status> --license-file file --public-key-file file [--output file]');
  console.error('  mcp');
}

function reportFormat(args: string[]): ReportFormat {
  const value = optionValue(args, '--format') ?? 'md';
  if (value === 'json') return 'json';
  if (value === 'html') return 'html';
  if (value === 'md' || value === 'markdown' || value === 'text') return 'markdown';
  throw new Error(`Unsupported report format: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCandidates(value: unknown): Array<Pick<Candidate, 'path' | 'evidence'>> {
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.candidates) ? value.candidates : undefined;
  if (entries === undefined) throw new Error('Candidates file must contain an array or a candidates array');
  return entries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !Array.isArray(entry.evidence)) {
      throw new Error(`Invalid candidate at index ${index}`);
    }
    const evidence: Evidence[] = entry.evidence.map((item, evidenceIndex) => {
      if (!isRecord(item) || typeof item.type !== 'string' || typeof item.confidence !== 'number') {
        throw new Error(`Invalid evidence at candidate ${index}, item ${evidenceIndex}`);
      }
      return {type: item.type as Evidence['type'], confidence: item.confidence, details: typeof item.details === 'string' ? item.details : undefined};
    });
    return {path: entry.path, evidence};
  });
}

async function loadCandidates(args: string[], root: string): Promise<Array<Pick<Candidate, 'path' | 'evidence'>>> {
  const file = optionValue(args, '--candidates-file');
  if (file !== undefined) return parseCandidates(JSON.parse(await readFile(file, 'utf8')));
  const plan = await planRepository(root, {knipExecutable: optionValue(args, '--knip')});
  return plan.candidates.filter((candidate) => candidate.decision.allowed).map((candidate) => ({path: candidate.path, evidence: candidate.evidence}));
}

async function loadVerification(args: string[]): Promise<VerificationConfig> {
  const file = optionValue(args, '--verification-file');
  if (file !== undefined) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(value)) throw new Error('Verification file must contain an object');
    return value as VerificationConfig;
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return {
    build: {command: npm, args: ['run', 'build']},
    typecheck: {command: npm, args: ['run', 'typecheck']},
    test: {command: npm, args: ['test']},
    requireAll: true,
  };
}

async function runLicenseCommand(args: string[]): Promise<number> {
  const action = args[0];
  if (action !== 'activate' && action !== 'status') throw new Error('Usage: cleancode license <activate|status> --license-file file --public-key-file file [--output file]');
  const licenseFile = optionValue(args, '--license-file');
  const publicKeyFile = optionValue(args, '--public-key-file');
  const license = optionValue(args, '--license') ?? (licenseFile === undefined ? undefined : (await readFile(licenseFile, 'utf8')).trim());
  if (license === undefined || license === '') throw new CleanCodeError('INVALID_LICENSE', 'A license key or --license-file is required');
  if (publicKeyFile === undefined) throw new CleanCodeError('INVALID_LICENSE', '--public-key-file is required');
  const payload = verifyLicense(license, await readFile(publicKeyFile, 'utf8'));
  if (payload === null) throw new CleanCodeError('INVALID_LICENSE', 'License signature or expiration is invalid');
  if (action === 'activate') {
    const output = optionValue(args, '--output');
    if (output !== undefined) await writeFile(output, `${license}\n`, {encoding: 'utf8', flag: 'wx'});
  }
  if (format(args) === 'json') console.log(JSON.stringify(payload, null, 2));
  else console.log(`✓ ${payload.plan} license for ${payload.org}, ${payload.seats} seat(s), expires ${new Date(payload.exp * 1000).toISOString()}`);
  return 0;
}

export async function runCli(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (command === undefined || command === '--help') {
    printUsage();
    return command === '--help' ? 0 : 1;
  }
  if (command === 'license') return runLicenseCommand(args.slice(1));
  if (command === 'mcp') { await serveMcp(); return 0; }
  if (!['discover', 'analyze', 'plan', 'apply', 'report'].includes(command)) {
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
  if (command === 'report') {
    const report = renderReport(await planRepository(root, {knipExecutable: optionValue(values, '--knip')}), reportFormat(values));
    const output = optionValue(values, '--output');
    if (output === undefined) process.stdout.write(report);
    else await writeFile(output, report, 'utf8');
    return 0;
  }
  if (command === 'apply') {
    const candidates = await loadCandidates(values, root);
    const dryRun = values.includes('--dry-run');
    const result = await executeCleanup({
      rootDir: root,
      candidates,
      dryRun,
      verification: dryRun ? undefined : await loadVerification(values),
      auditLog: dryRun ? undefined : optionValue(values, '--audit-file') === undefined ? undefined : new AuditLog(optionValue(values, '--audit-file') as string),
      receiptDirectory: optionValue(values, '--receipt-directory'),
    });
    if (outputFormat === 'json') console.log(JSON.stringify(result, null, 2));
    else if (result.mode === 'dry-run') {
      console.log(`✓ dry-run: ${result.files} file(s), ${result.lines} line(s), ${result.bytes} byte(s)`);
      for (const path of result.changedPaths) console.log(`→ would delete ${path}`);
    } else if (result.state === 'COMMITTED') {
      console.log(`✓ committed ${result.changedPaths.length} file(s) in ${result.commit}`);
    } else {
      console.error(`! cleanup rolled back: ${result.error ?? 'verification failed'}`);
    }
    return result.state === 'COMMITTED' || result.mode === 'dry-run' ? 0 : 5;
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
  process.exitCode = isCleanCodeError(error) ? error.exitCode : 1;
}
