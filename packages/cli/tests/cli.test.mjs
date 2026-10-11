import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPairSync} from 'node:crypto';
import {issueLicense} from '@cleancode/license';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function git(root, ...args) {
  return exec('git', ['-C', root, ...args], {windowsHide: true});
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-cli-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import {used} from './used'; void used;\n");
  await writeFile(join(root, 'src', 'used.ts'), 'export const used = true;\n');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;\n');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CleanCode Tests');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  return root;
}

async function createReviewFile(root, paths, confirmed = true) {
  const args = [cli, 'review', root];
  for (const path of paths) args.push('--path', path);
  args.push('--format=json');
  const template = JSON.parse((await exec(process.execPath, args)).stdout);
  if (confirmed) {
    for (const review of template.candidateReviews) {
      review.allEntrypointsReviewed = true;
      review.noExternalUsageConfirmed = true;
    }
  }
  const file = join(await mkdtemp(join(tmpdir(), 'cleancode-human-review-')), 'review.json');
  await writeFile(file, JSON.stringify(template, null, 2));
  return {file, template};
}

test('discover reports files without modifying the target', async () => {
  const root = await fixture();
  const before = await readFile(join(root, 'src', 'unused.ts'), 'utf8');
  const result = await exec(process.execPath, [cli, 'discover', root]);

  assert.match(result.stdout, /3 files scanned/);
  assert.equal(await readFile(join(root, 'src', 'unused.ts'), 'utf8'), before);
});

test('analyze and plan provide machine-readable read-only reports', async () => {
  const root = await fixture();
  const analyzed = await exec(process.execPath, [cli, 'analyze', root, '--format=json']);
  const analysis = JSON.parse(analyzed.stdout);
  assert.equal(analysis.mode, 'read-only');
  assert.equal(analysis.edges.length, 1);

  const planned = await exec(process.execPath, [cli, 'plan', root, '--format=json']);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.mode, 'read-only');
  assert.equal(plan.candidates.some((candidate) => candidate.path === 'src/unused.ts'), true);
  assert.equal(plan.candidates.find((candidate) => candidate.path === 'src/unused.ts').decision.allowed, false);
});

test('rejects unknown commands with a non-zero exit code', async () => {
  await assert.rejects(() => exec(process.execPath, [cli, 'unknown-command']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Unknown command/);
    return true;
  });
});

test('apply --dry-run refuses positive proof asserted only in a candidates JSON file', async () => {
  const root = await fixture();
  const candidateFile = join(root, 'approved-candidates.json');
  await writeFile(candidateFile, JSON.stringify({candidates: [{
    path: 'src/unused.ts',
    evidence: [{type: 'positive_proof', confidence: 0.99}],
  }]}, null, 2));
  const before = await readFile(join(root, 'src', 'unused.ts'), 'utf8');
  await assert.rejects(
    () => exec(process.execPath, [cli, 'apply', root, '--dry-run', '--candidates-file', candidateFile, '--format=json']),
    /engine-verified positive proof/i,
  );
  assert.equal(await readFile(join(root, 'src', 'unused.ts'), 'utf8'), before);
});

test('real apply refuses to infer destructive candidates without an explicit approved candidates file', async () => {
  const root = await fixture();
  const target = join(root, 'src', 'unused.ts');
  const before = await readFile(target, 'utf8');

  await assert.rejects(
    () => exec(process.execPath, [cli, 'apply', root]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /explicit.*candidates file/i);
      return true;
    },
  );

  assert.equal(await readFile(target, 'utf8'), before);
  assert.equal((await git(root, 'branch', '--list', 'cleancode/*')).stdout.trim(), '');
});

test('experiment creates a verified local review branch without requiring forged positive proof', async () => {
  const root = await fixture();
  const configRoot = await mkdtemp(join(tmpdir(), 'cleancode-experiment-config-'));
  const verificationFile = join(configRoot, 'verification.json');
  const original = await readFile(join(root, 'src', 'unused.ts'), 'utf8');
  const assertRemovedInWorktree = [
    '-e',
    "const fs=require('node:fs'); if (fs.existsSync('src/unused.ts')) process.exit(1)",
  ];
  await writeFile(verificationFile, JSON.stringify({
    build: {command: process.execPath, args: assertRemovedInWorktree},
    typecheck: {command: process.execPath, args: assertRemovedInWorktree},
    test: {command: process.execPath, args: assertRemovedInWorktree},
  }));

  const result = await exec(process.execPath, [cli, 'experiment', root, '--path', 'src/unused.ts', '--verification-file', verificationFile, '--format=json']);
  const experiment = JSON.parse(result.stdout);

  assert.equal(experiment.mode, 'experiment');
  assert.equal(experiment.state, 'COMMITTED');
  assert.equal(experiment.verification.allPassed, true);
  assert.match(experiment.reviewBranchName, /^cleancode\/auto-/);
  assert.equal(await readFile(join(root, 'src', 'unused.ts'), 'utf8'), original);
  assert.match((await git(root, 'show', '--format=', '--name-status', experiment.reviewBranchName)).stdout, /D\s+src\/unused\.ts/);
  assert.equal((await git(root, 'remote', '-v')).stdout, '');
});

