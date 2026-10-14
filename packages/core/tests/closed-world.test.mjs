import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {mkdir, mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {analyzeClosedWorld, validateClosedWorldProof} from '../dist/closed-world.js';
import {getPositiveProofBinding, isEngineVerifiedPositiveProof} from '../dist/proof-evidence.js';

const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  return execFile('git', ['-C', root, ...args], {windowsHide: true});
}

async function repository({files = {}, roots = ['src/main.ts'], packageFields = {}, sourceConfig = {}} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'guardian-closed-world-'));
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(join(root, '.guardian'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'fixture-app', private: true, ...packageFields}, null, 2));
  await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({
    version: 1,
    protectedPaths: [],
    ignoredPaths: [],
    closedWorld: {profile: 'node-application-v1', commitment: 'all-runtime-roots-declared', entryFiles: roots},
  }, null, 2));
  await writeFile(join(root, 'src', 'main.ts'), 'export const boot = true;\n');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), {recursive: true});
    await writeFile(join(root, path), content);
  }
  for (const [path, content] of Object.entries(sourceConfig)) {
    await mkdir(join(root, path, '..'), {recursive: true});
    await writeFile(join(root, path), content);
  }
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Guardian Tests');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'closed-world fixture');
  return root;
}

test('proves only source files unreachable from every declared runtime root and binds the proof to the snapshot', async () => {
  const root = await repository({
    files: {
      'src/main.ts': "import {boot} from './used.js'; void boot;\n",
      'src/used.js': 'export const boot = true;\n',
      'src/orphan.ts': "import {helper} from './orphan-helper.js'; void helper;\n",
      'src/orphan-helper.js': 'export const helper = true;\n',
    },
  });

  const result = await analyzeClosedWorld(root);
  assert.equal(result.complete, true);
  assert.deepEqual(result.roots, ['src/main.ts']);
  assert.deepEqual(result.reachable, ['src/main.ts', 'src/used.js']);
  assert.deepEqual(result.unreachable, ['src/orphan-helper.js', 'src/orphan.ts']);
  const proof = result.proofs.get('src/orphan.ts');
  assert.ok(proof);
  const binding = getPositiveProofBinding(proof);
  assert.equal(binding.analyzer, 'guardian-closed-world-node-application');
  assert.equal(binding.candidatePath, 'src/orphan.ts');
  assert.match(binding.candidateSha256, /^[a-f0-9]{64}$/);
  assert.match(binding.repositoryHead, /^[a-f0-9]{40}$/);
  assert.match(binding.configSha256, /^[a-f0-9]{64}$/);
  assert.match(binding.manifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(binding.roots, ['src/main.ts']);
  await validateClosedWorldProof(root, 'src/orphan.ts', proof);

  const serialized = JSON.parse(JSON.stringify(proof));
  assert.equal(isEngineVerifiedPositiveProof(serialized), false);
  assert.equal(getPositiveProofBinding(serialized), undefined);
});

test('rejects a proof after candidate bytes change in a new clean Git HEAD', async () => {
  const root = await repository({files: {'src/orphan.ts': 'export const oldValue = true;\n'}});
  const proof = (await analyzeClosedWorld(root)).proofs.get('src/orphan.ts');
  assert.ok(proof);
  await writeFile(join(root, 'src/orphan.ts'), 'export const changedValue = true;\n');
  await git(root, 'add', 'src/orphan.ts');
  await git(root, 'commit', '-qm', 'change candidate');

  await assert.rejects(() => validateClosedWorldProof(root, 'src/orphan.ts', proof), /proof is stale/i);
});

test('blocks missing explicit roots, public packages, and package scripts', async (t) => {
  const noRoots = await repository({roots: []}).catch(async (error) => {
    // The configuration loader rejects the empty list before repository creation can succeed.
    const root = await repository();
    const configPath = join(root, '.guardian', 'config.json');
    const value = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8'));
    value.closedWorld.entryFiles = [];
    await writeFile(configPath, JSON.stringify(value));
    await git(root, 'add', '.guardian/config.json');
    await git(root, 'commit', '-qm', 'remove roots');
    return root;
  });
  const rootsResult = await analyzeClosedWorld(noRoots);
  assert.equal(rootsResult.complete, false);
  assert.ok(rootsResult.blockers.some((item) => /entryFiles|runtime root/i.test(item.message)));

  const publicPackage = await repository({packageFields: {private: false}, files: {'src/orphan.ts': 'export {};\n'}});
  const publicResult = await analyzeClosedWorld(publicPackage);
  assert.equal(publicResult.complete, false);
  assert.ok(publicResult.blockers.some((item) => item.code === 'package-not-private'));

  const scripts = await repository({packageFields: {scripts: {start: 'node src/main.ts'}}});
  const scriptsResult = await analyzeClosedWorld(scripts);
  assert.equal(scriptsResult.complete, false);
  assert.ok(scriptsResult.blockers.some((item) => item.code === 'unsupported-package-scripts'));

  const dependencies = await repository({packageFields: {dependencies: {plugin: '1.0.0'}}, files: {'src/orphan.ts': 'export {};\n'}});
  const dependenciesResult = await analyzeClosedWorld(dependencies);
  assert.equal(dependenciesResult.complete, false);
  assert.ok(dependenciesResult.blockers.some((item) => item.code === 'unsupported-package-dependencies'));
});

test('allows only explicit safe node-prefixed built-ins and blocks command roots', async (t) => {
  const safeBuiltin = await repository({files: {'src/main.ts': "import {basename} from 'node:path'; void basename;\n"}});
  const safeResult = await analyzeClosedWorld(safeBuiltin);
  assert.equal(safeResult.complete, true, JSON.stringify(safeResult.blockers));

  for (const [path, contents] of [
    ['src/main.ts', "import 'some-plugin';\n"],
    ['maintenance.py', 'print("launch app")\n'],
    ['scripts/clean.ps1', 'node src/main.js\n'],
    ['.github/workflows/check.yml', 'run: node src/main.js\n'],
  ]) {
    await t.test(path, async () => {
      const root = await repository(path === 'src/main.ts'
        ? {files: {'src/main.ts': contents}}
        : {sourceConfig: {[path]: contents}});
      const result = await analyzeClosedWorld(root);
      assert.equal(result.complete, false);
      assert.equal(result.proofs.size, 0);
      assert.ok(result.blockers.some((item) => ['unsupported-external-module', 'unsupported-command-root'].includes(item.code)), JSON.stringify(result.blockers));
    });
  }
});

test('blocks source syntax and loader patterns that could load files outside the resolved graph', async (t) => {
  const cases = [
    ['dynamic import', "void import('./src/orphan.js');\n", 'dynamic-import'],
    ['aliased require', "const load = require; load('./orphan.js');\n", 'dynamic-or-reflective-loader'],
    ['computed module access', "const key = 'require'; module[key]('./orphan.js');\n", 'dynamic-or-reflective-loader'],
    ['child process loader', "const child = require('node:child_process'); void child;\n", 'forbidden-loader-module'],
    ['worker loader', "const worker = require('node:worker_threads'); void worker;\n", 'forbidden-loader-module'],
    ['vm loader', "const vm = require('node:vm'); void vm;\n", 'forbidden-loader-module'],
    ['parse error', 'export const = ;\n', 'source-parse-failed'],
    ['unresolved edge', "import './missing.js';\n", 'unresolved-local-edge'],
    ['extensionless edge', "import './orphan';\n", 'unsupported-local-edge'],
  ];
  for (const [label, source, expectedCode] of cases) {
    await t.test(label, async () => {
      const root = await repository({files: {'src/main.ts': source, 'src/orphan.js': 'export {};\n'}});
      const result = await analyzeClosedWorld(root);
      assert.equal(result.complete, false);
      assert.equal(result.proofs.size, 0);
      assert.ok(result.blockers.some((item) => item.code === expectedCode), JSON.stringify(result.blockers));
    });
  }
});

test('blocks constructor-chain loaders and equivalent reflective property access', async (t) => {
  const cases = [
    ['reported constructor chain', `const req = ({}).constructor.constructor("return process.mainModule.require")(); req('./orphan.js');\n`],
    ['constructor dot chain', `const req = ({}).constructor.constructor('return require')(); req('./orphan.js');\n`],
    ['literal bracket constructor', `const req = ({} )['constructor']['constructor']('return require')(); req('./orphan.js');\n`],
    ['concatenated computed constructor', `const req = ({} )['con' + 'structor']['constructor']('return require')(); req('./orphan.js');\n`],
    ['unknown computed key', `const key = getKey(); const req = ({} )[key]; req('./orphan.js');\n`],
    ['prototype reflection alias', `const getProto = Object.getPrototypeOf; const proto = getProto({}); void proto.constructor;\n`],
    ['descriptor reflection', `const descriptor = Object.getOwnPropertyDescriptor({}, 'constructor'); void descriptor;\n`],
    ['descriptor reflection exposes process alias', `const p = Object.getOwnPropertyDescriptor(globalThis, 'process').value; p.mainModule.require('./orphan.js');\n`],
    ['Node 24 builtin module and createRequire aliases', `const p = process; const mod = p.getBuiltinModule('module'); const make = mod.createRequire; const req = make.call(mod, p.cwd() + '/src/main.js'); req('./orphan.js');\n`],
    ['process alias with computed require key', `const p = process; const m = p.mainModule; m['require']('./orphan.js');\n`],
    ['aliased process with computed loader key', `const p = process; const key = 're' + 'quire'; p.mainModule[key]('./orphan.js');\n`],
    ['CommonJS wrapper arguments require', `arguments[1]('./orphan.js');\n`],
  ];
  for (const [label, source] of cases) {
    await t.test(label, async () => {
      const root = await repository({files: {'src/main.ts': source, 'src/orphan.js': 'export {};\n'}});
      const result = await analyzeClosedWorld(root);
      assert.equal(result.complete, false);
      assert.equal(result.proofs.size, 0);
      assert.ok(result.blockers.some((item) => item.code === 'dynamic-or-reflective-loader'), JSON.stringify(result.blockers));
    });
  }
});

test('blocks unsupported framework/source configuration and TypeScript path aliases', async (t) => {
  const angular = await repository({sourceConfig: {'angular.json': '{"projects":{}}'}});
  const angularResult = await analyzeClosedWorld(angular);
  assert.equal(angularResult.complete, false);
  assert.ok(angularResult.blockers.some((item) => item.code === 'unsupported-source-config'));

  const aliases = await repository({sourceConfig: {'tsconfig.json': JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}})}});
  const aliasesResult = await analyzeClosedWorld(aliases);
  assert.equal(aliasesResult.complete, false);
  assert.ok(aliasesResult.blockers.some((item) => item.code === 'unsupported-source-config'));
});

test('fails closed on dirty checkouts and symlinks', async (t) => {
  const dirty = await repository({files: {'src/orphan.ts': 'export {};\n'}});
  await writeFile(join(dirty, 'src/orphan.ts'), 'local edit\n');
  const dirtyResult = await analyzeClosedWorld(dirty);
  assert.equal(dirtyResult.complete, false);
  assert.ok(dirtyResult.blockers.some((item) => item.code === 'dirty-git-tree'));
  assert.equal(dirtyResult.proofs.size, 0);

  const linked = await repository();
  const external = await mkdtemp(join(tmpdir(), 'guardian-outside-'));
  await writeFile(join(external, 'hidden.js'), 'export {};\n');
  try {
    await symlink(external, join(linked, 'linked'), 'junction');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('Windows account cannot create a directory junction');
      return;
    }
    throw error;
  }
  const linkResult = await analyzeClosedWorld(linked);
  assert.equal(linkResult.complete, false);
  assert.ok(linkResult.blockers.some((item) => item.code === 'repository-discovery-failed' && /symlink/i.test(item.message)));
  assert.equal(linkResult.proofs.size, 0);
});
