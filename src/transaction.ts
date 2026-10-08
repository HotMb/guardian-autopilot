import {execFile as execFileCallback} from 'node:child_process';
import {lstat, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {isProtectedPath, loadConfig} from './config.js';

const execFile = promisify(execFileCallback);

export type TransactionCheck = {command: string; args?: string[]};
export type TransactionOptions = {
  files: string[];
  checks?: TransactionCheck[];
  dryRun?: boolean;
};
export type TransactionResult = {
  status: 'dry-run' | 'verified' | 'rolled-back' | 'failed';
  root: string;
  files: string[];
  diff: string;
  checks: Array<{command: string; passed: boolean; output?: string}>;
  error?: string;
};

async function runGit(root: string, args: string[]): Promise<{stdout: string; stderr: string}> {
  return execFile('git', ['-C', root, ...args], {maxBuffer: 20 * 1024 * 1024, windowsHide: true});
}

function reportPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as Error & {stderr?: string};
    return candidate.stderr?.trim() || candidate.message;
  }
  return String(error);
}

async function assertCleanRepository(root: string): Promise<void> {
  let topLevel: string;
  try {
    topLevel = (await runGit(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (error) {
    throw new Error(`Transaction requires a Git repository: ${errorMessage(error)}`);
  }
  if (resolve(topLevel) !== root) throw new Error('Transaction root must be the Git repository root');
  const status = (await runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim();
  if (status) throw new Error('Transaction requires a clean Git workspace; commit or stash local changes first');
}

function normalizePaths(root: string, paths: string[]): string[] {
  if (paths.length === 0) throw new Error('Transaction requires at least one file');
  const normalized = paths.map((candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error('Transaction paths must be non-empty strings');
    const absolute = resolve(root, candidate);
    const relativePath = reportPath(relative(root, absolute));
    if (isAbsolute(candidate) || relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) {
      throw new Error(`Transaction path must stay inside the repository: ${candidate}`);
    }
    return relativePath;
  });
  return [...new Set(normalized)].sort();
}

async function assertTrackedAndAllowed(root: string, paths: string[]): Promise<void> {
  const config = await loadConfig(root);
  for (const path of paths) {
    if (isProtectedPath(root, path, config)) throw new Error(`Protected path cannot be changed: ${path}`);
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Only regular files can be changed automatically: ${path}`);
    try {
      await runGit(root, ['ls-files', '--error-unmatch', '--', path]);
    } catch {
      throw new Error(`Only tracked files can be changed automatically: ${path}`);
    }
  }
}

async function runChecks(root: string, checks: TransactionCheck[]): Promise<Array<{command: string; passed: boolean; output?: string}>> {
  const results: Array<{command: string; passed: boolean; output?: string}> = [];
  for (const check of checks) {
    if (!check.command || check.command.includes('\u0000')) {
      throw new Error(`Unsafe check command: ${check.command}`);
    }
    const label = [check.command, ...(check.args ?? [])].join(' ');
    try {
      const result = await execFile(check.command, check.args ?? [], {cwd: root, maxBuffer: 20 * 1024 * 1024, windowsHide: true});
      results.push({command: label, passed: true, output: result.stdout.trim()});
    } catch (error) {
      results.push({command: label, passed: false, output: errorMessage(error)});
      throw new Error(`Verification check failed: ${label}`);
    }
  }
  return results;
}

export async function runCleanupTransaction(rootDir: string, options: TransactionOptions): Promise<TransactionResult> {
  const root = resolve(rootDir);
  const files = normalizePaths(root, options.files);
  const checks = options.checks ?? [];
  const dryRun = options.dryRun ?? true;
  await assertCleanRepository(root);
  await assertTrackedAndAllowed(root, files);

  let worktree: string | undefined;
  let patchDirectory: string | undefined;
  let patchPath: string | undefined;
  let applied = false;
  let diff = '';
  const checkResults: Array<{command: string; passed: boolean; output?: string}> = [];
  try {
    worktree = await mkdtemp(join(tmpdir(), 'guardian-worktree-'));
    await rm(worktree, {recursive: true, force: true});
    await runGit(root, ['worktree', 'add', '--detach', worktree, 'HEAD']);

    for (const path of files) await rm(join(worktree, path), {force: true});
    await runGit(worktree, ['diff', '--check', '--']);
    diff = (await runGit(worktree, ['diff', '--no-ext-diff', '--binary', '--', ...files])).stdout;
    if (checks.length > 0) checkResults.push(...await runChecks(worktree, checks));

    if (!dryRun) {
      patchDirectory = await mkdtemp(join(tmpdir(), 'guardian-patch-'));
      patchPath = join(patchDirectory, 'change.patch');
      await writeFile(patchPath, diff, 'utf8');
      await runGit(root, ['apply', '--binary', '--whitespace=error-all', patchPath]);
      applied = true;
      try {
        await runGit(root, ['diff', '--check', '--']);
        if (checks.length > 0) checkResults.push(...await runChecks(root, checks));
        const appliedDiff = (await runGit(root, ['diff', '--no-ext-diff', '--binary', '--', ...files])).stdout;
        if (appliedDiff !== diff) throw new Error('Applied source diff does not match the verified worktree diff');
      } catch (error) {
        try { await runGit(root, ['apply', '--reverse', '--binary', patchPath]); } catch (rollbackError) {
          throw new Error(`${errorMessage(error)}; source rollback failed: ${errorMessage(rollbackError)}`);
        }
        applied = false;
        throw error;
      }
      applied = false;
    }

    return {status: dryRun ? 'dry-run' : 'verified', root, files, diff, checks: checkResults};
  } catch (error) {
    return {status: 'rolled-back', root, files, diff, checks: checkResults, error: errorMessage(error)};
  } finally {
    if (applied && patchPath) {
      try { await runGit(root, ['apply', '--reverse', '--binary', patchPath]); } catch { /* best-effort cleanup */ }
    }
    if (patchDirectory) await rm(patchDirectory, {recursive: true, force: true});
    if (worktree) {
      try { await runGit(root, ['worktree', 'remove', '--force', worktree]); } catch { /* best-effort cleanup */ }
      await rm(worktree, {recursive: true, force: true});
    }
  }
}
