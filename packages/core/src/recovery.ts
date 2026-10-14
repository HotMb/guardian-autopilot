import {execFile as execFileCallback} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';

const execFile = promisify(execFileCallback);

export type InterruptedWorktree = {
  branchName: string;
  worktreePath: string;
  backupBranchName: string;
  state: 'recoverable' | 'committed-review' | 'unmanaged' | 'unavailable';
  workingTree: 'clean' | 'dirty' | 'unavailable';
  reason: string;
};

type RegisteredWorktree = {
  path: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
};

function normalizedPath(path: string): string {
  const value = resolve(path).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as Error & {stderr?: string; stdout?: string};
    return candidate.stderr?.trim() || candidate.stdout?.trim() || candidate.message;
  }
  return String(error);
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFile('git', ['-C', root, ...args], {windowsHide: true, maxBuffer: 20 * 1024 * 1024});
    return result.stdout;
  } catch (error) {
    throw new Error(errorText(error));
  }
}

function parseWorktrees(output: string): RegisteredWorktree[] {
  const result: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current !== undefined) result.push(current);
      current = undefined;
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (current !== undefined) result.push(current);
      current = {path: field.slice('worktree '.length), locked: false, prunable: false};
    } else if (current !== undefined && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    } else if (current !== undefined && field === 'locked') {
      current.locked = true;
    } else if (current !== undefined && field.startsWith('locked ')) {
      current.locked = true;
    } else if (current !== undefined && (field === 'prunable' || field.startsWith('prunable '))) {
      current.prunable = true;
    }
  }
  if (current !== undefined) result.push(current);
  return result;
}

function guardianBranch(branch: string): {suffix: string; backupBranchName: string} | undefined {
  const match = /^cleancode\/auto-(\d+-[a-f0-9]{6})$/.exec(branch);
  if (match?.[1] === undefined) return undefined;
  return {suffix: match[1], backupBranchName: `cleancode/backup-${match[1]}`};
}

function isTempWorktreePath(path: string, tempRoot: string): boolean {
  const absolute = resolve(path);
  if (normalizedPath(dirname(absolute)) !== normalizedPath(tempRoot)) return false;
  if (!/^cleancode-wt-.+$/i.test(basename(absolute))) return false;
  if (normalizedPath(absolute) === normalizedPath(tempRoot)) return false;
  return true;
}

async function inspectWorktree(root: string, entry: RegisteredWorktree, tempRoot: string): Promise<InterruptedWorktree | undefined> {
  if (entry.branch === undefined || guardianBranch(entry.branch) === undefined) return undefined;
  if (!isTempWorktreePath(entry.path, tempRoot)) return undefined;

  const identity = guardianBranch(entry.branch);
  if (identity === undefined) return undefined;
  const worktreePath = resolve(entry.path);
  const record: InterruptedWorktree = {
    branchName: entry.branch,
    worktreePath: entry.path,
    backupBranchName: identity.backupBranchName,
    state: 'unavailable',
    workingTree: 'unavailable',
    reason: '',
  };

  const rootReal = await realpath(root);
  if (normalizedPath(worktreePath) === normalizedPath(rootReal)) {
    record.reason = 'This is the active repository checkout and cannot be recovered here';
    return record;
  }

  let details;
  try { details = await lstat(worktreePath); }
  catch {
    record.reason = 'The registered worktree directory is missing or unavailable';
    return record;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    record.reason = 'The registered path is not a real directory';
    return record;
  }
  if (entry.locked || entry.prunable) {
    record.reason = entry.locked ? 'The worktree is locked' : 'Git marks the worktree as prunable';
    return record;
  }

  let backupHead: string;
  let branchHead: string;
  try {
    backupHead = (await git(root, ['rev-parse', '--verify', `refs/heads/${identity.backupBranchName}^{commit}`])).trim();
    branchHead = (await git(root, ['rev-parse', '--verify', `refs/heads/${entry.branch}^{commit}`])).trim();
  } catch {
    record.state = 'unmanaged';
    record.reason = 'The matching Guardian backup branch is absent or cannot be verified';
    return record;
  }
  if (backupHead !== branchHead) {
    record.state = 'committed-review';
    record.reason = 'The execution branch has commits beyond its Guardian backup; preserve it for manual review';
    return record;
  }

  try {
    const status = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
    record.workingTree = status.trim() === '' ? 'clean' : 'dirty';
  } catch {
    record.reason = 'Git could not read the registered worktree status';
    return record;
  }
  record.state = 'recoverable';
  record.reason = record.workingTree === 'dirty'
    ? 'Uncommitted isolated changes can be discarded after exact branch and path confirmation; the backup branch is retained'
    : 'No uncommitted changes; the isolated worktree and execution branch can be removed after exact confirmation';
  return record;
}

async function repositoryRoot(rootDir: string): Promise<string> {
  const input = resolve(rootDir);
  return realpath((await git(input, ['rev-parse', '--show-toplevel'])).trim());
}

/**
 * Lists only registered Guardian execution worktrees in the direct OS temp directory.
 * The function does not modify Git state or files.
 */
export async function listInterruptedWorktrees(rootDir = '.'): Promise<InterruptedWorktree[]> {
  const root = await repositoryRoot(rootDir);
  const tempRoot = resolve(tmpdir());
  const output = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  const records = parseWorktrees(output);
  const result: InterruptedWorktree[] = [];
  for (const entry of records) {
    const inspected = await inspectWorktree(root, entry, tempRoot);
    if (inspected !== undefined) result.push(inspected);
  }
  return result;
}

export type RecoverInterruptedWorktreeOptions = {
  rootDir?: string;
  branchName: string;
  worktreePath: string;
  confirmBranch: string;
  confirmPath: string;
};

/**
 * Removes one explicitly confirmed, registered, uncommitted Guardian execution worktree.
 * Its matching cleancode/backup-* branch is deliberately retained.
 */
export async function recoverInterruptedWorktree(options: RecoverInterruptedWorktreeOptions): Promise<void> {
  const {branchName, worktreePath, confirmBranch, confirmPath} = options;
  if (confirmBranch !== branchName || confirmPath !== worktreePath) {
    throw new Error('Recovery requires exact --confirm-branch and --confirm-path values copied from the listing');
  }
  const root = await repositoryRoot(options.rootDir ?? '.');
  const tempRoot = resolve(tmpdir());

  // Re-read the Git registration and all safety properties immediately before removal.
  const records = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain', '-z']));
  const exact = records.find((entry) => entry.branch === branchName && entry.path === worktreePath);
  if (exact === undefined) throw new Error('The exact branch/path pair is no longer registered; nothing was changed');
  const inspected = await inspectWorktree(root, exact, tempRoot);
  if (inspected === undefined || inspected.state !== 'recoverable') {
    throw new Error(inspected?.reason ?? 'The exact branch/path pair does not satisfy the Guardian recovery identity checks');
  }

  await git(root, ['worktree', 'remove', '--force', exact.path]);
  try {
    await git(root, ['branch', '-D', exact.branch as string]);
  } catch (error) {
    throw new Error(`Worktree was removed, but its execution branch could not be deleted; the backup was retained. ${errorText(error)}`);
  }
}
