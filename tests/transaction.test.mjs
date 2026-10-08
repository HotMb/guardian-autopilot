import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCleanupTransaction} from '../dist/transaction.js';

const exec = promisify(execFile);

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'guardian-git-test-'));
  await exec('git', ['-C', root, 'init', '--quiet']);
  await exec('git', ['-C', root, 'config', 'user.name', 'Guardian Test']);
  await exec('git', ['-C', root, 'config', 'user.email', 'guardian@example.invalid']);
  return root;
}

async function commitAll(root, message = 'initial') {
  await exec('git', ['-C', root, 'add', '--all']);
  await exec('git', ['-C', root, 'commit', '--quiet', '-m', message]);
}

test('creates a dry-run diff in an isolated worktree and leaves the source untouched', async () => {
  const root = await makeRepo();
  const file = join(root, 'duplicate.png');
  try {
    await writeFile(file, 'duplicate');
    await commitAll(root);
    const result = await runCleanupTransaction(root, {files: ['duplicate.png']});

    assert.equal(result.status, 'dry-run');
    assert.match(result.diff, /deleted file mode/);
    assert.equal(await readFile(file, 'utf8'), 'duplicate');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('applies a verified transaction only when dry-run is disabled', async () => {
  const root = await makeRepo();
  const file = join(root, 'duplicate.png');
  try {
    await writeFile(file, 'duplicate');
    await commitAll(root);
    const result = await runCleanupTransaction(root, {files: ['duplicate.png'], dryRun: false});

    assert.equal(result.status, 'verified');
    await assert.rejects(() => readFile(file, 'utf8'));
    assert.match((await exec('git', ['-C', root, 'status', '--porcelain'])).stdout.trim(), /^D\s+duplicate\.png$/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rejects dirty and untracked workspaces before creating a worktree', async () => {
  const root = await makeRepo();
  try {
    await writeFile(join(root, 'tracked.txt'), 'initial');
    await commitAll(root);
    await writeFile(join(root, 'tracked.txt'), 'changed');
    await assert.rejects(() => runCleanupTransaction(root, {files: ['tracked.txt']}), /clean Git workspace/);
    await writeFile(join(root, 'untracked.txt'), 'untracked');
    await assert.rejects(() => runCleanupTransaction(root, {files: ['tracked.txt']}), /clean Git workspace/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('protects secrets and rolls back when a verification fails', async () => {
  const root = await makeRepo();
  try {
    await writeFile(join(root, '.env'), 'SECRET=value');
    await writeFile(join(root, 'safe.txt'), 'safe');
    await commitAll(root);
    await assert.rejects(() => runCleanupTransaction(root, {files: ['.env']}), /Protected path/);

    const result = await runCleanupTransaction(root, {
      files: ['safe.txt'],
      checks: [{command: process.execPath, args: ['-e', 'process.exit(1)']}],
    });
    assert.equal(result.status, 'rolled-back');
    assert.match(result.error, /Verification check failed/);
    assert.equal(await readFile(join(root, 'safe.txt'), 'utf8'), 'safe');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rolls back a source repository when post-apply verification fails', async () => {
  const root = await makeRepo();
  const file = join(root, 'safe.txt');
  try {
    await writeFile(file, 'safe');
    await commitAll(root);
    const result = await runCleanupTransaction(root, {
      files: ['safe.txt'],
      dryRun: false,
      checks: [{command: process.execPath, args: ['-e', 'process.exit(1)']}],
    });

    assert.equal(result.status, 'rolled-back');
    assert.match(result.error, /Verification check failed/);
    assert.equal(await readFile(file, 'utf8'), 'safe');
    assert.equal((await exec('git', ['-C', root, 'status', '--porcelain'])).stdout.trim(), '');
  } finally { await rm(root, {recursive: true, force: true}); }
});