test('plan experiment tries candidates independently and keeps only verified local review branches', async () => {
  const root = await fixture();
  const configRoot = await mkdtemp(join(tmpdir(), 'cleancode-plan-experiment-'));
  const verificationFile = join(configRoot, 'verification.json');
  const original = await readFile(join(root, 'src', 'unused.ts'), 'utf8');
  const sourceBranch = (await git(root, 'branch', '--show-current')).stdout.trim();
  const secondCandidate = join(root, 'src', 'unused-two.ts');
  await writeFile(secondCandidate, 'export const unusedTwo = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'add another unreferenced source file');
  const assertOneRemovedInWorktree = ['-e', "const fs=require('node:fs'); if (fs.existsSync('src/unused.ts') && fs.existsSync('src/unused-two.ts')) process.exit(1)"];
  await writeFile(verificationFile, JSON.stringify({
    build: {command: process.execPath, args: assertOneRemovedInWorktree},
    typecheck: {command: process.execPath, args: assertOneRemovedInWorktree},
    test: {command: process.execPath, args: ['-e', "const fs=require('node:fs'); if (!fs.existsSync('src/unused.ts')) process.exit(1)"]},
  }));
  const {file: humanReviewFile} = await createReviewFile(root, ['src/unused.ts', 'src/unused-two.ts']);

  let batch;
  await assert.rejects(
    () => exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--review-file', humanReviewFile, '--max-candidates', '2', '--verification-file', verificationFile, '--format=json']),
    (error) => {
      assert.equal(error.code, 5, `${error.stderr}\n${error.stdout}`);
      batch = JSON.parse(error.stdout);
      return true;
    },
  );
  const outcomes = new Map(batch.experiments.map((entry) => [entry.path, entry.result.state]));

  assert.equal(batch.mode, 'experiment-batch');
  assert.equal(batch.availableCandidates, 2);
  assert.equal(batch.attempted, 2);
  assert.equal(batch.skippedCandidates.length, 0);
  assert.equal(outcomes.get('src/unused.ts'), 'REVERTED');
  assert.equal(outcomes.get('src/unused-two.ts'), 'COMMITTED');
  const reverted = batch.experiments.find((entry) => entry.path === 'src/unused.ts');
  assert.deepEqual(reverted.failedChecks, ['tests']);
  assert.match(reverted.selectionReason, /no static import\/export reference/i);
  assert.equal(await readFile(join(root, 'src', 'unused.ts'), 'utf8'), original);
  assert.equal(await readFile(secondCandidate, 'utf8'), 'export const unusedTwo = true;\n');
  const committed = batch.experiments.find((entry) => entry.path === 'src/unused-two.ts');
  assert.match((await git(root, 'show', '--format=', '--name-status', committed.result.reviewBranchName)).stdout, /D\s+src\/unused-two\.ts/);
  assert.equal((await git(root, 'branch', '--show-current')).stdout.trim(), sourceBranch);
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim().split(/\r?\n/).length, 1);
});

test('plan experiment explains candidates omitted by the configured batch limit', async () => {
  const root = await fixture();
  const secondCandidate = join(root, 'src', 'unused-two.ts');
  const verificationFile = join(await mkdtemp(join(tmpdir(), 'cleancode-plan-batch-limit-')), 'verification.json');
  await writeFile(secondCandidate, 'export const unusedTwo = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'add another unreferenced source file');
  await writeFile(verificationFile, JSON.stringify({
    build: {command: process.execPath, args: ['-e', 'process.exit(0)']},
    typecheck: {command: process.execPath, args: ['-e', 'process.exit(0)']},
    test: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  }));
  const {file: humanReviewFile} = await createReviewFile(root, ['src/unused.ts', 'src/unused-two.ts']);

  const result = await exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--review-file', humanReviewFile, '--max-candidates', '1', '--verification-file', verificationFile, '--format=json']);
  const batch = JSON.parse(result.stdout);

  assert.equal(batch.availableCandidates, 2);
  assert.equal(batch.attempted, 1);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.skippedCandidates.length, 1);
  assert.match(batch.skippedCandidates[0].reason, /batch limit/i);
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
});

