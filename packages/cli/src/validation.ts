import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {planRepository} from '@cleancode/core';
import {CleanCodeError} from '@cleancode/shared/errors';

export type ValidationStatus = 'blocked' | 'review_only' | 'ready_for_review';
export type ValidationFormat = 'text' | 'json';

export function assertCompleteDiscoveryForExperiment(value: unknown): void {
  const plan = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawErrors = plan.discoveryErrors;
  const errors = Array.isArray(rawErrors)
    ? rawErrors.filter((error): error is {path: string; message: string} => error !== null && typeof error === 'object' && typeof (error as {path?: unknown}).path === 'string' && typeof (error as {message?: unknown}).message === 'string')
    : [];
  if (plan.discoveryStatus === 'complete' && Array.isArray(rawErrors) && rawErrors.length === 0) return;

  const reasons: string[] = [];
  if (plan.discoveryStatus === 'partial') reasons.push('Repository discovery is partial.');
  else if (plan.discoveryStatus !== 'complete') reasons.push('Discovery status is missing or malformed.');
  if (!Array.isArray(rawErrors)) reasons.push('Discovery errors are missing or malformed.');
  else if (rawErrors.length > 0) reasons.push('Repository discovery reported unreadable paths.');
  if (Array.isArray(rawErrors) && errors.length !== rawErrors.length) reasons.push('One or more discovery errors are malformed.');
  const paths = errors.length > 0 ? ` Paths: ${errors.map((error) => `${error.path || '.'}: ${error.message}`).join('; ')}` : '';
  throw new CleanCodeError('POLICY_VIOLATION', `--from-plan requires complete repository discovery. ${reasons.join(' ')}${paths}`);
}

export type ValidationReport = {
  schemaVersion: 1;
  command: 'validate';
  status: ValidationStatus;
  root: string;
  repository: {gitMetadata: 'available' | 'missing'; gitStatus: 'not_checked'};
  ignoredPaths: string[] | null;
  discovery: {
    status: 'not_run' | 'complete' | 'partial';
    filesScanned: number;
    errors: Array<{path: string; message: string}>;
  };
  candidates: {count: number; evidenceCounts: Record<string, number>};
  blockers: string[];
  evidence: {sources: string[]; limits: string[]};
  safety: {
    readOnly: true;
    externalTools: false;
    projectCommandsExecuted: false;
    targetFilesWritten: false;
    executionAuthorized: false;
  };
};

