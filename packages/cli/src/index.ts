#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {AuditLog, buildReferenceGraph, discoverRepository, executeCleanup, executeCleanupExperiment, planRepository, renderReport, type ReportFormat, type VerificationConfig} from '@cleancode/core';
import {verifyLicense} from '@cleancode/license';
import {CleanCodeError, isCleanCodeError} from '@cleancode/shared/errors';
import type {Candidate, Evidence} from '@cleancode/shared/types';
import {serveMcp} from './mcp.js';
import {cloneGitHubRepository, summarizeUnresolvedReferences} from './github.js';

type OutputFormat = 'text' | 'json';
const evidenceTypes = new Set<Evidence['type']>([
  'no_import_references',
  'no_dynamic_references',
  'not_in_public_api',
  'not_in_package_json_exports',
  'no_string_reference_in_repo',
  'positive_proof',
]);

function optionValue(args: string[], option: string): string | undefined {
  const inline = args.find((value) => value.startsWith(`${option}=`));
  if (inline !== undefined) return inline.slice(option.length + 1);
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(`${option}=`)) values.push(value.slice(option.length + 1));
    else if (value === option) {
      const next = args[index + 1];
      values.push(next === undefined || next.startsWith('--') ? '' : next);
      if (next !== undefined && !next.startsWith('--')) index += 1;
    }
  }
  return values;
}

function format(args: string[]): OutputFormat {
  const inline = args.find((value) => value.startsWith('--format='));
  return (inline?.slice('--format='.length) ?? optionValue(args, '--format')) === 'json' ? 'json' : 'text';
}

function targetRoot(args: string[]): string {
  const valueOptions = new Set(['--format', '--knip', '--candidates-file', '--verification-file', '--audit-file', '--receipt-directory', '--output', '--path', '--max-candidates']);
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
  console.error('Usage: cleancode <discover|analyze|plan|experiment|apply|report> [root] [options]');
  console.error('  github analyze <owner/repository> --destination <new-local-path> [--format=json]');
  console.error('  experiment <root> --path <relative-path> [--path <relative-path> ...] --verification-file checks.json');
  console.error('  experiment <root> --candidates-file paths.json --verification-file checks.json');
  console.error('  experiment <root> --from-plan [--max-candidates 1..3] --verification-file checks.json');
  console.error('  apply --dry-run [--candidates-file file] [--format=json]');
  console.error('  experiment creates only a local review branch; it never pushes or merges');
  console.error('  real CleanCode apply still requires engine-verified positive proof');
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
      if (!evidenceTypes.has(item.type as Evidence['type']) || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 || (item.details !== undefined && typeof item.details !== 'string')) {
        throw new Error(`Invalid candidate evidence at candidate ${index}, item ${evidenceIndex}`);
      }
      if (item.type === 'positive_proof') {
        throw new Error('Candidate files cannot assert positive_proof; only engine-verified positive proof is accepted');
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

async function loadExperimentPaths(args: string[]): Promise<string[]> {
  const file = optionValue(args, '--candidates-file');
  const paths = optionValues(args, '--path');
  if (file !== undefined && paths.length > 0) throw new CleanCodeError('POLICY_VIOLATION', 'Use either repeated --path options or --candidates-file, not both');
  if (paths.length > 0) {
    if (paths.some((path) => path.trim() === '')) throw new CleanCodeError('POLICY_VIOLATION', '--path requires a non-empty relative file path');
    return paths;
  }
  if (file === undefined) throw new CleanCodeError('POLICY_VIOLATION', 'Experiment requires at least one --path or a candidates file with a paths array');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(value) || !Array.isArray(value.paths) || value.paths.length === 0 || value.paths.some((path) => typeof path !== 'string' || path.trim() === '')) {
    throw new CleanCodeError('POLICY_VIOLATION', 'Experiment candidates file must contain a non-empty paths array of relative file paths');
  }
  return value.paths as string[];
}

function experimentLimit(args: string[]): number {
  const value = optionValue(args, '--max-candidates');
  if (value === undefined) return 1;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) {
    throw new CleanCodeError('POLICY_VIOLATION', '--max-candidates must be an integer from 1 to 3');
  }
  return limit;
}

