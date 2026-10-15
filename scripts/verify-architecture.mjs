import {readdir, readFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedDependencies = new Map([
  ['@cleancode/shared', []],
  ['@cleancode/license', []],
  ['@cleancode/core', ['@cleancode/shared']],
  ['@cleancode/cli', ['@cleancode/core', '@cleancode/license', '@cleancode/shared']],
  ['@guardian-autopilot/desktop', []],
]);

function internalDependencies(manifest) {
  const keys = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const result = new Set();
  for (const key of keys) {
    for (const name of Object.keys(manifest[key] ?? {})) {
      if (name.startsWith('@cleancode/') || name.startsWith('@guardian-autopilot/')) result.add(name);
    }
  }
  return [...result].sort();
}

export function findArchitectureViolations(rootPackage, workspacePackages) {
  const violations = [];
  const workspacePatterns = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  if (!workspacePatterns.includes('packages/*')) {
    violations.push('Root npm workspaces must include packages/*');
  }
  if (rootPackage.bin?.guardian !== './dist/cli.js') {
    violations.push('The root guardian binary must remain ./dist/cli.js');
  }
  if (rootPackage.scripts?.['verify:architecture'] !== 'node scripts/verify-architecture.mjs') {
    violations.push('Root scripts must expose verify:architecture');
  }
  if (!rootPackage.scripts?.test?.includes('npm run verify:architecture')) {
    violations.push('The root test command must run verify:architecture');
  }

  const names = workspacePackages.map((manifest) => manifest.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  for (const name of [...new Set(duplicates)].sort()) {
    violations.push('Workspace package name is duplicated: ' + name);
  }

  const expectedNames = [...expectedDependencies.keys()].sort();
  const actualNames = [...new Set(names)].sort();
  for (const name of expectedNames) {
    if (!actualNames.includes(name)) violations.push('Required workspace package is missing: ' + name);
  }
  for (const name of actualNames) {
    if (!expectedDependencies.has(name)) violations.push('Workspace package is not registered in the architecture contract: ' + name);
  }

  for (const [name, expected] of expectedDependencies) {
    const manifest = workspacePackages.find((item) => item.name === name);
    if (!manifest) continue;
    const actual = internalDependencies(manifest);
    const sortedExpected = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      violations.push(name + ' internal dependencies must be [' + sortedExpected.join(', ') + '], got [' + actual.join(', ') + ']');
    }
  }

  const cli = workspacePackages.find((manifest) => manifest.name === '@cleancode/cli');
  if (cli && cli.bin?.cleancode !== './dist/index.js') {
    violations.push('@cleancode/cli must expose ./dist/index.js as the cleancode binary');
  }

  const desktop = workspacePackages.find((manifest) => manifest.name === '@guardian-autopilot/desktop');
  if (desktop && desktop.private !== true) {
    violations.push('@guardian-autopilot/desktop must remain private and outside npm publication');
  }
  if (desktop && desktop.main !== 'main.mjs') {
    violations.push('@guardian-autopilot/desktop must keep main.mjs as its Electron entrypoint');
  }

  return violations;
}

export async function verifyArchitecture(projectRoot = repositoryRoot) {
  const rootPackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const packagesDirectory = join(projectRoot, 'packages');
  const directories = await readdir(packagesDirectory, {withFileTypes: true});
  const workspacePackages = [];
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    try {
      workspacePackages.push(JSON.parse(await readFile(join(packagesDirectory, entry.name, 'package.json'), 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
  }

  const violations = findArchitectureViolations(rootPackage, workspacePackages);
  if (violations.length > 0) {
    throw new Error(['Architecture contract failed:', ...violations.map((item) => '- ' + item)].join('\n'));
  }
  return {workspacePackages: workspacePackages.length};
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  verifyArchitecture()
    .then(({workspacePackages}) => console.log('Architecture contract passed: ' + workspacePackages + ' workspace packages and dependency boundaries are valid.'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
