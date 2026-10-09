import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

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

test('apply --dry-run reports the guarded change without writing the target', async () => {
  const root = await fixture();
  const candidateFile = join(root, 'approved-candidates.json');
  await writeFile(candidateFile, JSON.stringify({candidates: [{
    path: 'src/unused.ts',
    evidence: [{type: 'positive_proof', confidence: 0.99}],
  }]}, null, 2));
  const before = await readFile(join(root, 'src', 'unused.ts'), 'utf8');
  const result = await exec(process.execPath, [cli, 'apply', root, '--dry-run', '--candidates-file', candidateFile, '--format=json']);
  const report = JSON.parse(result.stdout);

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.state, 'PLANNED');
  assert.deepEqual(report.changedPaths, ['src/unused.ts']);
  assert.equal(await readFile(join(root, 'src', 'unused.ts'), 'utf8'), before);
});

