import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanPackageEntrypoints} from '../dist/package-exports.js';

test('finds source files declared by package exports, bin, main, and conditional targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-package-exports-'));
  await mkdir(join(root, 'src', 'features'), {recursive: true});
  await mkdir(join(root, 'tools'), {recursive: true});
  for (const path of ['src/api.ts', 'src/features/one.ts', 'src/features/bundled.ts', 'src/compiled.ts', 'src/internal.ts', 'tools/cli.ts']) {
    await writeFile(join(root, path), 'export {};\n');
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({
    exports: {
      '.': {types: './src/api.ts', import: './src/api.ts'},
      './features/one': './src/features/one.ts',
      './bundled/*': './dist/features/*.js',
      './compiled': './dist/compiled.js',
    },
    bin: {clean: './tools/cli.ts'},
    main: './src/api.ts',
  }));

  const report = await scanPackageEntrypoints(root, [
    'package.json', 'src/api.ts', 'src/features/one.ts', 'src/features/bundled.ts', 'src/compiled.ts', 'src/internal.ts', 'tools/cli.ts',
  ]);

  assert.deepEqual(report.files, ['src/api.ts', 'src/compiled.ts', 'src/features/bundled.ts', 'src/features/one.ts', 'tools/cli.ts']);
});

test('resolves package entrypoints relative to nested package manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-nested-package-'));
  await mkdir(join(root, 'packages', 'feature', 'src'), {recursive: true});
  await writeFile(join(root, 'packages', 'feature', 'package.json'), JSON.stringify({exports: './src/index.ts'}));
  await writeFile(join(root, 'packages', 'feature', 'src', 'index.ts'), 'export {};\n');

  const report = await scanPackageEntrypoints(root, ['packages/feature/package.json', 'packages/feature/src/index.ts']);

  assert.deepEqual(report.files, ['packages/feature/src/index.ts']);
});
