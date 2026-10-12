import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {WorktreeExecutor} from '../dist/executor.js';
import {createVerifiedPositiveProofEvidence} from '../dist/proof-evidence.js';

const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  return execFile('git', ['-C', root, ...args], {windowsHide: true});
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-executor-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CleanCode Tests');
  await writeFile(join(root, 'safe.ts'), 'export const safe = true;\n');
  await writeFile(join(root, 'remove.ts'), 'export const remove = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  return root;
}

const allowedCandidate = {
  id: 'candidate-remove',
  path: 'remove.ts',
  kind: 'unused-file',
  confidence: 0.99,
  evidence: [createVerifiedPositiveProofEvidence('test-only engine proof', 0.99)],
};

test('creates an isolated worktree and commits only inside its branch', async () => {
  const root = await repository();
  const executor = new WorktreeExecutor({rootDir: root});
  const isolated = await executor.createIsolatedWorktree();

  assert.notEqual(isolated.worktreePath, root);
  assert.match(isolated.branchName, /^cleancode\/auto-/);
  assert.match(isolated.backupBranchName, /^cleancode\/backup-/);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');

  await executor.applyDeletions([allowedCandidate]);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  await executor.commit('chore: safe cleanup', ['remove.ts']);

  await assert.rejects(() => readFile(join(isolated.worktreePath, 'remove.ts'), 'utf8'));
  const branchDiff = await git(root, 'show', '--format=', '--name-status', isolated.branchName);
  assert.match(branchDiff.stdout, /D\s+remove\.ts/);
  const mainStatus = await git(root, 'status', '--porcelain');
  assert.equal(mainStatus.stdout, '');
});

test('refuses to commit verification or setup side effects outside the requested deletions', async () => {
  const root = await repository();
  const executor = new WorktreeExecutor({rootDir: root});
  const isolated = await executor.createIsolatedWorktree();
  await executor.applyDeletionExperiment(['remove.ts']);
  await writeFile(join(isolated.worktreePath, 'safe.ts'), 'modified by setup\n');

  await assert.rejects(() => executor.commit('chore: unsafe cleanup', ['remove.ts']), /unexpected.*change|only.*requested deletions/i);
  await executor.rollback();

  assert.equal(await readFile(join(root, 'safe.ts'), 'utf8'), 'export const safe = true;\n');
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
});

test('rejects unsafe candidates before changing the isolated worktree', async () => {
  const root = await repository();
  const executor = new WorktreeExecutor({rootDir: root});
  await executor.createIsolatedWorktree();

  await assert.rejects(() => executor.applyDeletions([{...allowedCandidate, evidence: [{type: 'no_import_references', confidence: 1}]}]), /positive proof/i);
  await assert.rejects(() => executor.applyDeletions([{...allowedCandidate, path: '.env.local'}]), /protected/i);
});

test('rejects serialized or caller-asserted positive proof at the deletion boundary', async () => {
  const root = await repository();
  const executor = new WorktreeExecutor({rootDir: root});
  await executor.createIsolatedWorktree();

  await assert.rejects(
    () => executor.applyDeletions([{...allowedCandidate, evidence: [{type: 'positive_proof', confidence: 1, details: 'I assert this is unused'}]}]),
    /engine-verified positive proof/i,
  );
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  await executor.rollback();
});

test('rollback removes the execution branch while retaining the backup branch', async () => {
  const root = await repository();
  const executor = new WorktreeExecutor({rootDir: root});
  const isolated = await executor.createIsolatedWorktree();
  await executor.applyDeletions([allowedCandidate]);
  await executor.rollback();

  const branches = await git(root, 'branch', '--list', isolated.branchName, isolated.backupBranchName);
  assert.doesNotMatch(branches.stdout, new RegExp(`\\b${isolated.branchName}\\b`));
  assert.match(branches.stdout, new RegExp(`\\b${isolated.backupBranchName}\\b`));
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
});

