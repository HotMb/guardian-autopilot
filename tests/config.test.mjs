import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isIgnoredPath, isProtectedPath, loadConfig} from '../dist/config.js';
import {scan} from '../dist/scanner.js';

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'guardian-config-test-'));
}

test('loads defaults when no config exists', async () => {
  const root = await makeRoot();
  try {
    const config = await loadConfig(root);
    assert.deepEqual(config, {version: 1, protectedPaths: [], ignoredPaths: []});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('loads and normalizes a valid config', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, '.guardian'));
    await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({
      version: 1,
      protectedPaths: ['src\\secrets', './migrations/'],
      ignoredPaths: ['fixtures'],
      maxAssetBytes: 5000,
    }));

    const config = await loadConfig(root);

    assert.deepEqual(config, {
      version: 1,
      protectedPaths: ['src/secrets', 'migrations'],
      ignoredPaths: ['fixtures'],
      maxAssetBytes: 5000,
    });
    assert.equal(isProtectedPath(root, 'src/secrets/key.pem', config), true);
    assert.equal(isProtectedPath(root, 'config/.env.local', config), true);
    assert.equal(isIgnoredPath(root, 'fixtures/example.png', config), true);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rejects invalid versions and paths outside the root', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, '.guardian'));
    const configFile = join(root, '.guardian', 'config.json');
    await writeFile(configFile, JSON.stringify({version: 2}));
    await assert.rejects(() => loadConfig(root), /version must be 1/);
    await writeFile(configFile, JSON.stringify({version: 1, protectedPaths: ['../secrets']}));
    await assert.rejects(() => loadConfig(root), /must stay inside the scanned root/);
    await writeFile(configFile, JSON.stringify({version: 1, ignoredPaths: ['/tmp']}));
    await assert.rejects(() => loadConfig(root), /must stay inside the scanned root/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('scanner applies configured ignored paths and asset size limits', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, '.guardian'));
    await mkdir(join(root, 'ignored'), {recursive: true});
    await writeFile(join(root, '.guardian', 'config.json'), JSON.stringify({
      version: 1,
      ignoredPaths: ['ignored'],
      maxAssetBytes: 4,
    }));
    await writeFile(join(root, 'ignored', 'duplicate.png'), 'same');
    await writeFile(join(root, 'small.png'), 'same');
    await writeFile(join(root, 'large.png'), 'large');

    const result = await scan(root);

    assert.equal(result.scannedFiles, 2);
    assert.equal(result.findings.length, 0);
    assert.deepEqual(result.errors.map((error) => error.code), ['GUARDIAN_MAX_ASSET_BYTES']);
    assert.equal(result.errors[0].file, 'large.png');
  } finally { await rm(root, {recursive: true, force: true}); }
});
