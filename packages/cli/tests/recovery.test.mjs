import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdtemp, rm, rmdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFileCallback);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let nextId = 0;

async function git(root, ...args) {
  return exec('git', ['-C', root, ...args], {windowsHide: true});
}

function containsPath(output, path) {
  return output.replaceAll('\\', '/').toLocaleLowerCase('en-US').includes(path.replaceAll('\\', '/').toLocaleLowerCase('en-US'));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-recover-cli-'));
  await writeFile(join(root, 'source.ts'), 'export const value = true;\n');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CleanCode CLI Recovery Tests');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  const worktrees = [];
  t.after(async () => {
    for (const item of worktrees) {
      try { await git(root, 'worktree', 'remove', '--force', item.path); } catch { /* already recovered */ }
      try { await git(root, 'branch', '-D', item.branch); } catch { /* already recovered */ }
      try { await git(root, 'branch', '-D', item.backup); } catch { /* fixture cleanup */ }
    }
    await rm(root, {recursive: true, force: true});
  });
  return {root, worktrees};
}

async function addWorktree(root, worktrees) {
  const suffix = `${Date.now()}-${(++nextId).toString(16).padStart(6, '0')}`;
  const branch = `cleancode/auto-${suffix}`;
  const backup = `cleancode/backup-${suffix}`;
  const path = await mkdtemp(join(tmpdir(), 'cleancode-wt-'));
  await rmdir(path);
  await git(root, 'branch', backup, 'HEAD');
  await git(root, 'worktree', 'add', '-b', branch, path, 'HEAD');
  const item = {path, branch, backup};
  worktrees.push(item);
  return item;
}

test('recover lists candidates read-only and requires exact confirmations for rollback', async (t) => {
  const {root, worktrees} = await fixture(t);
  const target = await addWorktree(root, worktrees);
  await writeFile(join(target.path, 'source.ts'), 'interrupted change\n');

  const listingResult = await exec(process.execPath, [cli, 'recover', root, '--format=json']);
  const listing = JSON.parse(listingResult.stdout);
  assert.equal(listing.mode, 'read-only');
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].branchName, target.branch);
  assert.equal(listing.entries[0].workingTree, 'dirty');
  assert.equal(containsPath((await git(root, 'worktree', 'list')).stdout, target.path), true);

  await assert.rejects(() => exec(process.execPath, [cli, 'recover', root, '--rollback', '--confirm-branch', target.branch]), (error) => {
    assert.match(error.stderr, /requires both --confirm-branch and --confirm-path/);
    return true;
  });
  await assert.rejects(() => exec(process.execPath, [cli, 'recover', root, '--rollback', '--confirm-branch', target.branch, '--confirm-path', `${target.path}-wrong`]), (error) => {
    assert.match(error.stderr, /no longer registered|does not satisfy/);
    return true;
  });
  assert.equal(containsPath((await git(root, 'worktree', 'list')).stdout, target.path), true);

  const listedPath = listing.entries[0].worktreePath;
  const recovered = await exec(process.execPath, [cli, 'recover', root, '--rollback', '--confirm-branch', target.branch, '--confirm-path', listedPath, '--format=json']);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.backupRetained, true);
  assert.equal(containsPath((await git(root, 'worktree', 'list')).stdout, target.path), false);
  assert.notEqual((await git(root, 'rev-parse', '--verify', `refs/heads/${target.backup}`)).stdout.trim(), '');
  assert.equal((await git(root, 'branch', '--list', target.branch)).stdout.trim(), '');
});

test('recover leaves committed review branches untouched and explains limits', async (t) => {
  const {root, worktrees} = await fixture(t);
  const target = await addWorktree(root, worktrees);
  await writeFile(join(target.path, 'source.ts'), 'committed review\n');
  await git(target.path, 'add', 'source.ts');
  await git(target.path, 'commit', '-qm', 'review');

  const listed = JSON.parse((await exec(process.execPath, [cli, 'recover', root, '--format=json'])).stdout);
  assert.equal(listed.entries[0].state, 'committed-review');
  assert.match(listed.entries[0].reason, /beyond its Guardian backup/);
  await assert.rejects(() => exec(process.execPath, [cli, 'recover', root, '--rollback', '--confirm-branch', target.branch, '--confirm-path', listed.entries[0].worktreePath]), (error) => {
    assert.match(error.stderr, /beyond its Guardian backup/);
    return true;
  });
  const text = (await exec(process.execPath, [cli, 'recover', root])).stdout;
  assert.match(text, /never removed/);
  assert.match(text, /cannot recover a committed branch or replay a cleanup receipt/);
  assert.equal(containsPath((await git(root, 'worktree', 'list')).stdout, target.path), true);
  assert.notEqual((await git(root, 'rev-parse', '--verify', `refs/heads/${target.branch}`)).stdout.trim(), '');
});