type ReportOptions = {
  discoveryStatus?: ValidationReport['discovery']['status'];
  filesScanned?: number;
  errors?: ValidationReport['discovery']['errors'];
  gitMetadata?: ValidationReport['repository']['gitMetadata'];
  ignoredPaths?: string[] | null;
  candidates?: ValidationReport['candidates'];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDiscoveryError(value: unknown): value is {path: string; message: string} {
  return value !== null && typeof value === 'object'
    && typeof (value as {path?: unknown}).path === 'string'
    && typeof (value as {message?: unknown}).message === 'string';
}

function report(root: string, status: ValidationStatus, blockers: string[], options: ReportOptions = {}): ValidationReport {
  const discoveryStatus = options.discoveryStatus ?? 'not_run';
  return {
    schemaVersion: 1,
    command: 'validate',
    status,
    root,
    repository: {gitMetadata: options.gitMetadata ?? 'missing', gitStatus: 'not_checked'},
    ignoredPaths: options.ignoredPaths ?? null,
    discovery: {status: discoveryStatus, filesScanned: options.filesScanned ?? 0, errors: options.errors ?? []},
    candidates: options.candidates ?? {count: 0, evidenceCounts: {}},
    blockers,
    evidence: {
      sources: discoveryStatus === 'not_run' ? [] : ['Local repository inventory', 'Static import and export references', 'Package entrypoint and export metadata', 'Dynamic-use hints', 'Coverage metadata', 'Exact duplicate comparison'],
      limits: [
        ...(discoveryStatus === 'not_run' ? ['Repository analysis did not complete; no evidence was collected.'] : []),
        'The effective ignored-path patterns bound the repository inventory.',
        'Knip and closed-world analysis were skipped because external execution is disabled.',
        'A complete inventory and candidate report do not prove that a file is safe to remove.',
        'Ready for review is informational; it does not authorize experiments, apply, or other execution.',
        'Git working-tree status was not checked.',
      ],
    },
    safety: {
      readOnly: true,
      externalTools: false,
      projectCommandsExecuted: false,
      targetFilesWritten: false,
      executionAuthorized: false,
    },
  };
}

export async function createValidationReport(rootDir: string, planner: typeof planRepository = planRepository): Promise<ValidationReport> {
  const root = resolve(rootDir);
  const blockers: string[] = [];
  let rootIsDirectory = false;
  try {
    rootIsDirectory = (await stat(root)).isDirectory();
  } catch (error) {
    blockers.push(`Path cannot be inspected: ${errorMessage(error)}`);
  }
  if (!rootIsDirectory) {
    if (blockers.length === 0) blockers.push('Path is not a directory.');
    return report(root, 'blocked', blockers);
  }

  let gitMetadata: ValidationReport['repository']['gitMetadata'] = 'missing';
  try {
    await stat(resolve(root, '.git'));
    gitMetadata = 'available';
  } catch {
    blockers.push('Git metadata is missing; a Git-backed experiment would require a suitable clean Git checkout.');
  }

  let plan: Awaited<ReturnType<typeof planRepository>>;
  try {
    plan = await planner(root, {runExternalTools: false});
  } catch (error) {
    blockers.push(`Analysis failed: ${errorMessage(error)}`);
    return report(root, 'blocked', blockers, {gitMetadata});
  }

  const filesScanned = plan.manifest.files.length;
  const discoveryStatus: unknown = (plan as {discoveryStatus?: unknown}).discoveryStatus;
  if (discoveryStatus !== 'complete' && discoveryStatus !== 'partial') {
    blockers.push('Discovery status is missing or malformed; no candidate claim is available.');
    return report(root, 'blocked', blockers, {filesScanned, gitMetadata});
  }
  if (!Array.isArray(plan.discoveryErrors)) {
    blockers.push('Discovery errors are missing or malformed; no candidate claim is available.');
    return report(root, 'blocked', blockers, {filesScanned, gitMetadata});
  }
  const errors = plan.discoveryErrors.filter(isDiscoveryError);
  if (errors.length !== plan.discoveryErrors.length) {
    blockers.push('One or more discovery errors are malformed; no candidate claim is available.');
    for (const error of errors) blockers.push(`${error.path || '.'}: ${error.message}`);
    return report(root, 'blocked', blockers, {discoveryStatus: 'partial', filesScanned, errors, gitMetadata, ignoredPaths: plan.ignoredPaths});
  }
  if (discoveryStatus === 'partial' || errors.length > 0) {
    blockers.push('Repository discovery was incomplete; candidates are withheld.');
    for (const error of errors) blockers.push(`${error.path || '.'}: ${error.message}`);
    return report(root, 'blocked', blockers, {discoveryStatus: 'partial', filesScanned, errors, gitMetadata, ignoredPaths: plan.ignoredPaths});
  }

  if (!Array.isArray(plan.ignoredPaths) || plan.ignoredPaths.some((path) => typeof path !== 'string')) {
    blockers.push('Effective ignored-path patterns are missing or malformed; inventory scope cannot be confirmed.');
    return report(root, 'blocked', blockers, {discoveryStatus: 'complete', filesScanned, errors, gitMetadata});
  }

  const evidenceCounts: Record<string, number> = {};
  for (const candidate of plan.candidates) for (const evidence of candidate.evidence) evidenceCounts[evidence.type] = (evidenceCounts[evidence.type] ?? 0) + 1;
  const candidates = {count: plan.candidates.length, evidenceCounts};
  const status: ValidationStatus = candidates.count > 0 ? 'ready_for_review' : 'review_only';
  return report(root, status, blockers, {discoveryStatus: 'complete', filesScanned, errors, gitMetadata, ignoredPaths: plan.ignoredPaths, candidates});
}

function parseArgs(args: readonly string[]): {root: string; format: ValidationFormat} {
  let root: string | undefined;
  let format: ValidationFormat = 'text';
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith('--format=')) {
      const selected = value.slice('--format='.length);
      if (selected !== 'text' && selected !== 'json') throw new Error(`Unsupported validate format: ${selected}`);
      format = selected;
    } else if (value === '--format') {
      const selected = args[index + 1];
      if (selected !== 'text' && selected !== 'json') throw new Error('Usage: cleancode validate <path> [--format=text|json]');
      format = selected;
      index += 1;
    } else if (value.startsWith('--')) {
      throw new Error(`Unsupported validate option: ${value}`);
    } else if (root === undefined) root = value;
    else throw new Error('Usage: cleancode validate <path> [--format=text|json]');
  }
  if (root === undefined || root.trim() === '') throw new Error('Usage: cleancode validate <path> [--format=text|json]');
  return {root, format};
}

export async function runValidationCommand(args: readonly string[]): Promise<number> {
  const {root, format} = parseArgs(args);
  const result = await createValidationReport(root);
  if (format === 'json') console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Status: ${result.status}`);
    console.log(`Root: ${result.root}`);
    console.log(`Git metadata: ${result.repository.gitMetadata}; working-tree status: ${result.repository.gitStatus}`);
    console.log(`Ignored paths: ${result.ignoredPaths === null ? 'unavailable' : result.ignoredPaths.join(', ')}`);
    console.log(`Discovery: ${result.discovery.status}; ${result.discovery.filesScanned} files scanned`);
    console.log(`Candidates: ${result.candidates.count}`);
    console.log(`Evidence counts: ${JSON.stringify(result.candidates.evidenceCounts)}`);
    if (result.evidence.sources.length > 0) console.log(`Evidence sources: ${result.evidence.sources.join('; ')}`);
    for (const blocker of result.blockers) console.log(`Blocker: ${blocker}`);
    for (const limit of result.evidence.limits) console.log(`Limit: ${limit}`);
    console.log('Read-only: yes; project commands: no; target writes: no; execution authorized: no');
  }
  return result.status === 'blocked' ? 2 : 0;
}
