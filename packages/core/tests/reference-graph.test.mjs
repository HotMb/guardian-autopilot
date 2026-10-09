import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReferenceGraph} from '../dist/reference-graph.js';

test('resolves relative imports, re-exports and literal dynamic imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-graph-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), [
    "import {helper} from './helper';",
    "export {model} from './model.js';",
    "const load = () => import('./dynamic');",
    'void helper; void load; void model;',
  ].join('\n'));
  await writeFile(join(root, 'src', 'helper.ts'), 'export const helper = true;');
  await writeFile(join(root, 'src', 'model.ts'), 'export const model = true;');
  await writeFile(join(root, 'src', 'dynamic.ts'), 'export const dynamic = true;');

  const graph = await buildReferenceGraph(root);

  assert.deepEqual(graph.edges.map(({from, to, kind}) => ({from, to, kind})), [
    {from: 'src/index.ts', to: 'src/dynamic.ts', kind: 'dynamic-import'},
    {from: 'src/index.ts', to: 'src/helper.ts', kind: 'import'},
    {from: 'src/index.ts', to: 'src/model.ts', kind: 'export'},
  ]);
  assert.deepEqual(graph.unresolved, []);
});

test('resolves tsconfig path aliases and reports unresolved local targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-alias-'));
  await mkdir(join(root, 'src', 'lib'), {recursive: true});
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {
    baseUrl: '.',
    paths: {'@/*': ['src/*']},
  }}));
  await writeFile(join(root, 'src', 'entry.ts'), [
    "import {ok} from '@/lib/ok';",
    "import missing from '@/lib/missing';",
    'void ok; void missing;',
  ].join('\n'));
  await writeFile(join(root, 'src', 'lib', 'ok.ts'), 'export const ok = true;');

  const graph = await buildReferenceGraph(root);

  assert.deepEqual(graph.edges, [{
    from: 'src/entry.ts',
    to: 'src/lib/ok.ts',
    specifier: '@/lib/ok',
    kind: 'import',
  }]);
  assert.deepEqual(graph.unresolved, [{
    from: 'src/entry.ts',
    specifier: '@/lib/missing',
    kind: 'import',
  }]);
});

