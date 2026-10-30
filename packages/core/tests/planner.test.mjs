import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_IGNORE_PATTERNS} from '../dist/manifest.js';
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

test('planner reports measured phases and reuses one repository discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-measured-plan-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import { used } from './used'; void used;\n");
  await writeFile(join(root, 'src', 'used.ts'), 'export const used = true;\n');
  let directoryReads = 0;
  const events = [];

  const report = await planRepository(root, {
    entryFiles: ['src/index.ts'],
    runExternalTools: false,
    discoveryReader: async (path) => {
      directoryReads += 1;
      return readdir(path, {withFileTypes: true});
    },
    onProgress: (event) => events.push(event),
  });

  assert.equal(report.discoveryStatus, 'complete');
  assert.equal(directoryReads, 2, 'the root and src directory should each be discovered once');
  assert.equal(events.some((event) => event.phase === 'manifest' && event.state === 'progress' && event.total === 2), true);
  for (const phase of ['repository-config', 'manifest', 'reference-graph', 'closed-world-analysis', 'knip-analysis', 'dynamic-hints', 'metadata-scans', 'string-reference-scan']) {
    assert.equal(events.some((event) => event.phase === phase && event.state === 'completed'), true, `missing measured phase ${phase}`);
  }
});

test('partial discovery preserves errors and returns no candidates without external execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-partial-plan-'));
  await mkdir(join(root, 'src', 'unreadable'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n');
  await writeFile(join(root, 'src', 'unreadable', 'maybe-unused.ts'), 'export {}\n');

  const discoveryReader = async (path) => {
    if (path === join(root, 'src', 'unreadable')) {
      throw Object.assign(new Error('injected unreadable directory'), {code: 'EACCES'});
    }
    return readdir(path, {withFileTypes: true});
  };
  const report = await planRepository(root, {entryFiles: [], discoveryReader, runExternalTools: false});

  assert.equal(report.discoveryStatus, 'partial');
  assert.deepEqual(report.discoveryErrors, [{path: 'src/unreadable', message: 'injected unreadable directory'}]);
  assert.deepEqual(report.manifest.errors, report.discoveryErrors);
  assert.deepEqual(report.graph.errors, report.discoveryErrors);
  assert.deepEqual(report.candidates, []);
  assert.equal(report.closedWorld.complete, false);
  assert.equal(report.closedWorld.blockers.some((blocker) => blocker.code === 'repository-discovery-failed'), true);
  assert.equal(report.knip.status, 'unavailable');
  assert.match(report.knip.error, /discovery was incomplete/i);
});

test('symlinked imports make discovery partial and suppress every heuristic candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-symlink-plan-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import './alias';\n");
  await writeFile(join(root, 'src', 'implementation.ts'), 'export const value = true;\n');
  const entry = (name, kind) => ({
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  });
  const discoveryReader = async (path) => path === root
    ? [entry('src', 'directory')]
    : path === join(root, 'src')
      ? [entry('alias.ts', 'symlink'), entry('implementation.ts', 'file'), entry('index.ts', 'file')]
      : readdir(path, {withFileTypes: true});

  const report = await planRepository(root, {runExternalTools: false, discoveryReader});

  assert.equal(report.discoveryStatus, 'partial');
  assert.ok(report.discoveryErrors.some(({path}) => path === 'src/alias.ts'));
  assert.deepEqual(report.candidates, []);
  assert.equal(report.closedWorld.complete, false);
});

test('external execution can be disabled for a complete read-only plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-no-external-tools-'));
  await writeFile(join(root, 'index.ts'), 'export {}\n');

  const report = await planRepository(root, {entryFiles: [], runExternalTools: false});

  assert.equal(report.discoveryStatus, 'complete');
  assert.equal(report.knip.status, 'unavailable');
  assert.match(report.knip.error, /external execution is disabled/i);
  assert.equal(report.closedWorld.complete, false);
  assert.equal(report.closedWorld.blockers[0].code, 'external-execution-disabled');
});

test('reports sorted default and configured ignored paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-reported-ignore-paths-'));
  await mkdir(join(root, '.guardian'), {recursive: true});
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({version: 1, ignoredPaths: ['vendor/cache', 'src/generated']}));
  await writeFile(join(root, 'index.ts'), 'export {}\n');

  const report = await planRepository(root, {runExternalTools: false});

  assert.deepEqual(report.ignoredPaths, [...new Set([...DEFAULT_IGNORE_PATTERNS, 'vendor/cache', 'src/generated'])].sort((left, right) => left.localeCompare(right)));
});

