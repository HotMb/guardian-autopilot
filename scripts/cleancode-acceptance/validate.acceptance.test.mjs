import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {after, before, test} from 'node:test';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planRepository} from '../../packages/core/dist/planner.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = resolve(repositoryRoot, 'packages/cli/dist/index.js');
let sandboxRoot;

before(async () => {
  sandboxRoot = await mkdtempOwned();
});

after(async () => {
  if (sandboxRoot !== undefined) await rm(sandboxRoot, {recursive: true, force: true});
});

async function mkdtempOwned() {
  return mkdtemp(join(tmpdir(), 'guardian-cleancode-acceptance-'));
}

async function createProject(name, files) {
  const root = join(sandboxRoot, name);
  await mkdir(root, {recursive: true});
  await mkdir(join(root, '.git'), {recursive: true});
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/acceptance\n');
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), {recursive: true});
    await writeFile(destination, content, 'utf8');
  }
  return root;
}

function environmentWithLocalBin(binDirectory) {
  const env = {...process.env};
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = binDirectory + delimiter + (env[pathKey] ?? '');
  return env;
}

function invokeValidate(root, env = process.env) {
  return spawnSync(process.execPath, [cliEntry, 'validate', root, '--format=json'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
}

function parseReport(result, label) {
  assert.equal(result.error, undefined, label + ': CLI process could not start: ' + String(result.error));
  assert.notEqual(result.stdout.trim(), '', label + ': CLI returned no JSON report. stderr: ' + result.stderr);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(label + ': stdout was not valid JSON: ' + String(error) + '\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
  }
  assert.equal(report.schemaVersion, 1, label + ': unexpected report schema');
  assert.equal(report.command, 'validate', label + ': unexpected command in report');
  assert.ok(['blocked', 'review_only', 'ready_for_review'].includes(report.status), label + ': unexpected validation status');
  return report;
}

function assertReadOnlySafety(report, label) {
  assert.equal(report.safety.readOnly, true, label + ': report must declare read-only behavior');
  assert.equal(report.safety.externalTools, false, label + ': validation must not run external tools');
  assert.equal(report.safety.projectCommandsExecuted, false, label + ': validation must not execute project commands');
  assert.equal(report.safety.targetFilesWritten, false, label + ': validation must not write to the target');
  assert.equal(report.safety.executionAuthorized, false, label + ': validation must never authorize execution');
}

async function snapshotTree(root) {
  const snapshot = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        snapshot.set(relativePath, 'symlink:' + await readlink(absolutePath));
      } else if (info.isDirectory()) {
        snapshot.set(relativePath + '/', 'directory:' + String(info.mode));
        await visit(absolutePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        snapshot.set(relativePath, 'file:' + String(info.mode) + ':' + createHash('sha256').update(bytes).digest('hex'));
      } else {
        snapshot.set(relativePath, 'other:' + String(info.mode));
      }
    }
  }
  await visit(root);
  return snapshot;
}

test('supported project returns valid JSON and leaves every target file unchanged', async () => {
  const root = await createProject('supported', {
    'src/index.ts': "import { used } from './used.js';\nvoid used;\n",
    'src/used.ts': 'export const used = true;\n',
    'src/unused.ts': 'export const unused = true;\n',
  });
  const before = await snapshotTree(root);
  const result = invokeValidate(root);
  const report = parseReport(result, 'supported project');

  assert.equal(result.status, 0, 'supported project should complete validation: ' + result.stderr);
  assert.equal(report.status, 'ready_for_review', 'the unreferenced synthetic file should be review-only');
  assert.equal(report.root, root);
  assert.equal(report.repository.gitMetadata, 'available');
  assert.equal(report.repository.gitStatus, 'not_checked');
  assert.equal(report.discovery.status, 'complete');
  assert.equal(report.discovery.filesScanned, 3);
  assert.ok(report.candidates.count >= 1, 'expected at least one review candidate');
  assertReadOnlySafety(report, 'supported project');
  assert.deepEqual(await snapshotTree(root), before, 'validation changed the synthetic target tree');
});

