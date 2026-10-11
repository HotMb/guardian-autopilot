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

test('excludes candidates mentioned by literal string references and exposes the conservative scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-string-plan-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "const loader = require('./legacy-worker'); void loader;\n");
  await writeFile(join(root, 'src', 'legacy-worker.ts'), 'export const worker = true;\n');
  await writeFile(join(root, 'src', 'spare.ts'), 'export const spare = true;\n');

  const report = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'not-installed'});

  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/legacy-worker.ts'), false);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/spare.ts'), true);
  assert.equal(report.stringReferences.references.some((reference) => reference.target === 'src/legacy-worker.ts' && reference.source === 'src/index.ts'), true);
  assert.equal(report.stringReferences.noMatchIsProof, false);
});

test('plan applies custom protected and ignored paths from .guardian/config.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-configured-policy-'));
  await mkdir(join(root, '.guardian'), {recursive: true});
  await mkdir(join(root, 'src', 'private-data'), {recursive: true});
  await mkdir(join(root, 'src', 'ignored'), {recursive: true});
  await mkdir(join(root, 'src', 'other', 'ignored'), {recursive: true});
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({
    version: 1,
    protectedPaths: ['src/private-data'],
    ignoredPaths: ['src/ignored'],
  }));
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n');
  await writeFile(join(root, 'src', 'private-data', 'record.ts'), 'export const record = true;\n');
  await writeFile(join(root, 'src', 'ignored', 'unused.ts'), 'export const ignored = true;\n');
  await writeFile(join(root, 'src', 'other', 'ignored', 'keep.ts'), 'export const keep = true;\n');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;\n');

  const report = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'not-installed'});
  const protectedCandidate = report.candidates.find((candidate) => candidate.path === 'src/private-data/record.ts');

  assert.ok(report.manifest.files.some((file) => file.path === 'src/private-data/record.ts'));
  assert.ok(protectedCandidate);
  assert.equal(protectedCandidate.decision.allowed, false);
  assert.match(protectedCandidate.decision.reasons.join(' '), /protected/i);
  assert.equal(report.manifest.files.some((file) => file.path === 'src/ignored/unused.ts'), false);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/ignored/unused.ts'), false);
  assert.equal(report.manifest.files.some((file) => file.path === 'src/other/ignored/keep.ts'), true);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/unused.ts'), true);
});

test('plan fails closed when the repository policy configuration is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-invalid-policy-'));
  await mkdir(join(root, '.guardian'), {recursive: true});
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({version: 2, protectedPaths: ['src/secrets']}));

  await assert.rejects(
    () => planRepository(root, {knipExecutable: 'not-installed'}),
    /Guardian config version must be 1/i,
  );

  for (const path of ['../outside', 'C:\\outside', './', 'src/**/outside']) {
    await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({version: 1, protectedPaths: [path]}));
    await assert.rejects(
      () => planRepository(root, {knipExecutable: 'not-installed'}),
      /must stay inside the scanned root/i,
    );
  }
});

