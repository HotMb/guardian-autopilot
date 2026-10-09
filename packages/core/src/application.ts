import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Candidate, State, VerificationResult} from '@cleancode/shared/types';
import {CleanCodeError} from '@cleancode/shared/errors';
import {AuditLog, type AuditEventInput} from './audit-log.js';
import {ExecutionStateMachine} from './state-machine.js';
import {WorktreeExecutor} from './executor.js';
import {ReceiptStore} from './receipts.js';
import {runVerification, type VerificationConfig} from './verifier.js';

export type CleanupExecutionOptions = {
  rootDir: string;
  candidates: readonly Pick<Candidate, 'path' | 'evidence'>[];
  dryRun?: boolean;
  verification?: VerificationConfig;
  worktreeRoot?: string;
  auditLog?: AuditLog;
  auditDirectory?: string;
  receiptDirectory?: string;
  commitMessage?: string;
};

export type CleanupExecutionResult = {
  mode: 'dry-run' | 'apply';
  state: State;
  changedPaths: string[];
  files: number;
  lines: number;
  bytes: number;
  commit?: string;
  backupBranchName?: string;
  receiptId?: string;
  verification?: VerificationResult;
  auditPath?: string;
  error?: string;
};

function executionId(): string {
  return `${Date.now()}-${randomBytes(6).toString('hex')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function audit(log: AuditLog, id: string, state: State, action: string, details?: Readonly<Record<string, unknown>>): Promise<void> {
  const event: AuditEventInput = {id: `${id}-${state.toLowerCase()}`, action, state, occurredAt: new Date().toISOString(), details};
  await log.append(event);
}

export async function executeCleanup(options: CleanupExecutionOptions): Promise<CleanupExecutionResult> {
  const executor = new WorktreeExecutor({rootDir: options.rootDir, worktreeRoot: options.worktreeRoot});

  if (options.dryRun) {
    if (options.candidates.length === 0) {
      return {mode: 'dry-run', state: 'PLANNED', changedPaths: [], files: 0, lines: 0, bytes: 0};
    }
    const preview = await executor.previewDeletions(options.candidates);
    return {mode: 'dry-run', state: 'PLANNED', changedPaths: preview.paths, files: preview.files, lines: preview.lines, bytes: preview.bytes};
  }

  if (options.candidates.length === 0) throw new CleanCodeError('POLICY_VIOLATION', 'At least one approved candidate is required');
  const preview = await executor.previewDeletions(options.candidates);
  const changedPaths = preview.paths;
  const id = executionId();
  const auditLog = options.auditLog ?? new AuditLog(join(options.auditDirectory ?? join(tmpdir(), 'cleancode-audit'), `${id}.jsonl`));
  const machine = new ExecutionStateMachine('PLANNED');
  let receiptStore: ReceiptStore | undefined;
  let receiptId: string | undefined;
  let verification: VerificationResult | undefined;
  let isolated = false;

  try {
    const worktree = await executor.createIsolatedWorktree();
    isolated = true;
    machine.transitionTo('ISOLATED');
    await audit(auditLog, id, 'ISOLATED', 'create-worktree', {branch: worktree.branchName, backupBranch: worktree.backupBranchName});

    receiptStore = new ReceiptStore(options.receiptDirectory ?? join(tmpdir(), 'cleancode-receipts'), worktree.worktreePath);
    const receipt = await receiptStore.begin(changedPaths);
    receiptId = receipt.id;
    await executor.applyDeletions(options.candidates);
    await receiptStore.finalize(receipt.id);
    machine.transitionTo('APPLIED');
    await audit(auditLog, id, 'APPLIED', 'apply-deletions', {paths: changedPaths, receiptId});

    verification = await runVerification(worktree.worktreePath, options.verification ?? {});
    if (!verification.allPassed) {
      await rollbackExecution(executor, receiptStore, receiptId, machine, auditLog, id, verification.details);
      return {mode: 'apply', state: 'REVERTED', changedPaths, files: preview.files, lines: preview.lines, bytes: preview.bytes, receiptId, verification, error: 'Verification failed'};
    }
    machine.transitionTo('VERIFIED');
    await audit(auditLog, id, 'VERIFIED', 'verification-passed', verification.details);
    const commit = await executor.commit(options.commitMessage ?? 'chore: safe cleanup');
    machine.transitionTo('COMMITTED');
    await audit(auditLog, id, 'COMMITTED', 'commit', {commit, receiptId});
    return {mode: 'apply', state: 'COMMITTED', changedPaths, files: preview.files, lines: preview.lines, bytes: preview.bytes, commit, backupBranchName: worktree.backupBranchName, receiptId, verification};
  } catch (error) {
    if (isolated && executor.worktree !== undefined) {
      try { await rollbackExecution(executor, receiptStore, receiptId, machine, auditLog, id, {error: errorMessage(error)}); }
      catch (rollbackError) { throw new CleanCodeError('ROLLBACK_EXECUTED', `${errorMessage(error)}; ${errorMessage(rollbackError)}`); }
    }
    if (error instanceof CleanCodeError) throw error;
    throw new CleanCodeError('WORKTREE_ERROR', errorMessage(error));
  }
}

async function rollbackExecution(
  executor: WorktreeExecutor,
  receiptStore: ReceiptStore | undefined,
  receiptId: string | undefined,
  machine: ExecutionStateMachine,
  auditLog: AuditLog,
  id: string,
  details: Readonly<Record<string, string>>,
): Promise<void> {
  let failure: unknown;
  try {
    if (receiptStore !== undefined && receiptId !== undefined) await receiptStore.rollback(receiptId);
  } catch (error) {
    failure = error;
  }
  if (machine.current !== 'REVERTED') machine.transitionTo('REVERTED');
  try { await audit(auditLog, id, 'REVERTED', 'rollback', details); }
  catch (error) { failure ??= error; }
  try { await executor.rollback(); }
  catch (error) { failure ??= error; }
  if (failure !== undefined) throw new Error(errorMessage(failure));
}
