import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));
const requireFile = (path) => {
  if (!existsSync(resolve(projectRoot, path))) throw new Error(`Required desktop package file is missing: ${path}`);
};

const rootPackage = readJson('package.json');
const desktopPackage = readJson('packages/desktop/package.json');
assert.equal(desktopPackage.version, rootPackage.version, 'Desktop and Guardian versions must match');
assert.equal(desktopPackage.main, 'main.mjs', 'Desktop workspace must expose its Electron entry point');
assert.ok(desktopPackage.devDependencies?.electron, 'Desktop workspace must declare Electron');
assert.ok(desktopPackage.devDependencies?.['@electron-forge/cli'], 'Desktop workspace must declare Electron Forge');
assert.equal(rootPackage.bin?.guardian, './dist/cli.js', 'The npm CLI entry point must remain unchanged');
assert.equal(rootPackage.main, undefined, 'The published CLI package must not point to the desktop entry point');

for (const path of [
  'packages/desktop/main.mjs',
  'packages/desktop/security-policy.mjs',
  'packages/desktop/forge.config.mjs',
  'dist/studio.js',
  'site/studio.html',
  'site/studio.js',
  'site/studio.css',
  'site/studio-worker.js',
  'site/studio-file-ops.js',
]) requireFile(path);

const main = readFileSync(resolve(projectRoot, 'packages/desktop/main.mjs'), 'utf8');
for (const required of ['standard: true', 'secure: true', 'supportFetchAPI: true', 'nodeIntegration: false', 'contextIsolation: true', 'sandbox: true', "setWindowOpenHandler(() => ({action: 'deny'}))"]) {
  assert.ok(main.includes(required), `Desktop security boundary is missing: ${required}`);
}

const forgeConfig = readFileSync(resolve(projectRoot, 'packages/desktop/forge.config.mjs'), 'utf8');
assert.match(forgeConfig, /path\.join\(projectRoot, 'dist'\)/);
assert.match(forgeConfig, /path\.join\(projectRoot, 'site'\)/);
assert.match(forgeConfig, /@electron-forge\/maker-squirrel/);

console.log('Desktop package verification passed: isolated Electron runtime, bundled Studio assets, and Windows installer configuration are present.');
