import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuditLog} from '../dist/audit-log.js';

test('writes append-only JSONL audit events and reads them back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-audit-'));
  const path = join(root, 'audit.jsonl');
  const log = new AuditLog(path);
  await log.append({id: '1', action: 'create-worktree', state: 'ISOLATED', occurredAt: '2026-01-01T00:00:00.000Z'});
  await log.append({id: '2', action: 'rollback', state: 'REVERTED', occurredAt: '2026-01-01T00:01:00.000Z', details: {files: 1}});

  const events = await log.read();
  assert.equal(events.length, 2);
  assert.equal(events[1].state, 'REVERTED');
  assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 2);
});

test('rejects malformed audit events instead of silently recording them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-audit-invalid-'));
  const log = new AuditLog(join(root, 'audit.jsonl'));
  await assert.rejects(() => log.append({id: '', action: 'bad', state: 'REVERTED', occurredAt: 'invalid'}), /audit event/i);
});

