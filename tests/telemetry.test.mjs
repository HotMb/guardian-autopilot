import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateAnonymousAudits,
  createAnonymousAuditEvent,
  shouldRetain,
} from '../dist/telemetry.js';

test('telemetry is opt-in and contains only anonymous aggregate statistics', () => {
  const stats = {scannedFiles: 10, totalBytes: 2048, findings: 2, errors: 1, durationMs: 42};
  assert.equal(createAnonymousAuditEvent('off', stats), null);
  const event = createAnonymousAuditEvent('anonymous', stats, '2026-01-02T03:04:05Z');
  assert.deepEqual(event, {
    schemaVersion: 1,
    event: 'audit_completed',
    occurredAt: '2026-01-02T03:04:05.000Z',
    stats,
  });
  assert.equal('root' in event, false);
  assert.equal('paths' in event, false);
  assert.equal('hashes' in event, false);
});

test('telemetry aggregates events without identities or source content', () => {
  const first = createAnonymousAuditEvent('anonymous', {scannedFiles: 2, totalBytes: 10, findings: 1, errors: 0}, '2026-01-01T00:00:00Z');
  const second = createAnonymousAuditEvent('anonymous', {scannedFiles: 3, totalBytes: 20, findings: 0, errors: 2}, '2026-01-02T00:00:00Z');
  assert.deepEqual(aggregateAnonymousAudits([first, second]), {
    schemaVersion: 1,
    audits: 2,
    scannedFiles: 5,
    totalBytes: 30,
    findings: 1,
    errors: 2,
  });
});

test('telemetry rejects malformed data and expires records by policy', () => {
  assert.throws(() => createAnonymousAuditEvent('anonymous', {scannedFiles: -1, totalBytes: 0, findings: 0, errors: 0}), /scannedFiles/);
  assert.throws(() => createAnonymousAuditEvent('anonymous', {scannedFiles: 0, totalBytes: 0, findings: 0, errors: 0}, 'not-a-date'), /occurredAt/);
  const now = new Date('2026-02-01T00:00:00Z');
  assert.equal(shouldRetain('2026-01-15T00:00:00Z', now, 30), true);
  assert.equal(shouldRetain('2025-12-01T00:00:00Z', now, 30), false);
  assert.throws(() => shouldRetain('2026-01-01T00:00:00Z', now, 0), /between 1 and 3650/);
});
