export type TelemetryConsent = 'off' | 'anonymous';

export type AuditStats = {
  scannedFiles: number;
  totalBytes: number;
  findings: number;
  errors: number;
  durationMs?: number;
};

export type AnonymousAuditEvent = {
  schemaVersion: 1;
  event: 'audit_completed';
  occurredAt: string;
  stats: AuditStats;
};

export type TelemetryAggregate = {
  schemaVersion: 1;
  audits: number;
  scannedFiles: number;
  totalBytes: number;
  findings: number;
  errors: number;
};

export const defaultRetentionDays = 30;

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value as number;
}

function normalizeStats(value: AuditStats): AuditStats {
  if (value === null || typeof value !== 'object') throw new Error('Telemetry stats must be an object');
  const stats = {
    scannedFiles: nonNegativeInteger(value.scannedFiles, 'scannedFiles'),
    totalBytes: nonNegativeInteger(value.totalBytes, 'totalBytes'),
    findings: nonNegativeInteger(value.findings, 'findings'),
    errors: nonNegativeInteger(value.errors, 'errors'),
    ...(value.durationMs === undefined ? {} : {durationMs: nonNegativeInteger(value.durationMs, 'durationMs')}),
  };
  return stats;
}

export function createAnonymousAuditEvent(consent: TelemetryConsent, stats: AuditStats, occurredAt = new Date().toISOString()): AnonymousAuditEvent | null {
  if (consent === 'off') return null;
  if (consent !== 'anonymous') throw new Error('Telemetry consent is invalid');
  const parsedDate = new Date(occurredAt);
  if (Number.isNaN(parsedDate.getTime())) throw new Error('Telemetry occurredAt must be a valid timestamp');
  return {schemaVersion: 1, event: 'audit_completed', occurredAt: parsedDate.toISOString(), stats: normalizeStats(stats)};
}

export function aggregateAnonymousAudits(events: readonly AnonymousAuditEvent[]): TelemetryAggregate {
  const aggregate = {schemaVersion: 1 as const, audits: 0, scannedFiles: 0, totalBytes: 0, findings: 0, errors: 0};
  for (const event of events) {
    if (event.schemaVersion !== 1 || event.event !== 'audit_completed') throw new Error('Telemetry event schema is invalid');
    const stats = normalizeStats(event.stats);
    aggregate.audits += 1;
    aggregate.scannedFiles += stats.scannedFiles;
    aggregate.totalBytes += stats.totalBytes;
    aggregate.findings += stats.findings;
    aggregate.errors += stats.errors;
  }
  return aggregate;
}

export function shouldRetain(createdAt: string, now = new Date(), retentionDays = defaultRetentionDays): boolean {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || retentionDays > 3650) throw new Error('retentionDays must be between 1 and 3650');
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) throw new Error('createdAt must be a valid timestamp');
  const ageMs = now.getTime() - created.getTime();
  return ageMs < retentionDays * 24 * 60 * 60 * 1000;
}
