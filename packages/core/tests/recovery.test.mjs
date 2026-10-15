import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdtemp, realpath, rm, rmdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {listInterruptedWorktrees, recoverInterruptedWorktree} from '../dist/recovery.js';

const execFile = promisify(execFileCallback);
let nextId = 0;

async function git(root, ...args) {
  return execFile('git', ['-C', root, ...args], {windowsHide: true});
}

function containsPath(output, path) {
  return output.replaceAll('\\', '/').toLocaleLowerCase('en-US').includes(path.replaceAll('\\', '/').toLocaleLowerCase('en-US'));
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-recovery-repo-'));
  await writeFile(join(root, 'safe.ts'), 'export const safe = true;\n');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CleanCode Recovery Tests');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  const worktrees = [];
  t.after(async () => {
    for (const item of worktrees) {
      try { await git(root, 'worktree', 'remove', '--force', item.path); } catch { /* already removed */ }
      try { await git(root, 'branch', '-D', item.branch); } catch { /* already removed */ }
      try { await git(root, 'branch', '-D', item.backup); } catch { /* already removed */ }
      try { await rm(item.container, {recursive: true, force: true}); } catch { /* test cleanup */ }
    }
    await rm(root, {recursive: true, force: true});
  });
  return {root, worktrees};
}

async function addWorktree(root, worktrees, {pathPrefix = 'cleancode-wt-', nested = false} = {}) {
  const container = nested ? await mkdtemp(join(tmpdir(), 'cleancode-recovery-parent-')) : tmpdir();
  const suffix = `${Date.now()}-${(++nextId).toString(16).padStart(6, '0')}`;
  const branch = `cleancode/auto-${suffix}`;
  const backup = `cleancode/backup-${suffix}`;
  const empty = await mkdtemp(join(container, pathPrefix));
  await rmdir(empty);
  await git(root, 'branch', backup, 'HEAD');
  await git(root, 'worktree', 'add', '-b', branch, empty, 'HEAD');
  const item = {path: await realpath(empty), branch, backup, container: nested ? container : undefined};
  worktrees.push(item);
  return item;
}

test('lists only registered Guardian temp worktrees and leaves them unchanged', async (t) => {
  const {root, worktrees} = await repository(t);
  const valid = await addWorktree(root, worktrees);
  const nested = await addWorktree(root, worktrees, {nested: true});
  const wrongName = await addWorktree(root, worktrees, {pathPrefix: 'ordinary-wt-'});
  await writeFile(join(valid.path, 'safe.ts'), 'changed in isolated worktree\n');

  const entries = await listInterruptedWorktrees(root);
  assert.deepEqual(entries.map(({branchName, worktreePath}) => ({branchName, worktreePath})), [
    {branchName: valid.branch, worktreePath: valid.path.replaceAll('\\', '/')},
  ]);
  assert.equal(entries[0].state, 'recoverable');
  assert.equal(entries[0].workingTree, 'dirty');
  assert.notEqual((await git(root, 'rev-parse', '--verify', `refs/heads/${valid.backup}`)).stdout.trim(), '');
  assert.equal(await git(root, 'worktree', 'list').then(({stdout}) => containsPath(stdout, valid.path)), true);
  assert.equal(await git(root, 'worktree', 'list').then(({stdout}) => containsPath(stdout, nested.path)), true);
  assert.equal(await git(root, 'worktree', 'list').then(({stdout}) => containsPath(stdout, wrongName.path)), true);
});

test('recovery requires exact branch and path and retains the backup branch', async (t) => {
  const {root, worktrees} = await repository(t);
  const target = await addWorktree(root, worktrees);
  await writeFile(join(target.path, 'safe.ts'), 'interrupted edit\n');
  const listed = (await listInterruptedWorktrees(root))[0];
  assert.ok(listed);

  await assert.rejects(() => recoverInterruptedWorktree({
    rootDir: root,
    branchName: target.branch,
    worktreePath: listed.worktreePath,
    confirmBranch: 'cleancode/auto-wrong',
    confirmPath: listed.worktreePath,
  }), /exact --confirm-branch and --confirm-path/);
  await assert.rejects(() => recoverInterruptedWorktree({
    rootDir: root,
    branchName: target.branch,
    worktreePath: listed.worktreePath,
    confirmBranch: target.branch,
    confirmPath: `${listed.worktreePath}-wrong`,
  }), /exact --confirm-branch and --confirm-path/);
  assert.equal(containsPath((await git(root, 'worktree', 'list')).stdout, target.path), true);

  await recoverInterruptedWorktree({
    rootDir: root,
    branchName: target.branch,
    worktreePath: listed.worktreePath,
    confirmBranch: target.branch,
    confirmPath: listed.worktreePath,
  });
  assert.equal((await git(root, 'branch', '--list', target.branch)).stdout.trim(), '');
  assert.notEqual((await git(root, 'rev-parse', '--verify', `refs/heads/${target.backup}`)).stdout.trim(), '');
  assert.equal(containsPath((await git(root, 'worktree', 'list')).stdout, target.path), false);
});

test('committed review branches are listed but cannot be removed by recovery', async (t) => {
  const {root, worktrees} = await repository(t);
  const target = await addWorktree(root, worktrees);
  await writeFile(join(target.path, 'safe.ts'), 'committed review\n');
  await git(target.path, 'add', 'safe.ts');
  await git(target.path, 'commit', '-qm', 'review result');

  const entry = (await listInterruptedWorktrees(root))[0];
  assert.equal(entry.state, 'committed-review');
  assert.match(entry.reason, /beyond its Guardian backup/);
  await assert.rejects(() => recoverInterruptedWorktree({
    rootDir: root,
    branchName: target.branch,
    worktreePath: entry.worktreePath,
    confirmBranch: target.branch,
    confirmPath: entry.worktreePath,
  }), /beyond its Guardian backup/);
  assert.equal(containsPath((await git(root, 'worktree', 'list')).stdout, target.path), true);
  assert.notEqual((await git(root, 'rev-parse', '--verify', `refs/heads/${target.branch}`)).stdout.trim(), '');
});
