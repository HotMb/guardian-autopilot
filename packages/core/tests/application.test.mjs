import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {AuditLog} from '../dist/audit-log.js';
import {executeCleanup, executeCleanupExperiment} from '../dist/application.js';
import {analyzeClosedWorld} from '../dist/closed-world.js';

const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  return execFile('git', ['-C', root, ...args], {windowsHide: true});
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-application-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CleanCode Tests');
  await mkdir(join(root, '.guardian'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'application-test-app', private: true}));
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({
    version: 1,
    protectedPaths: [],
    ignoredPaths: [],
    closedWorld: {profile: 'node-application-v1', commitment: 'all-runtime-roots-declared', entryFiles: ['safe.ts']},
  }));
  await writeFile(join(root, 'safe.ts'), 'export const safe = true;\n');
  await writeFile(join(root, 'remove.ts'), 'export const remove = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  return root;
}

async function provenCandidates(root, paths = ['remove.ts']) {
  const analysis = await analyzeClosedWorld(root, paths);
  assert.equal(analysis.complete, true, JSON.stringify(analysis.blockers));
  return paths.map((path) => {
    const proof = analysis.proofs.get(path);
    assert.ok(proof, `expected engine proof for ${path}`);
    return {id: `candidate-${path}`, path, kind: 'unused-file', confidence: 0.99, evidence: [proof]};
  });
}

const passingVerification = {
  build: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  typecheck: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  test: {command: process.execPath, args: ['-e', 'process.exit(0)']},
};

test('dry-run previews approved deletions without changing the repository', async () => {
  const root = await repository();
  const candidates = await provenCandidates(root);
  const before = await readFile(join(root, 'remove.ts'), 'utf8');
  const result = await executeCleanup({rootDir: root, candidates, dryRun: true});

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.state, 'PLANNED');
  assert.deepEqual(result.changedPaths, ['remove.ts']);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), before);
  assert.deepEqual((await git(root, 'status', '--porcelain')).stdout, '');
});