test('dynamic-use project never exposes an actionable or deletable candidate', async () => {
  const root = await createProject('dynamic-use', {
    'src/index.ts': "const feature = process.env.FEATURE_NAME;\nawait import('./features/' + feature);\n",
    'src/features/feature-a.ts': 'export const featureA = true;\n',
  });
  const before = await snapshotTree(root);
  const result = invokeValidate(root);
  const report = parseReport(result, 'dynamic-use project');

  assert.equal(result.status, 0, 'dynamic-use project should complete read-only validation: ' + result.stderr);
  assert.notEqual(report.status, 'blocked');
  assertReadOnlySafety(report, 'dynamic-use project');
  assert.equal(Object.hasOwn(report.candidates, 'paths'), false, 'aggregate validation must not publish candidate paths');
  assert.equal(Object.hasOwn(report.candidates, 'actions'), false, 'aggregate validation must not publish candidate actions');
  assert.equal(Object.hasOwn(report, 'deletions'), false, 'validation must not publish a deletion plan');
  assert.equal(Object.hasOwn(report, 'delete'), false, 'validation must not offer a delete operation');

  // Check the same dynamic-use fixture against the planner: any candidate remains
  // review-only and policy-blocked; it cannot authorize a deletion.
  const analysis = await planRepository(root, {runExternalTools: false});
  assert.ok(analysis.dynamicHints.some((hint) => hint.kind === 'dynamic-import'), 'dynamic import must be detected');
  const dynamicPathCandidate = analysis.candidates.find((candidate) => candidate.path === 'src/features/feature-a.ts');
  if (dynamicPathCandidate !== undefined) {
    assert.equal(dynamicPathCandidate.action, 'review-only');
    assert.equal(dynamicPathCandidate.decision.allowed, false);
  }
  assert.deepEqual(await snapshotTree(root), before, 'dynamic-use validation changed the synthetic target tree');
});

test('validate does not run a target-local fake Knip executable', async () => {
  const root = await createProject('external-tool-guard', {
    'index.ts': 'export {};\n',
  });
  const binDirectory = join(root, 'local-tools');
  await mkdir(binDirectory, {recursive: true});
  const knipMarker = join(binDirectory, 'knip.invoked.marker');
  const gitMarker = join(binDirectory, 'git.invoked.marker');
  if (process.platform === 'win32') {
    await writeFile(join(binDirectory, 'knip.cmd'), '@echo off\r\necho invoked> "%~dp0knip.invoked.marker"\r\necho {"issues":[]}\r\n', 'utf8');
    await writeFile(join(binDirectory, 'git.cmd'), '@echo off\r\necho invoked> "%~dp0git.invoked.marker"\r\necho true\r\n', 'utf8');
  } else {
    const fakeKnip = join(binDirectory, 'knip');
    await writeFile(fakeKnip, '#!/bin/sh\nprintf invoked > "$(dirname "$0")/knip.invoked.marker"\nprintf \'{"issues":[]}\'\n', 'utf8');
    await chmod(fakeKnip, 0o755);
    const fakeGit = join(binDirectory, 'git');
    await writeFile(fakeGit, '#!/bin/sh\nprintf invoked > "$(dirname "$0")/git.invoked.marker"\nprintf true\n', 'utf8');
    await chmod(fakeGit, 0o755);
  }
  const before = await snapshotTree(root);
  const result = invokeValidate(root, environmentWithLocalBin(binDirectory));
  const report = parseReport(result, 'external-tool guard');

  assert.equal(result.status, 0, 'validation should finish without invoking Knip: ' + result.stderr);
  assert.equal(report.safety.externalTools, false);
  await assert.rejects(() => lstat(knipMarker), {code: 'ENOENT'}, 'target-local Knip must not run');
  await assert.rejects(() => lstat(gitMarker), {code: 'ENOENT'}, 'target-local Git must not run');
  assert.deepEqual(await snapshotTree(root), before, 'validation or the fake tool changed the synthetic target tree');
});

test('missing and invalid paths return blocked JSON reports with exit code 2', async () => {
  const missingPath = join(sandboxRoot, 'missing-project');
  const missingResult = invokeValidate(missingPath);
  const missingReport = parseReport(missingResult, 'missing path');

  assert.equal(missingResult.status, 2, 'missing path must fail closed with exit code 2');
  assert.equal(missingReport.status, 'blocked');
  assert.ok(missingReport.blockers.length >= 1, 'missing path must explain why validation is blocked');
  assertReadOnlySafety(missingReport, 'missing path');

  const fileRoot = join(sandboxRoot, 'not-a-directory');
  await writeFile(fileRoot, 'not a directory');
  const invalidResult = invokeValidate(fileRoot);
  const invalidReport = parseReport(invalidResult, 'file supplied as project root');

  assert.equal(invalidResult.status, 2, 'invalid root must fail closed with exit code 2');
  assert.equal(invalidReport.status, 'blocked');
  assert.ok(invalidReport.blockers.length >= 1, 'invalid root must explain why validation is blocked');
  assertReadOnlySafety(invalidReport, 'file supplied as project root');
});
