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

test('matches many candidate names in one pass while preserving token priority and path matching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-string-refs-indexed-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'legacy-worker.ts'), 'export const LegacyWorker = true;\n');
  await writeFile(join(root, 'src', 'cart.ts'), 'export const cart = true;\n');
  await writeFile(join(root, 'references.md'), [
    'LegacyWorker appears before src/legacy-worker.ts, which must keep the higher-priority path token.',
    'prefix-src/cart.ts-suffix matches the existing substring rule.',
    'cartography',
  ].join('\n'));
  const progress = [];

  const report = await scanStringReferences(root, ['src/legacy-worker.ts', 'src/cart.ts', 'references.md'], [], (completed, total) => progress.push([completed, total]));
  const legacy = report.references.find((reference) => reference.target === 'src/legacy-worker.ts' && reference.source === 'references.md');
  const cart = report.references.find((reference) => reference.target === 'src/cart.ts' && reference.source === 'references.md');

  assert.equal(legacy?.matched, 'src/legacy-worker.ts');
  assert.equal(legacy?.line, 1);
  assert.equal(cart?.matched, 'src/cart.ts');
  assert.equal(cart?.line, 2);
  assert.equal(report.references.some((reference) => reference.target === 'src/cart.ts' && reference.line === 3), false);
  assert.deepEqual(progress.at(-1), [3, 3]);
});

test('yields to pending timers while scanning a large text file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-string-refs-yield-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'needle.ts'), 'export const needle = true;\n');
  await writeFile(join(root, 'zz-large.md'), Array.from({length: 12_000}, () => 'unrelated documentation line').join('\n'));
  let timerFired = false;
  let timer;

  await scanStringReferences(root, ['src/needle.ts', 'zz-large.md'], [], (completed) => {
    if (completed === 1) timer = setTimeout(() => { timerFired = true; }, 0);
  });
  if (timer !== undefined) clearTimeout(timer);

  assert.equal(timerFired, true, 'scanner should yield so report deadlines and progress callbacks can run');
});

test('finds WordPress PHP enqueue and include references to JavaScript and PHP files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-php-refs-'));
  await mkdir(join(root, 'js'), {recursive: true});
  await mkdir(join(root, 'inc', 'functions', 'metaboxes'), {recursive: true});
  await writeFile(join(root, 'functions.php'), [
    "wp_enqueue_script('isotope', get_template_directory_uri() . '/js/isotope.pkgd.min.js');",
    "require_once APR_METABOXES . '/user-profile.php';",
  ].join('\n'));
  await writeFile(join(root, 'js', 'isotope.pkgd.min.js'), '/* vendor script */\n');
  await writeFile(join(root, 'inc', 'functions', 'metaboxes', 'user-profile.php'), '<?php // user profile hooks\n');

  const report = await scanStringReferences(root, [
    'functions.php',
    'js/isotope.pkgd.min.js',
    'inc/functions/metaboxes/user-profile.php',
  ], ['inc/functions/metaboxes/user-profile.php']);

  assert.equal(report.references.some((reference) => reference.target === 'js/isotope.pkgd.min.js' && reference.source === 'functions.php'), true);
  assert.equal(report.references.some((reference) => reference.target === 'inc/functions/metaboxes/user-profile.php' && reference.source === 'functions.php'), true);
});

test('ignores a candidate’s own contents and reports unreadable scan inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-string-refs-unreadable-'));
  await writeFile(join(root, 'src-self.ts'), "const self = 'src-self.ts';\n");
  const report = await scanStringReferences(root, ['src-self.ts', 'missing.ts']);

  assert.equal(report.references.some((reference) => reference.target === 'src-self.ts'), false);
  assert.equal(report.unreadableFiles.includes('missing.ts'), true);
  assert.equal(report.noMatchIsProof, false);
});
