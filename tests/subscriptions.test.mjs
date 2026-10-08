import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {FileSubscriptionStore} from '../dist/subscriptions.js';
import {PostgresSubscriptionStore} from '../dist/postgres-subscriptions.js';

const record = {
  subscriptionId: 'sub_file_001',
  customerId: 'cus_file_001',
  eventId: 'evt_file_001',
  updatedAt: 1_800_000_000,
  snapshot: {plan: 'pro', status: 'active', currentPeriodEnd: 1_800_086_400},
};

class FakePostgresPool {
  constructor() {
    this.events = new Set();
    this.records = new Map();
  }

  async connect() {
    return new FakePostgresClient(this);
  }

  async end() {}
}

class FakePostgresClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, values = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK' || normalized.startsWith('CREATE TABLE')) return {rowCount: 0, rows: []};
    if (normalized.startsWith('INSERT INTO guardian_processed_events')) {
      const eventId = values[0];
      if (this.pool.events.has(eventId)) return {rowCount: 0, rows: []};
      this.pool.events.add(eventId);
      return {rowCount: 1, rows: [{event_id: eventId}]};
    }
    if (normalized.startsWith('INSERT INTO guardian_subscriptions')) {
      const existing = this.pool.records.get(values[0]);
      if (existing !== undefined && Number(values[3]) < Number(existing.updated_at)) return {rowCount: 0, rows: []};
      this.pool.records.set(values[0], {
        subscription_id: values[0],
        customer_id: values[1],
        event_id: values[2],
        updated_at: values[3],
        plan: values[4],
        status: values[5],
        current_period_end: values[6],
      });
      return {rowCount: 1, rows: []};
    }
    if (normalized.startsWith('SELECT subscription_id')) {
      const row = this.pool.records.get(values[0]);
      return row === undefined ? {rowCount: 0, rows: []} : {rowCount: 1, rows: [row]};
    }
    throw new Error(`Unexpected fake PostgreSQL query: ${normalized}`);
  }

  release() {}
}

test('file subscription store reloads state and deduplicates after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guardian-subscriptions-'));
  const filePath = join(directory, 'subscriptions.json');
  try {
    const first = new FileSubscriptionStore(filePath);
    assert.equal(first.apply(record.eventId, record), 'applied');
    assert.deepEqual(first.get(record.subscriptionId), record);

    const reloaded = new FileSubscriptionStore(filePath);
    assert.deepEqual(reloaded.get(record.subscriptionId), record);
    assert.equal(reloaded.apply(record.eventId, record), 'duplicate');
    const updated = {...record, eventId: 'evt_file_002', updatedAt: record.updatedAt + 60, snapshot: {...record.snapshot, status: 'past_due'}};
    assert.equal(reloaded.apply(updated.eventId, updated), 'applied');
    assert.deepEqual(new FileSubscriptionStore(filePath).get(record.subscriptionId), updated);
    assert.match(await readFile(filePath, 'utf8'), /"version": 1/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('file subscription store requires an absolute path and rejects corrupt state', async () => {
  assert.throws(() => new FileSubscriptionStore('subscriptions.json'), /absolute/);
  const directory = await mkdtemp(join(tmpdir(), 'guardian-subscriptions-corrupt-'));
  const filePath = join(directory, 'subscriptions.json');
  try {
    const {writeFile} = await import('node:fs/promises');
    await writeFile(filePath, '{not-json');
    assert.throws(() => new FileSubscriptionStore(filePath), /invalid JSON/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('PostgreSQL subscription store uses transactional event de-duplication and keeps newer state', async () => {
  const pool = new FakePostgresPool();
  const store = new PostgresSubscriptionStore({pool});
  await store.initialize();
  assert.equal(await store.apply(record.eventId, record), 'applied');
  assert.equal(await store.apply(record.eventId, record), 'duplicate');
  assert.deepEqual(await store.get(record.subscriptionId), record);

  const newer = {...record, eventId: 'evt_file_003', updatedAt: record.updatedAt + 60, snapshot: {...record.snapshot, status: 'past_due'}};
  assert.equal(await store.apply(newer.eventId, newer), 'applied');
  const older = {...record, eventId: 'evt_file_004', updatedAt: record.updatedAt - 60};
  assert.equal(await store.apply(older.eventId, older), 'applied');
  assert.deepEqual((await store.get(record.subscriptionId)).snapshot, newer.snapshot);
});
