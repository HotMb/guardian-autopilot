import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanCoverage} from '../dist/coverage.js';
import {planRepository} from '../dist/planner.js';

test('treats positively executed LCOV files as runtime usage, but not zero coverage as proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-coverage-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(join(root, 'coverage'), {recursive: true});
  await writeFile(join(root, 'src', 'used-dynamically.ts'), 'export const handler = true;\n');
  await writeFile(join(root, 'src', 'zero-hit.ts'), 'export const untouched = true;\n');
  await writeFile(join(root, 'src', 'malformed-hit.ts'), 'export const malformed = true;\n');
  await writeFile(join(root, 'coverage', 'lcov.info'), [
    `SF:${join(root, 'src', 'used-dynamically.ts').replaceAll('\\', '/')}`,
    'DA:1,1',
    'DA:2,0',
    'end_of_record',
    `SF:${join(root, 'src', 'zero-hit.ts').replaceAll('\\', '/')}`,
    'DA:1,0',
    'DA:2,',
    'end_of_record',
    'SF:../outside.ts',
    'DA:1,99',
    'end_of_record',
    `SF:${join(root, 'src', 'malformed-hit.ts').replaceAll('\\', '/')}`,
    'DA:1,',
    'end_of_record',
  ].join('\n'));

  const report = await scanCoverage(root, ['src/used-dynamically.ts', 'src/zero-hit.ts', 'src/malformed-hit.ts']);

  assert.equal(report.status, 'available');
  assert.deepEqual(report.executedFiles, ['src/used-dynamically.ts']);
  assert.equal(report.zeroCoverageFiles.includes('src/zero-hit.ts'), true);
  assert.equal(report.zeroCoverageFiles.includes('src/malformed-hit.ts'), false);
  assert.equal(report.executedFiles.includes('../outside.ts'), false);
  assert.equal(report.zeroCoverageIsProof, false);
});

test('handles a missing LCOV report as unavailable without producing proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-no-coverage-'));
  const report = await scanCoverage(root, ['src/unknown.ts']);

  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.executedFiles, []);
  assert.deepEqual(report.zeroCoverageFiles, []);
  assert.equal(report.zeroCoverageIsProof, false);
});

test('planner excludes positively executed modules but keeps zero-hit modules review-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-coverage-plan-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(join(root, 'coverage'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'dynamic-module.ts'), 'export const loaded = true;\n');
  await writeFile(join(root, 'src', 'zero-hit.ts'), 'export const notObserved = true;\n');
  await writeFile(join(root, 'coverage', 'lcov.info'), [
    `SF:${join(root, 'src', 'dynamic-module.ts').replaceAll('\\', '/')}`,
    'DA:1,1',
    'end_of_record',
    `SF:${join(root, 'src', 'zero-hit.ts').replaceAll('\\', '/')}`,
    'DA:1,0',
    'end_of_record',
  ].join('\n'));

  const plan = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'not-installed'});

  assert.equal(plan.candidates.some((candidate) => candidate.path === 'src/dynamic-module.ts'), false);
  assert.equal(plan.candidates.find((candidate) => candidate.path === 'src/zero-hit.ts')?.decision.allowed, false);
  assert.equal(plan.coverage.executedFiles.includes('src/dynamic-module.ts'), true);
  assert.equal(plan.coverage.zeroCoverageIsProof, false);
});
