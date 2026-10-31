import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertCompleteDiscoveryForExperiment, createValidationReport} from '../dist/validation.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('from-plan requires complete discovery metadata and names unreadable paths', () => {
  assert.doesNotThrow(() => assertCompleteDiscoveryForExperiment({discoveryStatus: 'complete', discoveryErrors: []}));

  const invalidPlans = [
    {discoveryStatus: 'partial', discoveryErrors: [{path: 'src/hidden.ts', message: 'permission denied'}]},
    {discoveryErrors: []},
    {discoveryStatus: 'unknown', discoveryErrors: []},
    {discoveryStatus: 'complete'},
    {discoveryStatus: 'complete', discoveryErrors: 'invalid'},
    {discoveryStatus: 'complete', discoveryErrors: [{path: 'src/hidden.ts', message: 'permission denied'}]},
    {discoveryStatus: 'complete', discoveryErrors: [{path: 7, message: 'malformed'}]},
  ];

  for (const plan of invalidPlans) {
    assert.throws(
      () => assertCompleteDiscoveryForExperiment(plan),
      (error) => error.code === 'POLICY_VIOLATION' && error.exitCode === 3,
    );
  }
  assert.throws(
    () => assertCompleteDiscoveryForExperiment(invalidPlans[0]),
    /src\/hidden\.ts: permission denied/,
  );
});

async function git(root, ...args) {
  return exec('git', ['-C', root, ...args], {windowsHide: true});
}

async function repositoryFixture(withGit = true) {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-validate-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import {used} from './used'; void used;\n");
  await writeFile(join(root, 'src', 'used.ts'), 'export const used = true;\n');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;\n');
  if (withGit) {
    await writeFile(join(root, '.gitignore'), 'node_modules/\n');
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'CleanCode Tests');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'initial');
  }
  return root;
}

test('validate blocks malformed individual discovery errors without throwing', async () => {
  const root = await repositoryFixture();
  const malformedPlan = {
    discoveryStatus: 'partial',
    discoveryErrors: [null, {path: 'src/unreadable', message: 'injected read error'}, {path: 'src/missing-message'}],
    manifest: {files: [{path: 'src/index.ts'}]},
    ignoredPaths: ['**/node_modules/**'],
  };

  const report = await createValidationReport(root, async () => malformedPlan);

  assert.equal(report.status, 'blocked');
  assert.equal(report.discovery.status, 'partial');
  assert.equal(report.discovery.errors.length, 1);
  assert.equal(report.discovery.errors[0].path, 'src/unreadable');
  assert.equal(report.candidates.count, 0);
  assert.match(report.blockers.join(' '), /discovery errors are malformed/i);
  assert.match(report.blockers.join(' '), /src\/unreadable: injected read error/i);
});

test('validate reports a read-only candidate review and does not invoke target-local Knip', async () => {
  const root = await repositoryFixture();
  const localBin = join(root, 'node_modules', '.bin');
  const marker = join(await mkdtemp(join(tmpdir(), 'cleancode-validate-marker-')), 'knip-invoked');
  await mkdir(localBin, {recursive: true});
  const command = process.platform === 'win32' ? join(localBin, 'knip.cmd') : join(localBin, 'knip');
  const script = process.platform === 'win32'
    ? '@echo off\r\necho invoked > "%CLEANCODE_KNIP_MARKER%"\r\n'
    : '#!/bin/sh\nprintf invoked > "$CLEANCODE_KNIP_MARKER"\n';
  await writeFile(command, script);
  if (process.platform !== 'win32') await chmod(command, 0o755);
  const unused = join(root, 'src', 'unused.ts');
  const original = await readFile(unused, 'utf8');
  const beforeStatus = (await git(root, 'status', '--porcelain')).stdout;
  const env = {
    ...process.env,
    CLEANCODE_KNIP_MARKER: marker,
    PATH: `${localBin}${delimiter}${process.env.PATH ?? ''}`,
  };

  const result = await exec(process.execPath, [cli, 'validate', root, '--format=json'], {env, windowsHide: true});
  const report = JSON.parse(result.stdout);

  assert.equal(report.status, 'ready_for_review');
  assert.equal(report.command, 'validate');
  assert.equal(report.repository.gitMetadata, 'available');
  assert.equal(report.repository.gitStatus, 'not_checked');
  assert.equal(report.discovery.status, 'complete');
  assert.equal(report.candidates.count > 0, true);
  assert.equal(report.safety.readOnly, true);
  assert.equal(report.safety.externalTools, false);
  assert.equal(report.safety.projectCommandsExecuted, false);
  assert.equal(report.safety.targetFilesWritten, false);
  assert.equal(report.safety.executionAuthorized, false);
  assert.match(report.evidence.limits.join(' '), /do not prove that a file is safe to remove/i);
  assert.equal(await readFile(unused, 'utf8'), original);
  assert.equal((await git(root, 'status', '--porcelain')).stdout, beforeStatus);
  await assert.rejects(() => readFile(marker, 'utf8'), {code: 'ENOENT'});
});

test('validate can analyze a non-Git directory and reports the missing Git experiment prerequisite', async () => {
  const root = await repositoryFixture(false);
  const result = await exec(process.execPath, [cli, 'validate', root, '--format', 'json']);
  const report = JSON.parse(result.stdout);

  assert.equal(report.status, 'ready_for_review');
  assert.equal(report.repository.gitMetadata, 'missing');
  assert.equal(report.repository.gitStatus, 'not_checked');
  assert.match(report.blockers.join(' '), /Git-backed experiment would require/i);
});

test('validate discloses effective ignored paths and excludes configured files from its inventory', async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, '.guardian'), {recursive: true});
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({version: 1, ignoredPaths: ['src/generated']}));
  await mkdir(join(root, 'src', 'generated'), {recursive: true});
  await writeFile(join(root, 'src', 'generated', 'unused.ts'), 'export const hidden = true;\n');

  const result = await exec(process.execPath, [cli, 'validate', root, '--format=json']);
  const report = JSON.parse(result.stdout);
  const textResult = await exec(process.execPath, [cli, 'validate', root]);

  assert.equal(report.status, 'ready_for_review');
  assert.equal(report.ignoredPaths.includes('src/generated'), true);
  assert.equal(report.ignoredPaths.includes('**/node_modules/**'), true);
  assert.equal(report.discovery.filesScanned, 5);
  assert.equal(report.candidates.count, 1);
  assert.match(textResult.stdout, /Ignored paths: .*src\/generated/);
});

test('validate emits a blocked report with exit code 2 for an invalid path', async () => {
  const result = await exec(process.execPath, [cli, 'validate', join(tmpdir(), 'cleancode-path-that-does-not-exist'), '--format=json']).catch((error) => error);

  assert.equal(result.code, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'blocked');
  assert.equal(report.discovery.status, 'not_run');
  assert.equal(report.candidates.count, 0);
});

test('validate rejects unsupported formats before scanning', async () => {
  const root = await repositoryFixture();

  await assert.rejects(
    () => exec(process.execPath, [cli, 'validate', root, '--format=html']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unsupported validate format/);
      return true;
    },
  );
});
