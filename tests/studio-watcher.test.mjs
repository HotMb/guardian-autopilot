import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createStudioWatcher} from '../dist/studio-watcher.js';

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the local watcher');
}

test('local Studio watcher lists large and newly generated images without writing to the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guardian-studio-watch-'));
  let watcher;
  try {
    await mkdir(join(root, 'exports'), {recursive: true});
    await mkdir(join(root, '.guardian-quarantine'), {recursive: true});
    await writeFile(join(root, 'exports', 'large.png'), Buffer.from('12345'));
    await writeFile(join(root, 'small.jpg'), Buffer.from('123'));
    await writeFile(join(root, '.guardian-quarantine', 'hidden.png'), Buffer.from('123456789'));
    await writeFile(join(root, 'notes.txt'), 'not an image');
    const original = await readFile(join(root, 'exports', 'large.png'));

    watcher = await createStudioWatcher(root, {
      largeImageThresholdBytes: 4,
      reconcileMs: 100,
      debounceMs: 10,
      stabilityMs: 0,
      queueLimit: 10,
    });
    const initial = watcher.getSnapshot();
    assert.equal(initial.enabled, true);
    assert.equal(initial.imageCount, 2);
    assert.equal(initial.candidateCount, 1);
    assert.equal(initial.largeCount, 1);
    assert.equal(initial.newCount, 0);
    assert.deepEqual(initial.candidates.map((candidate) => candidate.path), ['exports/large.png']);
    assert.equal(initial.candidates[0].isLarge, true);
    assert.equal(initial.candidates[0].isNew, false);

    await writeFile(join(root, 'exports', 'generated-new.png'), Buffer.from('new'));
    const updated = await waitFor(() => {
      const state = watcher.getSnapshot();
      return state.candidates.some((candidate) => candidate.path === 'exports/generated-new.png') ? state : false;
    });
    assert.equal(updated.newCount, 1);
    assert.equal(updated.pendingCount, 0);
    assert.equal(updated.candidates.find((candidate) => candidate.path === 'exports/generated-new.png')?.isNew, true);
    assert.deepEqual(await readFile(join(root, 'exports', 'large.png')), original);
    assert.deepEqual((await readdir(root)).sort(), ['.guardian-quarantine', 'exports', 'notes.txt', 'small.jpg']);
  } finally {
    watcher?.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('local Studio watcher marks inventory coverage partial at its entry cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guardian-studio-watch-limit-'));
  let watcher;
  try {
    await writeFile(join(root, 'a.png'), Buffer.from('a'));
    await writeFile(join(root, 'b.png'), Buffer.from('b'));
    await writeFile(join(root, 'c.png'), Buffer.from('c'));
    watcher = await createStudioWatcher(root, {maxEntries: 2, reconcileMs: 100, debounceMs: 10});
    const state = watcher.getSnapshot();
    assert.equal(state.partial, true);
    assert.match(state.notice ?? '', /entry limit was reached/);
  } finally {
    watcher?.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('local Studio watcher refuses Guardian archive folders as watch roots', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'guardian-studio-watch-protected-'));
  const root = join(parent, '.guardian-quarantine');
  try {
    await mkdir(root);
    await assert.rejects(createStudioWatcher(root), /system folders cannot be watched/);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});
