import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canDelete, isProtectedPath, isSafePath, enforceChangeLimits} from '../dist/safeguards.js';

test('requires positive proof and high confidence before deletion', () => {
  const base = {
    id: 'candidate-1',
    path: 'src/legacy.ts',
    kind: 'unused-export',
  };

  assert.equal(canDelete({...base, evidence: [{type: 'no_import_references', confidence: 1}]}), false);
  assert.equal(canDelete({...base, evidence: [{type: 'positive_proof', confidence: 0.94}]}), false);
  assert.equal(canDelete({...base, evidence: [
    {type: 'no_import_references', confidence: 0.99},
    {type: 'positive_proof', confidence: 0.95},
  ]}), true);
});

test('protects secrets, migrations, databases and lock files', () => {
  assert.equal(isProtectedPath('.env.local'), true);
  assert.equal(isProtectedPath('config/service.pem'), true);
  assert.equal(isProtectedPath('db/schema.sql'), true);
  assert.equal(isProtectedPath('src/migrations/001-init.sql'), true);
  assert.equal(isProtectedPath('package-lock.json'), true);
  assert.equal(isProtectedPath('src/feature.ts'), false);
});

test('never treats paths outside the root or symlink escapes as safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-safeguards-'));
  const outside = await mkdtemp(join(tmpdir(), 'cleancode-outside-'));
  await writeFile(join(root, 'inside.ts'), 'export const inside = true;');
  await writeFile(join(outside, 'secret.ts'), 'export const secret = true;');

  assert.equal(isSafePath(join(root, 'inside.ts'), root), true);
  assert.equal(isSafePath(join(outside, 'secret.ts'), root), false);

  try {
    await symlink(join(outside, 'secret.ts'), join(root, 'escape.ts'));
    assert.equal(isSafePath(join(root, 'escape.ts'), root), false);
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
  }
});

test('enforces bounded file, line and byte changes', () => {
  assert.doesNotThrow(() => enforceChangeLimits({files: 2, lines: 10, bytes: 100}));
  assert.throws(() => enforceChangeLimits({files: 51, lines: 10, bytes: 100}), /file limit/);
  assert.throws(() => enforceChangeLimits({files: 2, lines: 501, bytes: 100}), /line limit/);
  assert.throws(() => enforceChangeLimits({files: 2, lines: 10, bytes: 100001}), /byte limit/);
});