test('repository-defined protected paths block both apply and experiment before a worktree is created', async () => {
  const root = await repository();
  const candidates = await provenCandidates(root);
  await mkdir(join(root, '.guardian'), {recursive: true});
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({
    version: 1,
    protectedPaths: ['remove.ts'],
    ignoredPaths: [],
    closedWorld: {profile: 'node-application-v1', commitment: 'all-runtime-roots-declared', entryFiles: ['safe.ts']},
  }));
  await git(root, 'add', '.guardian/config.json');
  await git(root, 'commit', '-qm', 'configure a protected source path');

  await assert.rejects(
    () => executeCleanup({rootDir: root, candidates, verification: passingVerification}),
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

test('rejects a reviewed experiment when the repository HEAD no longer matches the attestation', async () => {
  const root = await repository();

  await assert.rejects(() => executeCleanupExperiment({
    rootDir: root,
    paths: ['remove.ts'],
    expectedRepositoryHead: '0'.repeat(40),
    verification: passingVerification,
  }), /different repository commit/i);
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
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

test('runs dependency setup only in the isolated worktree and does not commit setup artifacts', async () => {
  const root = await repository();
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await git(root, 'add', '.gitignore');
  await git(root, 'commit', '-qm', 'ignore local dependencies');
  const setup = {command: process.execPath, args: ['-e', "require('node:fs').mkdirSync('node_modules'); require('node:fs').writeFileSync('node_modules/setup-marker', 'ready')"], timeoutMs: 30000};
  const checks = {
    prepare: [setup],
    build: {command: process.execPath, args: ['-e', "if (require('node:fs').readFileSync('node_modules/setup-marker', 'utf8') !== 'ready' || require('node:fs').existsSync('remove.ts')) process.exit(1)"]},
    typecheck: {command: process.execPath, args: ['-e', 'process.exit(0)']},
    test: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  };
  const result = await executeCleanupExperiment({
    rootDir: root,
    paths: ['remove.ts'],
    verification: checks,
    allowPreparation: true,
  });

  assert.equal(result.state, 'COMMITTED');
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  assert.doesNotMatch((await git(root, 'show', '--format=', '--name-only', result.reviewBranchName)).stdout, /node_modules/);
  assert.equal((await git(root, 'status', '--porcelain')).stdout, '');
});

test('rolls back the experiment when approved preparation modifies a tracked source file', async () => {
  const root = await repository();
  const result = await executeCleanupExperiment({
    rootDir: root,
    paths: ['remove.ts'],
    verification: {
      prepare: [{command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('safe.ts', 'setup changed this\\n')"]}],
      ...passingVerification,
    },
    allowPreparation: true,
  });

  assert.equal(result.state, 'REVERTED');
  assert.equal(result.verification?.acceptance, false);
  assert.match(result.verification?.details.acceptance ?? '', /unexpected tracked change/i);
  assert.equal(await readFile(join(root, 'safe.ts'), 'utf8'), 'export const safe = true;\n');
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
  const root = await repository();
  const paths = [];
  for (let index = 0; index < 11; index += 1) {
    const path = `remove-${index}.ts`;
    await writeFile(join(root, path), `export const value${index} = true;\n`);
    paths.push(path);
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  const candidates = await provenCandidates(root, paths);

  await assert.rejects(
    () => executeCleanup({rootDir: root, candidates, confirmClosedWorld: true, verification: passingVerification}),
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
  const candidates = await provenCandidates(root);
  const auditPath = join(await mkdtemp(join(tmpdir(), 'cleancode-audit-')), 'audit.jsonl');
  const result = await executeCleanup({
    rootDir: root,
    candidates,
    confirmClosedWorld: true,
    verification: passingVerification,
    auditLog: new AuditLog(auditPath),
  });

  assert.equal(result.state, 'COMMITTED');
  assert.equal(result.verification?.allPassed, true);
  assert.match(result.verification?.details.acceptance ?? '', /exactly 1 requested tracked deletion/i);
  assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  const events = JSON.parse(`[${(await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).join(',')}]`);
  assert.deepEqual(events.map((event) => event.state), ['ISOLATED', 'APPLIED', 'VERIFIED', 'COMMITTED']);
});

test('rolls back when verification introduces an unexpected tracked edit', async () => {
  const root = await repository();
  const candidates = await provenCandidates(root);
  const result = await executeCleanup({
    rootDir: root,
    candidates,
    confirmClosedWorld: true,
    verification: {
      ...passingVerification,
      build: {command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('safe.ts', 'verification changed this\\n')"]},
    },
  });

  assert.equal(result.state, 'REVERTED');
  assert.equal(result.verification?.acceptance, false);
  assert.match(result.verification?.details.acceptance ?? '', /unexpected tracked change/i);
  assert.equal(await readFile(join(root, 'safe.ts'), 'utf8'), 'export const safe = true;\n');
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('rolls back when verification leaves an unexpected untracked file', async () => {
  const root = await repository();
  const candidates = await provenCandidates(root);
  const result = await executeCleanup({
    rootDir: root,
    candidates,
    confirmClosedWorld: true,
    verification: {
      ...passingVerification,
      build: {command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('unexpected.txt', 'verification artifact')"]},
    },
  });

  assert.equal(result.state, 'REVERTED');
  assert.equal(result.verification?.acceptance, false);
  assert.match(result.verification?.details.acceptance ?? '', /unexpected untracked file/i);
  assert.equal(await readFile(join(root, 'remove.ts'), 'utf8'), 'export const remove = true;\n');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('rolls back the isolated change when verification fails', async () => {
  const root = await repository();
  const candidates = await provenCandidates(root);
  const auditPath = join(await mkdtemp(join(tmpdir(), 'cleancode-audit-failed-')), 'audit.jsonl');
  const result = await executeCleanup({
    rootDir: root,
    candidates,
    confirmClosedWorld: true,
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
