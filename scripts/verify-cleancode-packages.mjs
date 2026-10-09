import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const packageNames = ['shared', 'core', 'license', 'cli'];

for (const name of packageNames) {
  const packageRoot = new URL(`../packages/${name}/`, import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
  assert.equal(packageJson.private, false, `${name} must be publishable`);
  assert.deepEqual(packageJson.files, ['dist'], `${name} must publish only dist`);
  assert.equal(packageJson.publishConfig?.access, 'public', `${name} must declare public access`);
  await readFile(new URL('dist/index.js', packageRoot), 'utf8');
}

const cli = await readFile(new URL('../packages/cli/dist/index.js', import.meta.url), 'utf8');
assert.match(cli, /@cleancode\/core/);
assert.doesNotMatch(cli, /\.\.\/\.\/(?:core|license|shared)\/dist/);

const core = await readFile(new URL('../packages/core/dist/index.js', import.meta.url), 'utf8');
assert.doesNotMatch(core, /\.\.\/\.\/shared\/dist/);

console.log(`CleanCode package verification passed: ${packageNames.length} publishable packages.`);
