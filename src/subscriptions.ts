import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname, isAbsolute} from 'node:path';
import {normalizeEntitlementSnapshot, type EntitlementSnapshot} from './billing.js';

export type SubscriptionRecord = {
  subscriptionId: string;
  customerId?: string;
  eventId: string;
  updatedAt: number;
  snapshot: EntitlementSnapshot;
};

export type SubscriptionApplyResult = 'applied' | 'duplicate';

/**
 * Minimal persistence boundary for subscription webhooks.
 * Implementations must make apply atomic so a retried webhook cannot create
 * two state transitions for the same event id.
 */
export interface SubscriptionStore {
  apply(eventId: string, record: SubscriptionRecord): SubscriptionApplyResult | Promise<SubscriptionApplyResult>;
  get(subscriptionId: string): SubscriptionRecord | undefined | Promise<SubscriptionRecord | undefined>;
}

export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();
  private readonly processedEvents = new Set<string>();

  apply(eventId: string, record: SubscriptionRecord): SubscriptionApplyResult {
    if (eventId.trim() === '' || record.subscriptionId.trim() === '') throw new Error('Subscription identifiers are required');
    if (this.processedEvents.has(eventId)) return 'duplicate';
    this.processedEvents.add(eventId);
    this.records.set(record.subscriptionId, structuredClone(record));
    return 'applied';
  }

  get(subscriptionId: string): SubscriptionRecord | undefined {
    const record = this.records.get(subscriptionId);
    return record === undefined ? undefined : structuredClone(record);
  }
}

type PersistedSubscriptionState = {
  version: 1;
  processedEvents: string[];
  records: Record<string, SubscriptionRecord>;
};

function cloneRecord(record: SubscriptionRecord): SubscriptionRecord {
  return structuredClone(record);
}

function emptyState(): PersistedSubscriptionState {
  return {version: 1, processedEvents: [], records: {}};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value;
}

function parseRecord(value: unknown): SubscriptionRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Persisted subscription record must be an object');
  const raw = value as Record<string, unknown>;
  const subscriptionId = requiredString(raw.subscriptionId, 'Persisted subscription id');
  const eventId = requiredString(raw.eventId, 'Persisted event id');
  if (!Number.isSafeInteger(raw.updatedAt) || (raw.updatedAt as number) <= 0) throw new Error('Persisted subscription updatedAt is invalid');
  if (raw.customerId !== undefined) requiredString(raw.customerId, 'Persisted customer id');
  return {
    subscriptionId,
    ...(raw.customerId === undefined ? {} : {customerId: raw.customerId as string}),
    eventId,
    updatedAt: raw.updatedAt as number,
    snapshot: normalizeEntitlementSnapshot(raw.snapshot),
  };
}

function readState(filePath: string): PersistedSubscriptionState {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Persisted subscription store is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Persisted subscription store must be an object');
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.processedEvents) || raw.processedEvents.some((eventId) => typeof eventId !== 'string' || eventId.trim() === '')) {
    throw new Error('Persisted subscription store version or processed events are invalid');
  }
  if (new Set(raw.processedEvents).size !== raw.processedEvents.length) throw new Error('Persisted subscription store contains duplicate event ids');
  if (raw.records === null || typeof raw.records !== 'object' || Array.isArray(raw.records)) throw new Error('Persisted subscription records are invalid');
  const records: Record<string, SubscriptionRecord> = {};
  for (const [key, value] of Object.entries(raw.records as Record<string, unknown>)) {
    const record = parseRecord(value);
    if (key !== record.subscriptionId) throw new Error('Persisted subscription record key does not match its id');
    records[key] = record;
  }
  return {version: 1, processedEvents: [...raw.processedEvents], records};
}

/**
 * Small durable store for a single local webhook process. It writes a complete
 * versioned snapshot through a temporary file and rename, so a restart keeps
 * both subscription records and webhook de-duplication state.
 */
export class FileSubscriptionStore implements SubscriptionStore {
  private readonly filePath: string;
  private state: PersistedSubscriptionState;

  constructor(filePath: string) {
    if (!isAbsolute(filePath)) throw new Error('Subscription store path must be absolute');
    this.filePath = filePath;
    this.state = readState(filePath);
  }

  apply(eventId: string, record: SubscriptionRecord): SubscriptionApplyResult {
    if (eventId.trim() === '' || record.subscriptionId.trim() === '') throw new Error('Subscription identifiers are required');
    if (this.state.processedEvents.includes(eventId)) return 'duplicate';
    const next: PersistedSubscriptionState = {
      version: 1,
      processedEvents: [...this.state.processedEvents, eventId],
      records: {...this.state.records, [record.subscriptionId]: cloneRecord(record)},
    };
    this.writeState(next);
    this.state = next;
    return 'applied';
  }

  get(subscriptionId: string): SubscriptionRecord | undefined {
    const record = this.state.records[subscriptionId];
    return record === undefined ? undefined : cloneRecord(record);
  }

  private writeState(state: PersistedSubscriptionState): void {
    mkdirSync(dirname(this.filePath), {recursive: true});
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporaryPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