test('plan experiment skips automatic selection when dynamic runtime-use hints exist', async () => {
  const root = await fixture();
  const dynamicLoader = join(root, 'src', 'loader.ts');
  const verificationFile = join(await mkdtemp(join(tmpdir(), 'cleancode-plan-blocked-')), 'verification.json');
  await writeFile(dynamicLoader, "const moduleName = 'unused'; require(`./${moduleName}`);\n");
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'add dynamic runtime loader');
  await writeFile(verificationFile, JSON.stringify({
    build: {command: process.execPath, args: ['-e', 'process.exit(0)']},
    typecheck: {command: process.execPath, args: ['-e', 'process.exit(0)']},
    test: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  }));
  const {file: humanReviewFile} = await createReviewFile(root, ['src/loader.ts']);

  const result = await exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--review-file', humanReviewFile, '--verification-file', verificationFile, '--format=json']);
  const batch = JSON.parse(result.stdout);

  assert.equal(batch.attempted, 0);
  assert.match(batch.skippedReason, /dynamic runtime-use hints/i);
  assert.equal(batch.skipped, batch.skippedCandidates.length);
  assert.equal(await readFile(join(root, 'src', 'unused.ts'), 'utf8'), 'export const unused = true;\n');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');

  const textResult = await exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--review-file', humanReviewFile, '--verification-file', verificationFile]);
  assert.match(textResult.stdout, /No automatic experiment started: Dynamic runtime-use hints were found/i);
});

test('review creates a candidate-specific checklist bound to HEAD and file content', async () => {
  const root = await fixture();
  const {template} = await createReviewFile(root, ['src/unused.ts'], false);

  assert.equal(template.schemaVersion, 1);
  assert.equal(template.repositoryHead, (await git(root, 'rev-parse', 'HEAD')).stdout.trim());
  assert.deepEqual(template.candidateReviews, [{
    path: 'src/unused.ts',
    sha256: template.candidateReviews[0].sha256,
    allEntrypointsReviewed: false,
    noExternalUsageConfirmed: false,
  }]);
  assert.match(template.candidateReviews[0].sha256, /^[a-f0-9]{64}$/);
});

test('review refuses to write its checklist inside the repository', async () => {
  const root = await fixture();
  const output = join(root, 'human-review.json');

  await assert.rejects(
    () => exec(process.execPath, [cli, 'review', root, '--path', 'src/unused.ts', '--output', output]),
    /must be saved outside the scanned repository/i,
  );
  await assert.rejects(() => readFile(output));
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
});

