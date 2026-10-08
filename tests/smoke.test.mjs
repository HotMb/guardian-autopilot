import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, writeFile, symlink, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scan} from '../dist/scanner.js';

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'guardian-test-'));
}

test('detects identical assets but never modifies anything', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.png'), 'equal');
    await writeFile(join(root, 'src', 'b.png'), 'equal');
    await writeFile(join(root, 'src', 'code.ts'), 'hello');
    const result = await scan(root);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.mode, 'read-only');
    assert.deepEqual(result.errors, []);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'review-only');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('ignores protected directories and matches uppercase asset extensions', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'src'), {recursive: true});
    await mkdir(join(root, 'node_modules', 'pkg'), {recursive: true});
    await mkdir(join(root, '.git'), {recursive: true});
    await writeFile(join(root, 'src', 'one.JPG'), 'same');
    await writeFile(join(root, 'src', 'two.jpg'), 'same');
    await writeFile(join(root, 'node_modules', 'pkg', 'ignored.png'), 'same');
    await writeFile(join(root, '.git', 'ignored.png'), 'same');

    const result = await scan(root);

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].sameAs, 'src/one.JPG');
    assert.equal(result.findings[0].file, 'src/two.jpg');
    assert.equal(result.scannedFiles, 2);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('does not follow symbolic links', async () => {
  const root = await makeRoot();
  const outside = await makeRoot();
  try {
    await writeFile(join(outside, 'outside.png'), 'same');
    await writeFile(join(root, 'inside.png'), 'same');
    try {
      await symlink(join(outside, 'outside.png'), join(root, 'linked.png'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return;
      throw error;
    }

    const result = await scan(root);

    assert.equal(result.scannedFiles, 1);
    assert.equal(result.findings.length, 0);
  } finally {
    await rm(root, {recursive:true, force:true});
    await rm(outside, {recursive:true, force:true});
  }
});

test('rejects a missing root and a file root', async () => {
  const root = await makeRoot();
  const file = join(root, 'file.txt');
  try {
    await writeFile(file, 'not a directory');
    await assert.rejects(() => scan(join(root, 'missing')), /Scan root cannot be read/);
    await assert.rejects(() => scan(file), /Scan root must be a directory/);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('hashes large assets without modifying them', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'a.webp'), Buffer.alloc(1024 * 1024, 7));
    await writeFile(join(root, 'assets', 'b.webp'), Buffer.alloc(1024 * 1024, 7));
    const before = await readFile(join(root, 'assets', 'a.webp'));
    const result = await scan(root);
    const after = await readFile(join(root, 'assets', 'a.webp'));

    assert.equal(result.findings[0].sameAs, 'assets/a.webp');
    assert.equal(result.findings[0].file, 'assets/b.webp');
    assert.deepEqual(after, before);
    assert.equal((await stat(join(root, 'assets', 'a.webp'))).size, 1024 * 1024);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('reports unreadable assets without aborting the scan', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const root = await makeRoot();
  const unreadable = join(root, 'private.png');
  try {
    await writeFile(unreadable, 'private');
    await chmod(unreadable, 0o000);

    const result = await scan(root);

    assert.ok(result.errors.some((error) => error.file === 'private.png'));
    assert.equal(result.mode, 'read-only');
  } finally {
    await chmod(unreadable, 0o600).catch(() => undefined);
    await rm(root, {recursive:true, force:true});
  }
});
