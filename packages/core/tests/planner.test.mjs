import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planRepository} from '../dist/planner.js';

test('plans unreferenced files as review-only and never auto-authorizes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-planner-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import {used} from './used'; void used;\n");
  await writeFile(join(root, 'src', 'used.ts'), 'export const used = true;\n');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;\n');

  const report = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'definitely-not-a-real-knip'});
  const unused = report.candidates.find((candidate) => candidate.path === 'src/unused.ts');

  assert.ok(unused);
  assert.equal(unused.action, 'review-only');
  assert.equal(unused.decision.allowed, false);
  assert.match(unused.decision.reasons.join(' '), /positive proof|confidence/i);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/used.ts'), false);
  assert.equal(report.knip.status, 'unavailable');
});

test('plans exact duplicates without treating the hash as positive proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-planner-duplicates-'));
  await writeFile(join(root, 'canonical.ts'), 'same content\n');
  await writeFile(join(root, 'copy.ts'), 'same content\n');

  const report = await planRepository(root, {entryFiles: ['canonical.ts'], knipExecutable: 'definitely-not-a-real-knip'});
  const duplicate = report.candidates.find((candidate) => candidate.path === 'copy.ts');

  assert.ok(duplicate);
  assert.equal(duplicate.kind, 'exact-duplicate');
  assert.equal(duplicate.sameAs, 'canonical.ts');
  assert.equal(duplicate.decision.allowed, false);
  assert.match(duplicate.evidence.map((item) => item.details ?? item.type).join(' '), /hash|runtime|positive proof/i);
});

test('never proposes package-declared public entrypoints or files under an invalid package manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-package-plan-'));
  await mkdir(join(root, 'src', 'features'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'api.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'features', 'one.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'internal.ts'), 'export {};\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    exports: {'.': {types: './src/api.ts'}, './features/*': './src/features/*.ts'},
  }));

  const report = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'not-installed'});

  assert.deepEqual(report.packageEntrypoints.files, ['src/api.ts', 'src/features/one.ts']);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/api.ts'), false);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/features/one.ts'), false);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/internal.ts'), true);

  await writeFile(join(root, 'package.json'), '{broken');
  const invalid = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'not-installed'});
  assert.deepEqual(invalid.packageEntrypoints.invalidManifests, ['package.json']);
  assert.equal(invalid.candidates.some((candidate) => candidate.path === 'src/internal.ts'), false);
});

