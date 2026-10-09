import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {AuditLog} from '../dist/audit-log.js';
import {executeCleanup} from '../dist/application.js';

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
  evidence: [{type: 'positive_proof', confidence: 0.99}],
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
