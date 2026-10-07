import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planCandidates} from '../dist/candidates.js';

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'guardian-candidates-test-'));
}

test('ranks an unreferenced duplicate against a referenced canonical asset', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'App.tsx'), "export const logo = './a-logo.png';");
    await writeFile(join(root, 'src', 'a-logo.png'), 'same');
    await writeFile(join(root, 'src', 'z-logo-copy.png'), 'same');

    const result = await planCandidates(root);

    assert.equal(result.mode, 'read-only');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].file, 'src/z-logo-copy.png');
    assert.equal(result.candidates[0].sameAs, 'src/a-logo.png');
    assert.equal(result.candidates[0].confidence, 'high');
    assert.equal(result.candidates[0].action, 'review-only');
    assert.deepEqual(result.candidates[0].evidence.fileReferences, []);
    assert.equal(result.candidates[0].evidence.canonicalReferences.length, 1);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('downgrades a duplicate that is still referenced', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'App.tsx'), "export const a = './a.png'; export const b = './b.png';");
    await writeFile(join(root, 'src', 'a.png'), 'same');
    await writeFile(join(root, 'src', 'b.png'), 'same');

    const result = await planCandidates(root);

    assert.equal(result.candidates[0].confidence, 'low');
    assert.match(result.candidates[0].evidence.reasons.join(' '), /still referenced/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
