import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {AuditLog} from '../dist/audit-log.js';
import {executeCleanup, executeCleanupExperiment} from '../dist/application.js';
import {createVerifiedPositiveProofEvidence} from '../dist/proof-evidence.js';

const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  return execFile('git', ['-C', root, ...args], {windowsHide: true});
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-application-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CleanCode Tests');
  await writeFile(join(root, 'safe.ts'), 'export const safe = true;\n');
  await writeFile(join(root, 'remove.ts'), 'export const remove = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  return root;
}

const candidate = {
  id: 'candidate-remove',
  path: 'remove.ts',
  kind: 'unused-file',
  confidence: 0.99,
  evidence: [createVerifiedPositiveProofEvidence('test-only engine proof', 0.99)],
};

const passingVerification = {
  build: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  typecheck: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  test: {command: process.execPath, args: ['-e', 'process.exit(0)']},
};

test('dry-run previews approved deletions without changing the repository', async () => {
  const root = await repository();
  const before = await readFile(join(root, 'remove.ts'), 'utf8');
  const result = await executeCleanup({rootDir: root, candidates: [candidate], dryRun: true});

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.state, 'PLANNED');
  assert.deepEqual(result.changedPaths, ['remove.ts']);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), before);
  assert.deepEqual((await git(root, 'status', '--porcelain')).stdout, '');
});

test('repository-defined protected paths block both apply and experiment before a worktree is created', async () => {
  const root = await repository();
  await mkdir(join(root, '.guardian'), {recursive: true});
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({version: 1, protectedPaths: ['remove.ts']}));
  await git(root, 'add', '.guardian/config.json');
  await git(root, 'commit', '-qm', 'configure a protected source path');

  await assert.rejects(
    () => executeCleanup({rootDir: root, candidates: [candidate], verification: passingVerification}),
    /protected path cannot be changed: remove\.ts/i,
  );
  await assert.rejects(
    () => executeCleanupExperiment({rootDir: root, paths: ['remove.ts'], verification: passingVerification}),
    /protected path cannot be changed: remove\.ts/i,
  );

  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
});

test('runs an unproven candidate only as a local review experiment and keeps the source branch unchanged', async () => {
  const root = await repository();
  const sourceBranch = (await git(root, 'branch', '--show-current')).stdout.trim();
  const result = await executeCleanupExperiment({
    rootDir: root,
    paths: ['remove.ts'],
    verification: passingVerification,
  });

  assert.equal(result.mode, 'experiment');
  assert.equal(result.state, 'COMMITTED');
  assert.equal(result.verification?.allPassed, true);
  assert.match(result.reviewBranchName ?? '', /^cleancode\/auto-/);
  assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  assert.equal((await git(root, 'branch', '--show-current')).stdout.trim(), sourceBranch);
  assert.match((await git(root, 'show', '--format=', '--name-status', result.reviewBranchName)).stdout, /D\s+remove\.ts/);
  assert.equal((await git(root, 'remote', '-v')).stdout, '');
});

test('refuses an experiment when the source repository is dirty', async () => {
  const root = await repository();
  await writeFile(join(root, 'safe.ts'), 'local edit\n');

  await assert.rejects(() => executeCleanupExperiment({
    rootDir: root,
    paths: ['remove.ts'],
    verification: passingVerification,
  }), /repository must be clean/i);

  assert.equal(await readFile(join(root, 'safe.ts'), 'utf8'), 'local edit\n');
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('rolls back an unproven review experiment when verification fails', async () => {
  const root = await repository();
  const result = await executeCleanupExperiment({
    rootDir: root,
    paths: ['remove.ts'],
    verification: {...passingVerification, test: {command: process.execPath, args: ['-e', 'process.exit(1)']}},
  });

  assert.equal(result.state, 'REVERTED');
  assert.equal(result.reviewBranchName, undefined);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('experiments cannot bypass required build, typecheck, and test checks', async () => {
  const root = await repository();
  const result = await executeCleanupExperiment({
    rootDir: root,
    paths: ['remove.ts'],
    verification: {requireAll: false},
  });

  assert.equal(result.state, 'REVERTED');
  assert.equal(result.verification?.allPassed, false);
  assert.equal(result.verification?.build, false);
  assert.equal(result.verification?.typecheck, false);
  assert.equal(result.verification?.tests, false);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
});

test('requires explicit human approval before applying more than ten files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-large-application-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CleanCode Tests');
  const candidates = [];
  for (let index = 0; index < 11; index += 1) {
    const path = `remove-${index}.ts`;
    await writeFile(join(root, path), `export const value${index} = true;\n`);
    candidates.push({path, evidence: [createVerifiedPositiveProofEvidence('test-only engine proof', 0.99)]});
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');

  await assert.rejects(
    () => executeCleanup({rootDir: root, candidates, verification: passingVerification}),
    /more than 10 files.*explicit human approval/i,
  );

  assert.equal((await git(root, 'status', '--porcelain')).stdout, '');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/*')).stdout.trim(), '');
  assert.equal(await readFile(join(root, 'remove-0.ts'), 'utf8'), 'export const value0 = true;\n');
});

test('rejects caller-asserted proof before creating a cleanup worktree', async () => {
  const root = await repository();
  const callerCandidate = {path: 'remove.ts', evidence: [{type: 'positive_proof', confidence: 1, details: 'asserted by caller'}]};

  await assert.rejects(
    () => executeCleanup({rootDir: root, candidates: [callerCandidate], verification: passingVerification}),
    /engine-verified positive proof/i,
  );
  assert.equal((await git(root, 'status', '--porcelain')).stdout, '');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/*')).stdout.trim(), '');
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
});

test('applies, verifies, audits, and commits approved deletions in an isolated worktree', async () => {
  const root = await repository();
  const auditPath = join(await mkdtemp(join(tmpdir(), 'cleancode-audit-')), 'audit.jsonl');
  const result = await executeCleanup({
    rootDir: root,
    candidates: [candidate],
    verification: passingVerification,
    auditLog: new AuditLog(auditPath),
  });

  assert.equal(result.state, 'COMMITTED');
  assert.equal(result.verification?.allPassed, true);
  assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  const events = JSON.parse(`[${(await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).join(',')}]`);
  assert.deepEqual(events.map((event) => event.state), ['ISOLATED', 'APPLIED', 'VERIFIED', 'COMMITTED']);
});

test('rolls back the isolated change when verification fails', async () => {
  const root = await repository();
  const auditPath = join(await mkdtemp(join(tmpdir(), 'cleancode-audit-failed-')), 'audit.jsonl');
  const result = await executeCleanup({
    rootDir: root,
    candidates: [candidate],
    verification: {
      ...passingVerification,
      test: {command: process.execPath, args: ['-e', 'process.exit(1)']},
    },
    auditLog: new AuditLog(auditPath),
  });

  assert.equal(result.state, 'REVERTED');
  assert.equal(result.verification?.allPassed, false);
  assert.equal(result.commit, undefined);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  const events = JSON.parse(`[${(await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).join(',')}]`);
  assert.equal(events.at(-1).state, 'REVERTED');
  assert.equal((await readdir(root)).some((name) => name.startsWith('cleancode-wt-')), false);
});
