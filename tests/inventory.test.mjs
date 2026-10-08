import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildInventory, createInventoryCoalescer, writeInventory} from '../dist/inventory.js';

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'guardian-inventory-test-'));
}

test('builds an inventory and reuses unchanged asset hashes', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'logo.png'), 'same');
    await writeFile(join(root, 'notes.txt'), 'not hashed as an asset');

    const first = await buildInventory(root);
    assert.equal(first.hashedFiles, 1);
    assert.equal(first.reusedHashes, 0);
    assert.equal(first.index.files['assets/logo.png'].sha256.length, 64);
    await writeInventory(root, first.index);

    const second = await buildInventory(root);
    assert.equal(second.hashedFiles, 0);
    assert.equal(second.reusedHashes, 1);
    assert.equal(second.removedFiles, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rehashes changed assets and reports removed files', async () => {
  const root = await makeRoot();
  try {
    const asset = join(root, 'photo.webp');
    const removed = join(root, 'removed.png');
    await writeFile(asset, 'first');
    await writeFile(removed, 'gone');
    const first = await buildInventory(root);
    await writeInventory(root, first.index);

    await writeFile(asset, 'second');
    await utimes(asset, new Date(Date.now() + 3000), new Date(Date.now() + 3000));
    await rm(removed);
    const second = await buildInventory(root);

    assert.equal(second.hashedFiles, 1);
    assert.equal(second.reusedHashes, 0);
    assert.equal(second.removedFiles, 1);
    assert.notEqual(second.index.files['photo.webp'].sha256, first.index.files['photo.webp'].sha256);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('coalesces a burst of inventory requests for the same root', async () => {
  const root = await makeRoot();
  try {
    await writeFile(join(root, 'photo.png'), 'same');
    let builds = 0;
    const coalescer = createInventoryCoalescer(15, async (requestedRoot) => {
      builds += 1;
      return buildInventory(requestedRoot);
    });

    const results = await Promise.all([
      coalescer.request(root),
      coalescer.request(root),
      coalescer.request(root),
    ]);

    assert.equal(builds, 1);
    assert.strictEqual(results[0], results[1]);
    assert.strictEqual(results[1], results[2]);
    assert.equal(results[0].index.files['photo.png'].sha256.length, 64);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('coalescer shares builder failures with every waiting request', async () => {
  const root = await makeRoot();
  try {
    const failure = new Error('fixture failure');
    const coalescer = createInventoryCoalescer(0, async () => { throw failure; });
    const results = await Promise.allSettled([coalescer.request(root), coalescer.request(root)]);

    assert.deepEqual(results, [
      {status: 'rejected', reason: failure},
      {status: 'rejected', reason: failure},
    ]);
  } finally { await rm(root, {recursive: true, force: true}); }
});
