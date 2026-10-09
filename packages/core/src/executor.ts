import {execFile as execFileCallback} from 'node:child_process';
import {lstat, mkdtemp, readFile, rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import type {Candidate} from '@cleancode/shared/types';
import {CleanCodeError} from '@cleancode/shared/errors';
import {canDelete, enforceChangeLimits, isProtectedPath, isSafePath} from './safeguards.js';

const execFile = promisify(execFileCallback);

export type WorktreeExecutorOptions = {
  rootDir: string;
  worktreeRoot?: string;
  now?: () => number;
};

export type IsolatedWorktree = {
  worktreePath: string;
  branchName: string;
  backupBranchName: string;
};

export type DeletionPreview = {
  paths: string[];
  files: number;
  lines: number;
  bytes: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as Error & {stderr?: string; stdout?: string};
    return candidate.stderr?.trim() || candidate.stdout?.trim() || candidate.message;
  }
  return String(error);
}

async function runGit(root: string, args: string[]): Promise<{stdout: string; stderr: string}> {
  try {
    return await execFile('git', ['-C', root, ...args], {maxBuffer: 20 * 1024 * 1024, windowsHide: true});
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

function safeRelativePath(root: string, candidate: string): string {
  if (typeof candidate !== 'string' || candidate.trim() === '' || isAbsolute(candidate)) {
    throw new CleanCodeError('POLICY_VIOLATION', `Candidate path is not a safe relative path: ${candidate}`);
  }
  const normalized = candidate.replaceAll('\\', '/');
  const absolute = resolve(root, normalized);
  const relativePath = relative(root, absolute).replaceAll('\\', '/');
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) {
    throw new CleanCodeError('POLICY_VIOLATION', `Candidate path escapes the worktree: ${candidate}`);
  }
  return relativePath;
}

export class WorktreeExecutor {
  private readonly root: string;
  private readonly worktreeRoot: string;
  private readonly now: () => number;
  private isolated?: IsolatedWorktree;
  private committed = false;

  constructor(options: WorktreeExecutorOptions) {
    this.root = resolve(options.rootDir);
    this.worktreeRoot = resolve(options.worktreeRoot ?? tmpdir());
    this.now = options.now ?? (() => Date.now());
  }

  get worktree(): IsolatedWorktree | undefined {
    return this.isolated === undefined ? undefined : {...this.isolated};
  }

  async previewDeletions(candidates: readonly Pick<Candidate, 'path' | 'evidence'>[]): Promise<DeletionPreview> {
    if (candidates.length === 0) throw new CleanCodeError('POLICY_VIOLATION', 'At least one candidate is required');
    return this.inspectDeletions(this.root, candidates);
  }

  async createIsolatedWorktree(): Promise<IsolatedWorktree> {
    if (this.isolated !== undefined) throw new CleanCodeError('WORKTREE_ERROR', 'An isolated worktree already exists');
    try {
      const status = await runGit(this.root, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (status.stdout.trim() !== '') throw new Error('Repository must be clean before creating a worktree');
      const suffix = `${this.now()}-${randomBytes(3).toString('hex')}`;
      const branchName = `cleancode/auto-${suffix}`;
      const backupBranchName = `cleancode/backup-${suffix}`;
      await runGit(this.root, ['branch', backupBranchName, 'HEAD']);
      const temporaryPath = await mkdtemp(join(this.worktreeRoot, 'cleancode-wt-'));
      await rm(temporaryPath, {recursive: true, force: true});
      try {
        await runGit(this.root, ['worktree', 'add', '-b', branchName, temporaryPath, 'HEAD']);
      } catch (error) {
        try { await runGit(this.root, ['branch', '-D', backupBranchName]); } catch { /* best effort */ }
        throw error;
      }
      this.isolated = {worktreePath: temporaryPath, branchName, backupBranchName};
      return {...this.isolated};
    } catch (error) {
      if (error instanceof CleanCodeError) throw error;
      throw new CleanCodeError('WORKTREE_ERROR', errorMessage(error));
    }
  }

  async applyDeletions(candidates: readonly Pick<Candidate, 'path' | 'evidence'>[]): Promise<void> {
    if (this.isolated === undefined) throw new CleanCodeError('WORKTREE_ERROR', 'Create an isolated worktree first');
    const preview = await this.inspectDeletions(this.isolated.worktreePath, candidates);
    for (const path of preview.paths) await rm(join(this.isolated.worktreePath, path), {force: true});
  }

  async commit(message: string): Promise<string> {
    if (this.isolated === undefined) throw new CleanCodeError('WORKTREE_ERROR', 'Create an isolated worktree first');
    if (this.committed) throw new CleanCodeError('WORKTREE_ERROR', 'Worktree has already been committed');
    if (message.trim() === '') throw new CleanCodeError('WORKTREE_ERROR', 'Commit message is required');
    try {
      await runGit(this.isolated.worktreePath, ['add', '-A', '--']);
      const staged = await runGit(this.isolated.worktreePath, ['diff', '--cached', '--quiet']).then(() => false).catch(() => true);
      if (!staged) throw new Error('No changes to commit');
      await runGit(this.isolated.worktreePath, ['commit', '-m', message]);
      const commit = (await runGit(this.isolated.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
      await this.removeWorktree();
      this.committed = true;
      return commit;
    } catch (error) {
      throw new CleanCodeError('WORKTREE_ERROR', errorMessage(error));
    }
  }

  async rollback(): Promise<void> {
    if (this.isolated === undefined) throw new CleanCodeError('WORKTREE_ERROR', 'Create an isolated worktree first');
    if (this.committed) throw new CleanCodeError('WORKTREE_ERROR', 'A committed worktree cannot be rolled back');
    const {branchName} = this.isolated;
    try {
      await this.removeWorktree();
      await runGit(this.root, ['branch', '-D', branchName]);
      this.isolated = undefined;
    } catch (error) {
      throw new CleanCodeError('ROLLBACK_EXECUTED', errorMessage(error));
    }
  }

  private async removeWorktree(): Promise<void> {
    if (this.isolated === undefined) return;
    const path = this.isolated.worktreePath;
    try { await runGit(this.root, ['worktree', 'remove', '--force', path]); } finally {
      await rm(path, {recursive: true, force: true});
    }
  }

  private async inspectDeletions(
    root: string,
    candidates: readonly Pick<Candidate, 'path' | 'evidence'>[],
  ): Promise<DeletionPreview> {
    const paths = new Set<string>();
    let lines = 0;
    let bytes = 0;
    for (const candidate of candidates) {
      if (!canDelete(candidate)) throw new CleanCodeError('POLICY_VIOLATION', `Candidate lacks positive proof: ${candidate.path}`);
      const path = safeRelativePath(root, candidate.path);
      if (paths.has(path)) throw new CleanCodeError('POLICY_VIOLATION', `Candidate is duplicated: ${path}`);
      if (isProtectedPath(path)) throw new CleanCodeError('POLICY_VIOLATION', `Protected path cannot be changed: ${path}`);
      const absolute = join(root, path);
      if (!isSafePath(absolute, root)) throw new CleanCodeError('POLICY_VIOLATION', `Candidate path is unsafe: ${path}`);
      let details;
      try { details = await lstat(absolute); }
      catch { throw new CleanCodeError('POLICY_VIOLATION', `Candidate file does not exist: ${path}`); }
      if (!details.isFile() || details.isSymbolicLink()) throw new CleanCodeError('POLICY_VIOLATION', `Only regular files can be deleted: ${path}`);
      try { await runGit(root, ['ls-files', '--error-unmatch', '--', path]); }
      catch { throw new CleanCodeError('POLICY_VIOLATION', `Only tracked files can be deleted: ${path}`); }
      const content = await readFile(absolute, 'utf8');
      paths.add(path);
      bytes += details.size;
      lines += content.length === 0 ? 0 : content.split(/\r?\n/).length;
    }
    enforceChangeLimits({files: paths.size, lines, bytes});
    return {paths: [...paths].sort(), files: paths.size, lines, bytes};
  }
}
