import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildManifest, discoverRepository} from '../dist/manifest.js';

test('discovers source files deterministically and ignores generated trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-discovery-'));
  await mkdir(join(root, 'src', 'nested'), {recursive: true});
  await mkdir(join(root, 'dist'), {recursive: true});
  await mkdir(join(root, 'node_modules', 'dependency'), {recursive: true});
  await writeFile(join(root, 'src', 'z.ts'), 'export const z = 1;');
  await writeFile(join(root, 'src', 'nested', 'a.ts'), 'export const a = 1;');
  await writeFile(join(root, 'dist', 'generated.js'), 'generated');
  await writeFile(join(root, 'node_modules', 'dependency', 'index.js'), 'dependency');

  const result = await discoverRepository(root);

  assert.deepEqual(result.files, ['src/nested/a.ts', 'src/z.ts']);
  assert.deepEqual(result.errors, []);
});

test('skips symlinked entries and hashes manifest files with SHA-256', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-manifest-'));
  const outside = await mkdtemp(join(tmpdir(), 'cleancode-manifest-outside-'));
  await writeFile(join(root, 'entry.ts'), 'hello');
  await writeFile(join(outside, 'secret.ts'), 'secret');

  let createdLink = false;
  try {
    await symlink(join(outside, 'secret.ts'), join(root, 'linked.ts'));
    createdLink = true;
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
  }

  const manifest = await buildManifest(root);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.files.map((file) => file.path), ['entry.ts']);
  assert.equal(manifest.files[0].sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(manifest.files[0].bytes, 5);
  if (createdLink) {
    // Unknown/legacy runtime values must fail safe as skip, never as follow.
    const legacyFollow = await discoverRepository(root, {symlinks: 'follow'});
    assert.deepEqual(legacyFollow.files, ['entry.ts']);
    await assert.rejects(() => discoverRepository(root, {symlinks: 'error'}), /symlink encountered: linked\.ts/i);
  }
});

test('never traverses a directory symlink to an external target, including legacy follow values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-symlink-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'cleancode-symlink-outside-'));
  await writeFile(join(outside, 'secret.ts'), 'must never be read');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  let createdLink = false;
  try {
    await symlink(outside, join(root, 'external'), linkType);
    createdLink = true;
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
  }
  if (!createdLink) return;

  const result = await discoverRepository(root, {symlinks: 'follow'});
  assert.deepEqual(result.files, []);
  await assert.rejects(() => discoverRepository(root, {symlinks: 'error'}), /symlink encountered: external/i);
});

test('ignores the .git pointer file used by linked worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-worktree-manifest-'));
  await writeFile(join(root, '.git'), 'gitdir: C:/private/worktrees/example/.git/worktrees/app\n');
  await writeFile(join(root, 'entry.ts'), 'export const entry = true;\n');

  const manifest = await buildManifest(root);
  assert.deepEqual(manifest.files.map((file) => file.path), ['entry.ts']);
});

