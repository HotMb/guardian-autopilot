import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanDynamicHints} from '../dist/dynamic-hints.js';

test('finds documented JavaScript and TypeScript runtime-usage hints with stable locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-dynamic-hints-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'loader.ts'), [
    "const module = require(`./handlers/${name}`);",
    "const other = import(`./locales/${locale}.json`);",
    "container.get('UserService')();",
    '@Injectable() class UserService {}',
    'class UserDTO { @JsonProperty() id!: string; @SerializedName("email") email!: string; }',
  ].join('\n'));
  await writeFile(join(root, 'src', 'plain.ts'), 'export const ordinary = true;\n');

  const hints = await scanDynamicHints(root);

  assert.deepEqual(hints.map(({path, line, kind}) => ({path, line, kind})), [
    {path: 'src/loader.ts', line: 1, kind: 'dynamic-require'},
    {path: 'src/loader.ts', line: 2, kind: 'dynamic-import'},
    {path: 'src/loader.ts', line: 3, kind: 'reflective-container'},
    {path: 'src/loader.ts', line: 4, kind: 'dependency-injection'},
    {path: 'src/loader.ts', line: 5, kind: 'serialization'},
    {path: 'src/loader.ts', line: 5, kind: 'serialization'},
  ]);
  assert.ok(hints.every((hint) => hint.confidence === 0.5));
  assert.ok(hints.every((hint) => hint.path !== 'src/plain.ts'));
});

test('fails closed on computed loaders, bundler globs, and generated code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-dynamic-loaders-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'loader.ts'), [
    'const first = require(selectedModule);',
    'const second = import(localePath);',
    "const third = require.context('./plugins', true);",
    "const fourth = import.meta.glob('./plugins/*.ts');",
    'const fifth = createRequire(import.meta.url);',
    'const sixth = eval(sourceText);',
    'const seventh = new Function(sourceText);',
    'const eighth = module.require(runtimeName);',
    'const ninth = vm.runInNewContext(sourceText);',
    'const invalid = ;',
    "const staticLoad = import(`./fixed-module`);",
  ].join('\n'));

  const hints = await scanDynamicHints(root);

  assert.deepEqual(hints.map(({path, line, kind}) => ({path, line, kind})), [
    {path: 'src/loader.ts', line: 1, kind: 'dynamic-require'},
    {path: 'src/loader.ts', line: 2, kind: 'dynamic-import'},
    {path: 'src/loader.ts', line: 3, kind: 'dynamic-require'},
    {path: 'src/loader.ts', line: 4, kind: 'dynamic-import'},
    {path: 'src/loader.ts', line: 5, kind: 'dynamic-require'},
    {path: 'src/loader.ts', line: 6, kind: 'opaque-code-execution'},
    {path: 'src/loader.ts', line: 7, kind: 'opaque-code-execution'},
    {path: 'src/loader.ts', line: 8, kind: 'dynamic-require'},
    {path: 'src/loader.ts', line: 9, kind: 'opaque-code-execution'},
    {path: 'src/loader.ts', line: 10, kind: 'unsupported-syntax'},
  ]);
});
