import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../scripts/github-cleanup-experiment.mjs', import.meta.url));
const git = (root, ...args) => exec('git', ['-C', root, ...args], {windowsHide: true});

async function fixture(failing = false, prepare = false) {
  const root = await mkdtemp(join(tmpdir(), 'guardian-hosted-fixture-'));
  const output = await mkdtemp(join(tmpdir(), 'guardian-hosted-output-'));
  const check = {command: process.execPath, args: ['-e', `process.exit(${failing ? 1 : 0})`]};
  await writeFile(join(root, 'checks.json'), JSON.stringify({build: check, typecheck: check, test: check, ...(prepare ? {prepare: [check]} : {})}));
  await writeFile(join(root, 'unused.js'), 'export const unused = true;\n');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Fixture Owner');
  await git(root, 'config', 'user.email', 'fixture@example.com');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  const head = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  const args = [runner, '--target', root, '--candidate', 'unused.js', '--checks', 'checks.json', '--head', head, '--output', output];
  return {root, output, head, args};
}

test('hosted experiment writes a review patch only after checks pass on the requested commit', async () => {
  const {root, output, head, args} = await fixture();
  await exec(process.execPath, args);
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  const patch = await readFile(join(output, 'cleanup.patch'), 'utf8');
  assert.equal(report.baseCommit, head);
  assert.equal(report.candidate, 'unused.js');
  assert.equal(report.verified, true);
  assert.match(patch, /deleted file mode/);
  assert.match(patch, /unused\.js/);
  assert.equal(await readFile(join(root, 'unused.js'), 'utf8'), 'export const unused = true;\n');
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
  assert.equal((await git(root, 'rev-parse', 'HEAD')).stdout.trim(), head);
});

test('hosted experiment requires explicit approval for preparation commands', async () => {
  const {output, args} = await fixture(false, true);
  await assert.rejects(() => exec(process.execPath, args));
  await assert.rejects(() => readFile(join(output, 'cleanup.patch')));
  await exec(process.execPath, [...args, '--allow-preparation']);
  assert.match(await readFile(join(output, 'cleanup.patch'), 'utf8'), /deleted file mode/);
});

test('hosted experiment rejects a stale commit, failing checks and unsafe configuration paths', async () => {
  const first = await fixture();
  const staleArgs = first.args.slice();
  staleArgs[staleArgs.indexOf('--head') + 1] = 'a'.repeat(40);
  await assert.rejects(() => exec(process.execPath, staleArgs));
  await assert.rejects(() => readFile(join(first.output, 'cleanup.patch')));
  const unsafeArgs = first.args.slice();
  unsafeArgs[unsafeArgs.indexOf('--checks') + 1] = '../outside.json';
  await assert.rejects(() => exec(process.execPath, unsafeArgs));
  await assert.rejects(() => readFile(join(first.output, 'cleanup.patch')));
  const protectedChecksArgs = first.args.slice();
  protectedChecksArgs[protectedChecksArgs.indexOf('--candidate') + 1] = 'checks.json';
  await assert.rejects(() => exec(process.execPath, protectedChecksArgs));
  await assert.rejects(() => readFile(join(first.output, 'cleanup.patch')));
  const targetOutputArgs = first.args.slice();
  targetOutputArgs[targetOutputArgs.indexOf('--output') + 1] = first.root;
  await assert.rejects(() => exec(process.execPath, targetOutputArgs));
  await assert.rejects(() => readFile(join(first.root, 'cleanup.patch')));
  await writeFile(join(first.root, 'untracked-checks.json'), '{}');
  const untrackedArgs = first.args.slice();
  untrackedArgs[untrackedArgs.indexOf('--checks') + 1] = 'untracked-checks.json';
  await assert.rejects(() => exec(process.execPath, untrackedArgs));
  const failing = await fixture(true);
  await assert.rejects(() => exec(process.execPath, failing.args));
  await assert.rejects(() => readFile(join(failing.output, 'cleanup.patch')));
  assert.equal((await git(failing.root, 'status', '--porcelain')).stdout.trim(), '');
});
