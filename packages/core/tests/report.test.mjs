import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planRepository} from '../dist/planner.js';
import {renderReport} from '../dist/report.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-report-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import {used} from './used'; import './runtime'; void used;\n");
  await writeFile(join(root, 'src', 'used.ts'), 'export const used = true;\n');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;\n');
  await writeFile(join(root, 'src', 'runtime.ts'), "export const handler = require(`./handlers/${name}`);\n");
  return root;
}

test('renders a stable JSON report summary', async () => {
  const plan = await planRepository(await fixture(), {knipExecutable: 'not-installed'});
  const report = JSON.parse(renderReport(plan, 'json'));

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.filesScanned, 4);
  assert.equal(report.candidates[0].path, 'src/unused.ts');
  assert.equal(report.candidates[0].allowed, false);
  assert.equal(report.coverage.status, 'unavailable');
  assert.equal(report.coverage.zeroCoverageIsProof, false);
  assert.deepEqual(report.packageEntrypoints.files, []);
  assert.deepEqual(report.dynamicHints.map(({path, line, kind}) => ({path, line, kind})), [
    {path: 'src/runtime.ts', line: 1, kind: 'dynamic-require'},
  ]);
});

test('renders escaped Markdown and HTML reports', async () => {
  const plan = await planRepository(await fixture(), {knipExecutable: 'not-installed'});
  const markdown = renderReport(plan, 'markdown');
  const html = renderReport(plan, 'html');

  assert.match(markdown, /# CleanCode report/);
  assert.match(markdown, /src\/unused\.ts/);
  assert.match(markdown, /Dynamic-usage hints/);
  assert.match(markdown, /confidence is intentionally capped at 0\.50/);
  assert.match(markdown, /Zero coverage is not proof/);
  assert.match(markdown, /package\.json entrypoints/);
  assert.match(html, /<main>/);
  assert.match(html, /src\/unused\.ts/);
  assert.match(html, /Dynamic-usage hints/);
  assert.match(html, /Zero coverage is not proof/);
  assert.match(html, /package\.json entrypoints/);
  assert.doesNotMatch(html, /<script>/i);
});
