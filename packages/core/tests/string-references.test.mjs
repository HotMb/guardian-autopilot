import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanStringReferences} from '../dist/string-references.js';

test('finds file paths and module names in other text files without treating no match as proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-string-refs-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "const plugin = require('./legacy-worker');\n");
  await writeFile(join(root, 'src', 'legacy-worker.ts'), 'export const LegacyWorker = true;\n');
  await writeFile(join(root, 'src', 'unreferenced.ts'), 'export const spare = true;\n');
  await writeFile(join(root, 'README.md'), 'The LegacyWorker plugin is optional.\n');

  const report = await scanStringReferences(root, ['src/index.ts', 'src/legacy-worker.ts', 'src/unreferenced.ts', 'README.md']);
  const used = report.references.filter((reference) => reference.target === 'src/legacy-worker.ts');

  assert.equal(used.some((reference) => reference.source === 'src/index.ts'), true);
  assert.equal(used.some((reference) => reference.source === 'README.md'), true);
  assert.equal(report.references.some((reference) => reference.target === 'src/unreferenced.ts'), false);
  assert.equal(report.noMatchIsProof, false);
  assert.deepEqual(report.unreadableFiles, []);
});

test('ignores a candidate’s own contents and reports unreadable scan inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-string-refs-unreadable-'));
  await writeFile(join(root, 'src-self.ts'), "const self = 'src-self.ts';\n");
  const report = await scanStringReferences(root, ['src-self.ts', 'missing.ts']);

  assert.equal(report.references.some((reference) => reference.target === 'src-self.ts'), false);
  assert.equal(report.unreadableFiles.includes('missing.ts'), true);
  assert.equal(report.noMatchIsProof, false);
});
