import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, writeFile} from 'node:fs/promises';
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
  assert.deepEqual([...new Set(report.stringReferences.references.map(({target}) => target))], ['src/runtime.ts', 'src/used.ts']);
  assert.equal(report.stringReferences.noMatchIsProof, false);
  assert.deepEqual(report.deletionReadiness, {
    status: 'blocked',
    reason: 'No complete supported closed-world analysis is configured.',
    automatedBlockers: ['engine-proof-unavailable', 'dynamic-usage-hints'],
    humanChecks: ['confirm-closed-world-at-apply'],
  });
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
  assert.match(markdown, /Literal string matches suppress cleanup candidates/);
  assert.match(markdown, /Deletion readiness: blocked/);
  assert.match(markdown, /No complete supported closed-world analysis is configured/);
  assert.match(markdown, /Human validation required/);
  assert.match(markdown, /Pass --confirm-closed-world for each apply run after confirming the configured roots cover every runtime entrypoint/i);
  assert.match(markdown, /closed-world-not-configured/);
  assert.match(markdown, /package\.json entrypoints/);
  assert.match(html, /<main>/);
  assert.match(html, /src\/unused\.ts/);
  assert.match(html, /Dynamic-usage hints/);
  assert.match(html, /Zero coverage is not proof/);
  assert.match(html, /Literal string matches suppress cleanup candidates/);
  assert.match(html, /Deletion readiness.*blocked/);
  assert.match(html, /No complete supported closed-world analysis is configured/);
  assert.match(html, /Human validation required/);
  assert.match(html, /Pass --confirm-closed-world for each apply run after confirming the configured roots cover every runtime entrypoint/i);
  assert.match(html, /closed-world-not-configured/);
  assert.match(html, /package\.json entrypoints/);
  assert.doesNotMatch(html, /<script>/i);
});

test('reports owner confirmations even when automated scans find no dynamic hints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-report-human-gate-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), 'export const entry = true;');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;');

  const report = JSON.parse(renderReport(await planRepository(root, {knipExecutable: 'not-installed'}), 'json'));

  assert.deepEqual(report.deletionReadiness.automatedBlockers, ['engine-proof-unavailable']);
  assert.deepEqual(report.deletionReadiness.humanChecks, ['confirm-closed-world-at-apply']);
});

test('lists every additional incomplete automated scan as a blocker', async () => {
  const plan = await planRepository(await fixture(), {knipExecutable: 'not-installed'});
  plan.graph.unresolved.push({from: 'src/index.ts', specifier: './missing', kind: 'import'});
  plan.packageEntrypoints.invalidManifests.push('packages/broken/package.json');
  plan.stringReferences.unreadableFiles.push('src/unreadable.ts');

  const report = JSON.parse(renderReport(plan, 'json'));
  assert.deepEqual(report.deletionReadiness.automatedBlockers, [
    'engine-proof-unavailable',
    'dynamic-usage-hints',
    'unresolved-local-references',
    'invalid-package-manifest',
    'unreadable-reference-scan',
  ]);
  const markdown = renderReport(plan, 'markdown');
  assert.match(markdown, /local references could not be resolved/);
  assert.match(markdown, /package manifests could not be analyzed/);
  assert.match(markdown, /files could not be scanned for literal references/);
});

test('reports the source and specifier of unresolved references in every format', async () => {
  const root = await fixture();
  await writeFile(join(root, 'src', 'broken.ts'), "import './missing<widget>';\n");
  const plan = await planRepository(root, {runExternalTools: false});
  const json = JSON.parse(renderReport(plan, 'json'));
  assert.equal(json.unresolvedReferences, 1);
  assert.deepEqual(json.unresolvedReferenceDetails, [{from: 'src/broken.ts', specifier: './missing<widget>', kind: 'import'}]);
  const markdown = renderReport(plan, 'markdown');
  assert.match(markdown, /Unresolved local references/);
  assert.match(markdown, /src\/broken\.ts/);
  assert.match(markdown, /\.\/missing&lt;widget&gt;/);
  const html = renderReport(plan, 'html');
  assert.match(html, /src\/broken\.ts/);
  assert.match(html, /\.\/missing&lt;widget&gt;/);
  assert.doesNotMatch(html, /<widget>/);
});

test('reports incomplete discovery and skipped dynamic-hint scanning in JSON, Markdown, and HTML', async () => {
  const root = await fixture();
  await mkdir(join(root, 'src', 'unreadable'), {recursive: true});
  await writeFile(join(root, 'src', 'unreadable', 'hidden.ts'), 'export {}\n');
  const unreadablePath = join(root, 'src', 'unreadable');
  const discoveryReader = async (path) => {
    if (path === unreadablePath) throw new Error('permission denied during discovery');
    return readdir(path, {withFileTypes: true});
  };
  const plan = await planRepository(root, {runExternalTools: false, discoveryReader});

  assert.equal(plan.discoveryStatus, 'partial');
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.dynamicHints, []);
  const json = JSON.parse(renderReport(plan, 'json'));
  assert.deepEqual(json.repositoryDiscovery, {
    status: 'partial',
    errors: [{path: 'src/unreadable', message: 'permission denied during discovery'}],
  });
  assert.equal(json.dynamicHintsStatus, 'skipped-incomplete-discovery');
  const markdown = renderReport(plan, 'markdown');
  assert.match(markdown, /Repository discovery: partial/);
  assert.match(markdown, /Dynamic-usage scan: skipped because repository discovery was incomplete/i);
  assert.match(markdown, /src\/unreadable.*permission denied during discovery/);
  const html = renderReport(plan, 'html');
  assert.match(html, /Repository discovery/);
  assert.match(html, /skipped because repository discovery was incomplete/i);
  assert.match(html, /src\/unreadable/);
});
