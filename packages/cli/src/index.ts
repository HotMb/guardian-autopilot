#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {analyzeClosedWorld, AuditLog, buildReferenceGraph, discoverRepository, executeCleanup, executeCleanupExperiment, hasMatchingClosedWorldProof, listInterruptedWorktrees, planRepository, recoverInterruptedWorktree, renderReport, type PlanProgressEvent, type ReportFormat, type VerificationConfig} from '@cleancode/core';
import {verifyLicense} from '@cleancode/license';
import {CleanCodeError, isCleanCodeError} from '@cleancode/shared/errors';
import type {Candidate, Evidence} from '@cleancode/shared/types';
import {serveMcp} from './mcp.js';
import {cloneGitHubRepository, summarizeUnresolvedReferences} from './github.js';
import {createHumanReviewTemplate, loadHumanReviewFile, type CandidateHumanReview} from './human-review.js';
import {assertCompleteDiscoveryForExperiment, runValidationCommand} from './validation.js';

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
  const valueOptions = new Set(['--format', '--knip', '--candidates-file', '--verification-file', '--audit-file', '--receipt-directory', '--output', '--path', '--max-candidates', '--review-file', '--timeout-ms', '--confirm-branch', '--confirm-path', '--expected-head']);
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
  console.error('Usage: cleancode <discover|analyze|plan|review|experiment|apply|report|recover|validate> [root] [options]');
  console.error('  validate <path> [--format=text|json] (read-only behavior validation; never executes project commands)');
  console.error('  report <root> [--timeout-ms 30000] [--format=md|html|json] [--output file]');
  console.error('  github analyze <owner/repository> --destination <new-local-path> [--format=json]');
  console.error('  experiment <root> --path <relative-path> [--path <relative-path> ...] --verification-file checks.json');
  console.error('  --expected-head <full-commit-sha> binds an explicit experiment to the reviewed commit');
  console.error('  experiment <root> --candidates-file paths.json --verification-file checks.json');
  console.error('  review <root> --path <relative-path> [--path <relative-path> ...] [--output review.json]');
  console.error('  experiment <root> --from-plan --review-file review.json [--max-candidates 1..3] --verification-file checks.json');
  console.error('  Human confirmations never supply engine-verified proof for apply');
  console.error('  apply --dry-run [--candidates-file file] [--format=json]');
  console.error('  experiment creates only a local review branch; it never pushes or merges');
  console.error('  dependency setup in an isolated worktree requires --allow-preparation');
  console.error('  real CleanCode apply still requires engine-verified positive proof');
  console.error('  apply <root> --candidates-file file --confirm-closed-world --verification-file checks.json');
  console.error('  --confirm-closed-world reruns the trusted analyzer for selected paths; roots come from tracked .guardian/config.json');
  console.error('  report [--format=json|md|html] [--output file]');
  console.error('  recover [root] [--format=json] (read-only list)');
  console.error('  recover [root] --rollback --confirm-branch <exact-branch> --confirm-path <exact-listed-path>');
  console.error('  recover removes only registered, uncommitted Guardian temp worktrees and retains their backup branches');
  console.error('  recover never removes committed review branches or replays cleanup receipts');
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