test('from-plan requires both human confirmations before starting an experiment', async () => {
  const root = await fixture();
  const verificationFile = join(await mkdtemp(join(tmpdir(), 'cleancode-plan-review-gate-')), 'verification.json');
  await writeFile(verificationFile, JSON.stringify({
    build: {command: process.execPath, args: ['-e', 'process.exit(0)']},
    typecheck: {command: process.execPath, args: ['-e', 'process.exit(0)']},
    test: {command: process.execPath, args: ['-e', 'process.exit(0)']},
  }));

  const noReview = JSON.parse((await exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--verification-file', verificationFile, '--format=json'])).stdout);
  assert.equal(noReview.attempted, 0);
  assert.match(noReview.skippedReason, /human review file is required/i);
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');

  const {file: incompleteReviewFile} = await createReviewFile(root, ['src/unused.ts'], false);
  const incomplete = JSON.parse((await exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--review-file', incompleteReviewFile, '--verification-file', verificationFile, '--format=json'])).stdout);
  assert.equal(incomplete.attempted, 0);
  assert.match(incomplete.skippedCandidates[0].reason, /both human review checks/i);
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('from-plan rejects a human review file after the repository commit changes', async () => {
  const root = await fixture();
  const {file: humanReviewFile} = await createReviewFile(root, ['src/unused.ts']);
  await writeFile(join(root, 'README.md'), 'Changed after human review.\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-qm', 'change repository after review');
  const verificationFile = join(await mkdtemp(join(tmpdir(), 'cleancode-stale-review-')), 'verification.json');
  await writeFile(verificationFile, JSON.stringify({build: {}, typecheck: {}, test: {}}));

  await assert.rejects(
    () => exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--review-file', humanReviewFile, '--verification-file', verificationFile, '--format=json']),
    /review file refers to a different repository commit/i,
  );
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('from-plan rejects a human review after candidate content changes without a commit', async () => {
  const root = await fixture();
  const {file: humanReviewFile} = await createReviewFile(root, ['src/unused.ts']);
  await writeFile(join(root, 'src', 'unused.ts'), 'export const editedAfterReview = true;\n');
  const verificationFile = join(await mkdtemp(join(tmpdir(), 'cleancode-stale-file-review-')), 'verification.json');
  await writeFile(verificationFile, JSON.stringify({build: {}, typecheck: {}, test: {}}));

  await assert.rejects(
    () => exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--review-file', humanReviewFile, '--verification-file', verificationFile, '--format=json']),
    /human review file hash is stale/i,
  );
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('plan experiment enforces the three-candidate batch ceiling before scanning', async () => {
  const root = await fixture();
  const verificationFile = join(await mkdtemp(join(tmpdir(), 'cleancode-plan-limit-')), 'verification.json');
  await writeFile(verificationFile, JSON.stringify({build: {}, typecheck: {}, test: {}}));

  await assert.rejects(
    () => exec(process.execPath, [cli, 'experiment', root, '--from-plan', '--max-candidates', '4', '--verification-file', verificationFile]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /from 1 to 3/i);
      return true;
    },
  );
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('CLI experiment rolls back a real candidate when its test command fails', async () => {
  const root = await fixture();
  const configRoot = await mkdtemp(join(tmpdir(), 'cleancode-experiment-failure-'));
  const verificationFile = join(configRoot, 'verification.json');
  const original = await readFile(join(root, 'src', 'unused.ts'), 'utf8');
  const originalHead = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  const assertRemovedInWorktree = [
    '-e',
    "const fs=require('node:fs'); if (fs.existsSync('src/unused.ts')) process.exit(1)",
  ];
  await writeFile(verificationFile, JSON.stringify({
    build: {command: process.execPath, args: assertRemovedInWorktree},
    typecheck: {command: process.execPath, args: assertRemovedInWorktree},
    test: {command: process.execPath, args: ['-e', 'process.exit(1)']},
  }));

  let experiment;
  await assert.rejects(
    () => exec(process.execPath, [cli, 'experiment', root, '--path', 'src/unused.ts', '--verification-file', verificationFile, '--format=json']),
    (error) => {
      assert.notEqual(error.code, 0);
      experiment = JSON.parse(error.stdout);
      return true;
    },
  );

  assert.equal(experiment.state, 'REVERTED');
  assert.equal(experiment.verification.allPassed, false);
  assert.equal(experiment.verification.build, true);
  assert.equal(experiment.verification.typecheck, true);
  assert.equal(experiment.verification.tests, false);
  assert.equal(await readFile(join(root, 'src', 'unused.ts'), 'utf8'), original);
  assert.equal((await git(root, 'rev-parse', 'HEAD')).stdout.trim(), originalHead);
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
  assert.equal((await git(root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
  assert.equal((await git(root, 'remote', '-v')).stdout, '');
});

test('candidate files reject unknown evidence types and confidence outside zero to one', async () => {
  const root = await fixture();
  const candidateFile = join(root, 'candidate.json');
  const invalidEvidence = [
    {type: 'invented_proof', confidence: 0.99},
    {type: 'positive_proof', confidence: 1.01},
    {type: 'positive_proof', confidence: -0.01},
  ];

  for (const evidence of invalidEvidence) {
    await writeFile(candidateFile, JSON.stringify({candidates: [{path: 'src/unused.ts', evidence: [evidence]}]}));
    await assert.rejects(
      () => exec(process.execPath, [cli, 'apply', root, '--dry-run', '--candidates-file', candidateFile]),
      (error) => {
        assert.match(error.stderr, /candidate.*evidence/i);
        return true;
      },
    );
  }
});

test('report emits Markdown from a read-only plan', async () => {
  const root = await fixture();
  const result = await exec(process.execPath, [cli, 'report', root, '--format=md']);

  assert.match(result.stdout, /# CleanCode report/);
  assert.match(result.stdout, /src\/unused\.ts/);
});

test('license activate and status verify Ed25519 offline', async () => {
  const root = await fixture();
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({format: 'pem', type: 'pkcs8'});
  const publicKey = pair.publicKey.export({format: 'pem', type: 'spki'});
  const publicKeyFile = join(root, 'public-key.pem');
  const licenseFile = join(root, 'license.key');
  const storedFile = join(root, 'stored-license.key');
  await writeFile(publicKeyFile, publicKey);
  await writeFile(licenseFile, issueLicense(privateKey, {
    plan: 'pro', seats: 1, org: 'acme', features: ['reports'], kid: 'test', durationSeconds: 3600,
  }, Math.floor(Date.now() / 1000)));

  const activated = await exec(process.execPath, [cli, 'license', 'activate', '--license-file', licenseFile, '--public-key-file', publicKeyFile, '--output', storedFile, '--format=json']);
  assert.equal(JSON.parse(activated.stdout).plan, 'pro');
  const status = await exec(process.execPath, [cli, 'license', 'status', '--license-file', storedFile, '--public-key-file', publicKeyFile, '--format=json']);
  assert.equal(JSON.parse(status.stdout).org, 'acme');
});

