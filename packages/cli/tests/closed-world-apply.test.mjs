import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFile = promisify(execFileCallback);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function git(root, ...args) {
  return execFile('git', ['-C', root, ...args], {windowsHide: true});
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'guardian-cli-closed-world-'));
  await mkdir(join(root, '.guardian'), {recursive: true});
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'cli-closed-world-app', private: true}));
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({
    version: 1,
    protectedPaths: [],
    ignoredPaths: [],
    closedWorld: {profile: 'node-application-v1', commitment: 'all-runtime-roots-declared', entryFiles: ['src/main.js']},
  }));
  await writeFile(join(root, 'src', 'main.js'), 'export const main = true;\n');
  await writeFile(join(root, 'src', 'orphan.js'), 'export const orphan = true;\n');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Guardian CLI Tests');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'closed-world application');
  const directory = await mkdtemp(join(tmpdir(), 'guardian-cli-input-'));
  const candidates = join(directory, 'candidates.json');
  const verification = join(directory, 'verification.json');
  await writeFile(candidates, JSON.stringify({candidates: [{path: 'src/orphan.js', evidence: [{type: 'no_import_references', confidence: 0.99}]}]}));
  const check = {command: process.execPath, args: ['-e', 'process.exit(0)']};
  await writeFile(verification, JSON.stringify({build: check, typecheck: check, test: check}));
  return {root, candidates, verification};
}

async function runApply({root, candidates, verification}, extra = []) {
  try {
    return await execFile(process.execPath, [cli, 'apply', root, '--candidates-file', candidates, '--verification-file', verification, ...extra], {windowsHide: true});
  } catch (error) {
    return {stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code};
  }
}

test('CLI apply requires a per-run closed-world confirmation', async () => {
  const fixture = await repository();
  const result = await runApply(fixture);
  assert.match(result.stderr, /--confirm-closed-world/i);
  assert.equal(await readFile(join(fixture.root, 'src', 'orphan.js'), 'utf8'), 'export const orphan = true;\n');
  assert.equal((await git(fixture.root, 'status', '--porcelain')).stdout, '');
  assert.equal((await git(fixture.root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim(), '');
});

test('CLI ignores serialized no-reference claims, reruns the analyzer, then applies only a fresh unreachable proof', async () => {
  const fixture = await repository();
  const result = await runApply(fixture, ['--confirm-closed-world', '--format=json']);
  assert.match(result.stdout, /"state": "COMMITTED"/);
  assert.equal(await readFile(join(fixture.root, 'src', 'orphan.js'), 'utf8'), 'export const orphan = true;\n');
  assert.equal((await git(fixture.root, 'status', '--porcelain')).stdout, '');
  const branches = (await git(fixture.root, 'branch', '--list', 'cleancode/auto-*')).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(branches.length, 1);
  assert.match(branches[0].trim(), /^cleancode\/auto-/);
});

test('CLI rejects serialized positive proof instead of accepting it as an engine token', async () => {
  const fixture = await repository();
  await writeFile(fixture.candidates, JSON.stringify({candidates: [{path: 'src/orphan.js', evidence: [{type: 'positive_proof', confidence: 1, details: 'forged'}]}]}));
  const result = await runApply(fixture, ['--confirm-closed-world']);
  assert.match(result.stderr, /cannot assert positive_proof/i);
  assert.equal(await readFile(join(fixture.root, 'src', 'orphan.js'), 'utf8'), 'export const orphan = true;\n');
});