function autonomousCandidates(plan: Awaited<ReturnType<typeof planRepository>>, reviews?: ReadonlyMap<string, CandidateHumanReview>): {
  candidates: typeof plan.candidates;
  skippedCandidates: Array<{candidateId: string; path: string; reason: string}>;
  skippedReason?: string;
} {
  const globalSkipReason = plan.dynamicHints.length > 0
    ? 'Dynamic runtime-use hints were found; automatic candidate selection was skipped'
    : plan.knip.status === 'failed'
      ? 'The optional Knip analysis failed; automatic candidate selection was skipped'
      : undefined;
  if (globalSkipReason !== undefined) {
    return {
      candidates: [],
      skippedCandidates: plan.candidates.map((candidate) => ({candidateId: candidate.id, path: candidate.path, reason: globalSkipReason})),
      skippedReason: globalSkipReason,
    };
  }
  if (reviews === undefined) {
    const reason = 'A human review file is required before automatic experiment selection';
    return {
      candidates: [],
      skippedCandidates: plan.candidates.map((candidate) => ({candidateId: candidate.id, path: candidate.path, reason})),
      skippedReason: reason,
    };
  }

  const candidates: typeof plan.candidates = [];
  const skippedCandidates: Array<{candidateId: string; path: string; reason: string}> = [];
  for (const candidate of plan.candidates) {
    let reason: string | undefined;
    const humanReview = reviews.get(candidate.path);
    if (humanReview === undefined) reason = 'Candidate has no entry in the human review file';
    else if (!humanReview.allEntrypointsReviewed || !humanReview.noExternalUsageConfirmed) reason = 'Both human review checks must be confirmed before an experiment can start';
    else if (candidate.kind === 'unreferenced-file') {
      const evidence = candidate.evidence[0];
      if (candidate.evidence.length !== 1 || evidence?.type !== 'no_import_references') reason = 'Evidence is not limited to the no-import-references signal';
      else if (evidence.confidence < 0.95) reason = 'Static no-import-references confidence is below 0.95';
      else if (!candidate.decision.reasons.some((item) => /lacks engine-verified positive proof/i.test(item))) reason = 'Candidate does not have the expected missing-positive-proof policy blocker';
      else if (!candidate.decision.reasons.every((item) =>
        /lacks engine-verified positive proof/i.test(item)
        || /^Candidate confidence [\d.]+ is below 0\.95$/.test(item),
      )) {
        const blockers = candidate.decision.reasons.filter((item) =>
          !/lacks engine-verified positive proof/i.test(item)
          && !/^Candidate confidence [\d.]+ is below 0\.95$/.test(item),
        );
        reason = `Additional policy safeguards: ${blockers.join('; ')}`;
      }
    } else if (candidate.kind === 'closed-world-unreachable') {
      if (!hasMatchingClosedWorldProof(candidate, humanReview.repositoryHead, humanReview.sha256)) reason = 'Engine proof does not match the reviewed candidate hash and repository HEAD';
      else if (!candidate.decision.allowed) reason = `Closed-world proof is blocked by policy safeguards: ${candidate.decision.reasons.join('; ')}`;
    } else reason = `Candidate kind "${candidate.kind}" is not eligible for automatic experiments`;

    if (reason === undefined) candidates.push(candidate);
    else skippedCandidates.push({candidateId: candidate.id, path: candidate.path, reason});
  }
  return {
    candidates,
    skippedCandidates,
    ...(candidates.length === 0 ? {skippedReason: 'No reviewed candidate with eligible evidence is available for an isolated experiment'} : {}),
  };
}

function failedVerificationChecks(verification: Awaited<ReturnType<typeof executeCleanupExperiment>>['verification']): string[] {
  if (verification === undefined) return [];
  return (['build', 'typecheck', 'tests'] as const).filter((check) => !verification[check]);
}