test('does not propose convention-discovered test files as unreferenced production code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-test-files-'));
  await mkdir(join(root, 'tests'), {recursive: true});
  await mkdir(join(root, 'src', '__tests__'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n');
  await writeFile(join(root, 'tests', 'billing.test.ts'), 'export const testCase = true;\n');
  await writeFile(join(root, 'src', '__tests__', 'billing.spec.tsx'), 'export const testCase = true;\n');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;\n');

  const report = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'not-installed'});

  assert.equal(report.candidates.some((candidate) => candidate.path === 'tests/billing.test.ts'), false);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/__tests__/billing.spec.tsx'), false);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/unused.ts'), true);
});

test('excludes test/spec suffixes outside test directories from unreferenced and duplicate candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-test-suffixes-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'index.ts'), "import './a-fixture';\n");
  await writeFile(join(root, 'src', 'a-fixture.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'billing.test.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'dashboard.spec.tsx'), 'export {};\n');
  await writeFile(join(root, 'src', 'types.test.d.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'unused.ts'), 'export const unused = true;\n');

  const report = await planRepository(root, {entryFiles: ['src/index.ts'], knipExecutable: 'not-installed'});
  const testPaths = ['src/billing.test.ts', 'src/dashboard.spec.tsx', 'src/types.test.d.ts'];

  for (const path of testPaths) {
    assert.equal(report.candidates.some((candidate) => candidate.path === path), false, `${path} must not be proposed`);
  }
  assert.equal(report.duplicates.some((group) => group.duplicates.some((path) => testPaths.includes(path))), true);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'src/unused.ts'), true);
});

test('protects convention-discovered Next.js route entrypoints from both candidate types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-next-entrypoints-'));
  await mkdir(join(root, 'app', 'dashboard'), {recursive: true});
  await mkdir(join(root, 'src', 'app', 'settings'), {recursive: true});
  await mkdir(join(root, 'pages', 'api'), {recursive: true});
  await mkdir(join(root, 'src', 'pages'), {recursive: true});
  await writeFile(join(root, 'a-canonical.tsx'), 'export default function Page() { return null; }\n');
  await writeFile(join(root, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
  await writeFile(join(root, 'app', 'layout.tsx'), 'export default function Layout({children}) { return children; }\n');
  await writeFile(join(root, 'app', 'dashboard', 'page.tsx'), 'export default function Dashboard() { return null; }\n');
  await writeFile(join(root, 'src', 'app', 'settings', 'route.ts'), 'export async function GET() { return new Response(); }\n');
  await writeFile(join(root, 'pages', 'index.tsx'), 'export default function Home() { return null; }\n');
  await writeFile(join(root, 'pages', 'api', 'health.ts'), 'export default function health() { return null; }\n');
  await writeFile(join(root, 'src', 'pages', 'account.tsx'), 'export default function Account() { return null; }\n');
  await writeFile(join(root, 'app', 'helper.ts'), 'export const helper = true;\n');

  const report = await planRepository(root, {entryFiles: [], knipExecutable: 'not-installed'});
  const routePaths = [
    'app/page.tsx', 'app/layout.tsx', 'app/dashboard/page.tsx', 'src/app/settings/route.ts',
    'pages/index.tsx', 'pages/api/health.ts', 'src/pages/account.tsx',
  ];

  for (const path of routePaths) {
    assert.equal(report.candidates.some((candidate) => candidate.path === path), false, `${path} must not be proposed`);
  }
  assert.equal(report.candidates.some((candidate) => candidate.path === 'app/helper.ts'), true);
  assert.equal(report.candidates.some((candidate) => candidate.path === 'app/page.tsx' && candidate.kind === 'exact-duplicate'), false);
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

test('excludes WordPress-enqueued JavaScript assets referenced from PHP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-wordpress-enqueue-'));
  await mkdir(join(root, 'js'), {recursive: true});
  await writeFile(join(root, 'index.php'), "wp_enqueue_script('isotope', get_template_directory_uri() . '/js/isotope.pkgd.min.js');\n");
  await writeFile(join(root, 'js', 'isotope.pkgd.min.js'), '/* vendor script */\n');

  const report = await planRepository(root, {entryFiles: [], knipExecutable: 'not-installed'});

  assert.equal(report.candidates.some((candidate) => candidate.path === 'js/isotope.pkgd.min.js'), false);
  assert.equal(report.stringReferences.references.some((reference) => reference.target === 'js/isotope.pkgd.min.js' && reference.source === 'index.php'), true);
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