function autonomousCandidates(plan: Awaited<ReturnType<typeof planRepository>>): {candidates: typeof plan.candidates; skippedReason?: string} {
  if (plan.dynamicHints.length > 0) return {candidates: [], skippedReason: 'Dynamic runtime-use hints were found; automatic candidate selection was skipped'};
  if (plan.knip.status === 'failed') return {candidates: [], skippedReason: 'The optional Knip analysis failed; automatic candidate selection was skipped'};
  const candidates = plan.candidates.filter((candidate) =>
    candidate.kind === 'unreferenced-file'
    && candidate.evidence.length === 1
    && candidate.evidence[0]?.type === 'no_import_references'
    && candidate.evidence[0].confidence >= 0.95
    && candidate.decision.reasons.some((reason) => /lacks engine-verified positive proof/i.test(reason))
    && candidate.decision.reasons.every((reason) =>
      /lacks engine-verified positive proof/i.test(reason)
      || /^Candidate confidence [\d.]+ is below 0\.95$/.test(reason),
    ),
  );
  return {candidates, ...(candidates.length === 0 ? {skippedReason: 'No conservative, unreferenced source files are eligible for an isolated experiment'} : {})};
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
  if (command === 'github') {
    const action = args[1];
    if (action !== 'analyze') throw new Error('Usage: cleancode github analyze <owner/repository> --destination <new-local-path> [--format=json]');
    const repository = args[2] ?? '';
    const destination = optionValue(args.slice(3), '--destination');
    if (destination === undefined) throw new Error('An explicit --destination path is required; existing paths are never overwritten.');
    const localPath = await cloneGitHubRepository(repository, destination);
    const [files, graph] = await Promise.all([discoverRepository(localPath), buildReferenceGraph(localPath)]);
    const unresolved = summarizeUnresolvedReferences(graph.unresolved);
    const summary = {
      repository,
      localPath,
      mode: 'local-read-only',
      filesScanned: files.files.length,
      referencesResolved: graph.edges.length,
      ...unresolved,
      sourceUploaded: false,
    };
    if (format(args.slice(3)) === 'json') console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`✓ ${repository} cloned and analyzed locally`);
      console.log(`✓ ${summary.filesScanned} files scanned; ${summary.referencesResolved} local references resolved`);
      console.log(`✓ ${summary.unresolvedReferences} unresolved source references`);
      if (summary.unresolvedGeneratedOutputReferences > 0) console.log(`ℹ ${summary.unresolvedGeneratedOutputReferences} test references point to generated build files not included in the clone`);
      else if (summary.unresolvedTestReferences > 0) console.log(`! ${summary.unresolvedTestReferences} unresolved test references`);
      console.log('✓ No source code was uploaded; no project commands were executed');
    }
    return 0;
  }
  if (!['discover', 'analyze', 'plan', 'experiment', 'apply', 'report'].includes(command)) {
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
  if (command === 'experiment') {
    const fromPlan = values.includes('--from-plan');
    const explicitPaths = optionValues(values, '--path');
    const candidatesFile = optionValue(values, '--candidates-file');
    const limitOption = optionValue(values, '--max-candidates');
    if (fromPlan && (explicitPaths.length > 0 || candidatesFile !== undefined)) throw new CleanCodeError('POLICY_VIOLATION', '--from-plan cannot be combined with --path or --candidates-file');
    if (!fromPlan && limitOption !== undefined) throw new CleanCodeError('POLICY_VIOLATION', '--max-candidates is only valid with --from-plan');
    const verificationFile = optionValue(values, '--verification-file');
    if (verificationFile === undefined) throw new CleanCodeError('POLICY_VIOLATION', 'Experiment requires --verification-file with build, typecheck, and test commands');
    const verification = await loadVerification(values);
    if (fromPlan) {
      const limit = experimentLimit(values);
      const plan = await planRepository(root, {knipExecutable: optionValue(values, '--knip')});
      const selection = autonomousCandidates(plan);
      const selected = selection.candidates.slice(0, limit);
      const experiments = [];
      for (const candidate of selected) {
        const result = await executeCleanupExperiment({rootDir: root, paths: [candidate.path], verification, receiptDirectory: optionValue(values, '--receipt-directory')});
        experiments.push({candidateId: candidate.id, path: candidate.path, result});
      }
      const batch = {mode: 'experiment-batch', availableCandidates: selection.candidates.length, attempted: experiments.length, ...(selection.skippedReason === undefined ? {} : {skippedReason: selection.skippedReason}), experiments};
      if (outputFormat === 'json') console.log(JSON.stringify(batch, null, 2));
      else if (experiments.length === 0) console.log(`ℹ No automatic experiment started: ${selection.skippedReason ?? 'no eligible candidates'}`);
      else {
        console.log(`✓ ${experiments.length} of ${selection.candidates.length} conservative candidate(s) tested independently`);
        for (const experiment of experiments) {
          if (experiment.result.state === 'COMMITTED') console.log(`✓ ${experiment.path} → local review branch ${experiment.result.reviewBranchName}`);
          else console.log(`↩ ${experiment.path} → checks failed; experiment rolled back`);
        }
        console.log('! Review successful branches manually. Guardian did not push or merge.');
      }
      return experiments.every((experiment) => experiment.result.state === 'COMMITTED') ? 0 : experiments.length === 0 ? 0 : 5;
    }
    const paths = await loadExperimentPaths(values);
    const result = await executeCleanupExperiment({
      rootDir: root,
      paths,
      approveLargeChange: values.includes('--approve-large-change'),
      verification,
      receiptDirectory: optionValue(values, '--receipt-directory'),
    });
    if (outputFormat === 'json') console.log(JSON.stringify(result, null, 2));
    else if (result.state === 'COMMITTED') {
      console.log(`✓ experiment verified; local review branch: ${result.reviewBranchName}`);
      console.log(`→ ${result.changedPaths.length} file(s) changed in the experiment; source branch was not modified`);
      console.log('! Review the branch diff before merging manually. Guardian did not push or merge.');
    } else {
      console.error(`! experiment rolled back: ${result.error ?? 'verification failed'}`);
    }
    return result.state === 'COMMITTED' ? 0 : 5;
  }
  if (command === 'apply') {
    const dryRun = values.includes('--dry-run');
    if (!dryRun && optionValue(values, '--candidates-file') === undefined) {
      throw new CleanCodeError('POLICY_VIOLATION', 'Real cleanup requires an explicit candidates file reviewed by the user');
    }
    const candidates = await loadCandidates(values, root);
    const result = await executeCleanup({
      rootDir: root,
      candidates,
      dryRun,
      approveLargeChange: values.includes('--approve-large-change'),
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