async function loadVerification(args: string[]): Promise<VerificationConfig> {
  const file = optionValue(args, '--verification-file');
  if (file !== undefined) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(value)) throw new Error('Verification file must contain an object');
    if (value.prepare !== undefined) {
      if (!Array.isArray(value.prepare) || value.prepare.length === 0 || value.prepare.length > 3) {
        throw new CleanCodeError('POLICY_VIOLATION', 'Verification prepare must be a non-empty array of at most 3 commands');
      }
      let totalTimeoutMs = 0;
      for (const [index, command] of value.prepare.entries()) {
        if (!isRecord(command) || typeof command.command !== 'string' || command.command.trim() === '') {
          throw new CleanCodeError('POLICY_VIOLATION', `Preparation command ${index + 1} must include a non-empty command`);
        }
        if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string'))) {
          throw new CleanCodeError('POLICY_VIOLATION', `Preparation command ${index + 1} args must be an array of strings`);
        }
        const timeoutMs = command.timeoutMs ?? 120_000;
        if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > 600_000) {
          throw new CleanCodeError('POLICY_VIOLATION', `Preparation command ${index + 1} timeout must be between 1000 and 600000 milliseconds`);
        }
        totalTimeoutMs += timeoutMs as number;
      }
      if (totalTimeoutMs > 600_000) throw new CleanCodeError('POLICY_VIOLATION', 'Total preparation timeout cannot exceed 600000 milliseconds');
    }
    return value as unknown as VerificationConfig;
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
  if (command === 'validate') return runValidationCommand(args.slice(1));
  if (command === 'recover') {
    const values = [...args.slice(1)];
    const root = targetRoot(values);
    const recoveryFormat = format(values);
    const confirmBranch = optionValue(values, '--confirm-branch');
    const confirmPath = optionValue(values, '--confirm-path');
    const rollback = values.includes('--rollback');
    if (!rollback && (confirmBranch !== undefined || confirmPath !== undefined)) {
      throw new CleanCodeError('POLICY_VIOLATION', 'Confirmation flags require --rollback; without it recover is read-only');
    }
    if (rollback) {
      if (confirmBranch === undefined || confirmPath === undefined) {
        throw new CleanCodeError('POLICY_VIOLATION', 'Rollback requires both --confirm-branch and --confirm-path copied exactly from the listing');
      }
      await recoverInterruptedWorktree({rootDir: root, branchName: confirmBranch, worktreePath: confirmPath, confirmBranch, confirmPath});
      if (recoveryFormat === 'json') console.log(JSON.stringify({mode: 'rollback', branchName: confirmBranch, worktreePath: confirmPath, backupRetained: true}, null, 2));
      else {
        console.log(`✓ removed the isolated worktree and execution branch ${confirmBranch}`);
        console.log('✓ the matching cleancode/backup-* branch was retained');
        console.log('! This does not restore committed work or replay an undo receipt.');
      }
      return 0;
    }
    const entries = await listInterruptedWorktrees(root);
    if (recoveryFormat === 'json') console.log(JSON.stringify({mode: 'read-only', entries}, null, 2));
    else if (entries.length === 0) console.log('✓ No registered Guardian recovery worktrees were found in the OS temp directory');
    else {
      for (const entry of entries) {
        console.log(`${entry.state}: ${entry.branchName}`);
        console.log(`  path: ${entry.worktreePath}`);
        console.log(`  working tree: ${entry.workingTree}; ${entry.reason}`);
        if (entry.state === 'recoverable') {
          console.log(`  confirm with: cleancode recover --rollback --confirm-branch "${entry.branchName}" --confirm-path "${entry.worktreePath}"`);
        }
      }
      console.log('! Committed review branches are listed but never removed. The matching backup branch is retained.');
      console.log('! This command cannot recover a committed branch or replay a cleanup receipt after a crash.');
    }
    return 0;
  }
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
  if (!['discover', 'analyze', 'plan', 'review', 'experiment', 'apply', 'report'].includes(command)) {
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
  if (command === 'review') {
    const plan = await planRepository(root, {knipExecutable: optionValue(values, '--knip')});
    const review = await createHumanReviewTemplate(plan, optionValues(values, '--path'));
    const content = `${JSON.stringify(review, null, 2)}\n`;
    const output = optionValue(values, '--output');
    if (output === undefined) process.stdout.write(content);
    else {
      const destination = resolve(output);
      const fromRoot = relative(plan.root, destination);
      if (fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(fromRoot))) {
        throw new CleanCodeError('POLICY_VIOLATION', 'Human review output must be saved outside the scanned repository so it does not invalidate the clean-checkout requirement');
      }
      await writeFile(destination, content, {encoding: 'utf8', flag: 'wx'});
      console.log(`✓ Human review template written outside the repository: ${destination}`);
    }
    return 0;
  }
  if (command === 'report') {
    const rawTimeout = optionValue(values, '--timeout-ms');
    const timeoutMs = rawTimeout === undefined ? 30_000 : Number(rawTimeout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
      throw new CleanCodeError('POLICY_VIOLATION', '--timeout-ms must be an integer from 1000 to 600000');
    }
    const startedAt = Date.now();
    const onProgress = (event: PlanProgressEvent): void => {
      const elapsed = `${(event.elapsedMs / 1000).toFixed(1)}s`;
      if (event.state === 'progress' && event.completed !== undefined && event.total !== undefined) {
        console.error(`[cleancode] report: ${event.phase} ${event.completed}/${event.total} files (${elapsed} elapsed)`);
      } else {
        const duration = event.phaseElapsedMs === undefined ? '' : ` in ${(event.phaseElapsedMs / 1000).toFixed(1)}s`;
        console.error(`[cleancode] report: ${event.phase} ${event.state}${duration} (${elapsed} elapsed)`);
      }
    };
    // Leave room for the external analyzer to be terminated and the failure
    // report to be rendered after its own timeout has elapsed.
    const reportFinalizationGraceMs = 5_000;
    const timeout = setTimeout(() => {
      process.stderr.write(`[cleancode] report exceeded its analysis timeout and ${reportFinalizationGraceMs} ms finalization grace; no report was written.\n`, () => process.exit(124));
    }, timeoutMs + reportFinalizationGraceMs);
    try {
      const plannedReport = await planRepository(root, {
        knipExecutable: optionValue(values, '--knip'),
        knipTimeoutMs: timeoutMs,
        onProgress,
      });
      clearTimeout(timeout);
      const report = renderReport(plannedReport, reportFormat(values));
      const output = optionValue(values, '--output');
      if (output === undefined) process.stdout.write(report);
      else await writeFile(output, report, 'utf8');
      console.error(`[cleancode] report completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      return 0;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (command === 'experiment') {
    const fromPlan = values.includes('--from-plan');
    const explicitPaths = optionValues(values, '--path');
    const candidatesFile = optionValue(values, '--candidates-file');
    const reviewFile = optionValue(values, '--review-file');
    const limitOption = optionValue(values, '--max-candidates');
    const expectedHead = optionValue(values, '--expected-head');
    const expectedHeadProvided = values.some((value) => value === '--expected-head' || value.startsWith('--expected-head='));
    if (expectedHeadProvided && (expectedHead === undefined || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(expectedHead))) throw new CleanCodeError('POLICY_VIOLATION', '--expected-head requires a full Git commit hash');
    if (fromPlan && expectedHeadProvided) throw new CleanCodeError('POLICY_VIOLATION', '--expected-head cannot be combined with --from-plan; the review file binds the commit');
    if (fromPlan && (explicitPaths.length > 0 || candidatesFile !== undefined)) throw new CleanCodeError('POLICY_VIOLATION', '--from-plan cannot be combined with --path or --candidates-file');
    if (!fromPlan && limitOption !== undefined) throw new CleanCodeError('POLICY_VIOLATION', '--max-candidates is only valid with --from-plan');
    if (!fromPlan && reviewFile !== undefined) throw new CleanCodeError('POLICY_VIOLATION', '--review-file is only valid with --from-plan');
    const verificationFile = optionValue(values, '--verification-file');
    if (verificationFile === undefined) throw new CleanCodeError('POLICY_VIOLATION', 'Experiment requires --verification-file with build, typecheck, and test commands');
    const verification = await loadVerification(values);
    if ((verification.prepare?.length ?? 0) > 0 && !values.includes('--allow-preparation')) {
      throw new CleanCodeError('POLICY_VIOLATION', 'Verification config requests dependency setup; inspect its commands and pass --allow-preparation to approve them in the isolated worktree');
    }
    if ((verification.prepare?.length ?? 0) > 0) {
      console.error('! Preparation executes project commands with your user permissions; they are not OS-sandboxed. Review them before proceeding.');
    }
    if (fromPlan) {
      const limit = experimentLimit(values);
      const plan = await planRepository(root, {knipExecutable: optionValue(values, '--knip')});
      assertCompleteDiscoveryForExperiment(plan);
      const humanReviews = reviewFile === undefined ? undefined : await loadHumanReviewFile(reviewFile, plan);
      const selection = autonomousCandidates(plan, humanReviews);
      const selected = selection.candidates.slice(0, limit);
      const skippedCandidates = [
        ...selection.skippedCandidates,
        ...selection.candidates.slice(limit).map((candidate) => ({
          candidateId: candidate.id,
          path: candidate.path,
          reason: `Outside the configured batch limit of ${limit}`,
        })),
      ];
      const experiments = [];
      for (const candidate of selected) {
        const humanReview = humanReviews?.get(candidate.path);
        if (humanReview === undefined) throw new CleanCodeError('POLICY_VIOLATION', `Missing validated human review for ${candidate.path}`);
        const result = await executeCleanupExperiment({
          rootDir: root,
          paths: [candidate.path],
          verification,
          allowPreparation: values.includes('--allow-preparation'),
          receiptDirectory: optionValue(values, '--receipt-directory'),
          expectedRepositoryHead: humanReview.repositoryHead,
        });
        experiments.push({
          candidateId: candidate.id,
          path: candidate.path,
          kind: candidate.kind,
          selectionReason: candidate.kind === 'closed-world-unreachable'
            ? 'The engine supplied a closed-world unreachable proof bound to the reviewed file hash and repository HEAD; the change remains an isolated experiment.'
            : 'No static import/export reference was found; this remains an isolated review experiment because the engine has not supplied positive proof.',
          policyReasons: candidate.decision.reasons,
          failedChecks: result.state === 'REVERTED' ? failedVerificationChecks(result.verification) : [],
          result,
        });
      }
      const verified = experiments.filter((experiment) => experiment.result.state === 'COMMITTED').length;
      const rolledBack = experiments.length - verified;
      const batch = {
        mode: 'experiment-batch',
        availableCandidates: selection.candidates.length,
        attempted: experiments.length,
        verified,
        rolledBack,
        skipped: skippedCandidates.length,
        ...(selection.skippedReason === undefined ? {} : {skippedReason: selection.skippedReason}),
        skippedCandidates,
        experiments,
      };
      if (outputFormat === 'json') console.log(JSON.stringify(batch, null, 2));
      else {
        if (experiments.length === 0) console.log(`ℹ No automatic experiment started: ${selection.skippedReason ?? 'no eligible candidates'}`);
        else {
          console.log(`✓ ${verified} verified locally; ${rolledBack} rolled back; ${skippedCandidates.length} skipped`);
          for (const experiment of experiments) {
            if (experiment.result.state === 'COMMITTED') console.log(`✓ ${experiment.path} → build, typecheck, and tests passed; local review branch ${experiment.result.reviewBranchName}`);
            else console.log(`↩ ${experiment.path} → ${experiment.failedChecks.length > 0 ? `failed: ${experiment.failedChecks.join(', ')}` : 'experiment could not be verified'}; rolled back`);
          }
        }
        for (const skipped of skippedCandidates.slice(0, 10)) console.log(`· skipped ${skipped.path}: ${skipped.reason}`);
        if (skippedCandidates.length > 10) console.log(`· ${skippedCandidates.length - 10} additional skipped candidate(s) are listed in JSON output`);
        if (experiments.length > 0) console.log('! Review successful branches manually. Guardian did not push or merge.');
      }
      return experiments.every((experiment) => experiment.result.state === 'COMMITTED') ? 0 : experiments.length === 0 ? 0 : 5;
    }
    const paths = await loadExperimentPaths(values);
    const result = await executeCleanupExperiment({
      rootDir: root,
      paths,
      expectedRepositoryHead: expectedHead,
      approveLargeChange: values.includes('--approve-large-change'),
      verification,
      allowPreparation: values.includes('--allow-preparation'),
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
    let candidates = await loadCandidates(values, root);
    if (!dryRun) {
      if (!values.includes('--confirm-closed-world')) {
        throw new CleanCodeError('POLICY_VIOLATION', 'Real apply requires --confirm-closed-world for this run; confirm that tracked closedWorld.entryFiles cover every runtime entrypoint.');
      }
      const analysis = await analyzeClosedWorld(root, candidates.map((candidate) => candidate.path));
      if (!analysis.complete) {
        const blockers = analysis.blockers.map((blocker) => `${blocker.code}${blocker.path ? ` (${blocker.path})` : ''}: ${blocker.message}`).join('; ');
        throw new CleanCodeError('POLICY_VIOLATION', `Closed-world analysis is blocked${blockers ? `: ${blockers}` : ''}`);
      }
      candidates = candidates.map((candidate) => {
        const proof = analysis.proofs.get(candidate.path);
        if (proof === undefined) throw new CleanCodeError('POLICY_VIOLATION', `The selected path is reachable or unsupported and has no trusted proof: ${candidate.path}`);
        return {path: candidate.path, evidence: [proof]};
      });
    }
    const verification = dryRun ? undefined : await loadVerification(values);
    if ((verification?.prepare?.length ?? 0) > 0 && !values.includes('--allow-preparation')) {
      throw new CleanCodeError('POLICY_VIOLATION', 'Verification config requests dependency setup; inspect its commands and pass --allow-preparation to approve them in the isolated worktree');
    }
    if ((verification?.prepare?.length ?? 0) > 0) {
      console.error('! Preparation executes project commands with your user permissions; they are not OS-sandboxed. Review them before proceeding.');
    }
    const result = await executeCleanup({
      rootDir: root,
      candidates,
      dryRun,
      approveLargeChange: values.includes('--approve-large-change'),
      confirmClosedWorld: !dryRun && values.includes('--confirm-closed-world'),
      verification,
      allowPreparation: values.includes('--allow-preparation'),
      auditLog: dryRun ? undefined : optionValue(values, '--audit-file') === undefined ? undefined : new AuditLog(optionValue(values, '--audit-file') as string),
      receiptDirectory: optionValue(values, '--receipt-directory'),
    });
    if (outputFormat === 'json') console.log(JSON.stringify(result, null, 2));
    else if (result.mode === 'dry-run') {
      console.log(`✓ dry-run: ${result.files} file(s), ${result.lines} line(s), ${result.bytes} byte(s)`);
      for (const path of result.changedPaths) console.log(`→ would delete ${path}`);
    } else if (result.state === 'COMMITTED') {
      console.log(`✓ committed ${result.changedPaths.length} file(s) in ${result.commit}`);
      console.log(`→ local review branch: ${result.reviewBranchName}`);
      console.log('! Review the branch diff before merging manually. Guardian did not push or merge.');
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
