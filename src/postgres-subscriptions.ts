import {Pool} from 'pg';
import {normalizeEntitlementSnapshot, type EntitlementSnapshot} from './billing.js';
import type {SubscriptionApplyResult, SubscriptionRecord, SubscriptionStore} from './subscriptions.js';

type QueryResult = {rowCount?: number | null; rows: Array<Record<string, unknown>>};
type QueryableClient = {query(text: string, values?: readonly unknown[]): Promise<QueryResult>; release(): void};
type QueryablePool = {connect(): Promise<QueryableClient>; end(): Promise<void>};

export type PostgresSubscriptionStoreOptions = {
  connectionString?: string;
  pool?: QueryablePool;
  maxConnections?: number;
};

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS guardian_processed_events (
    event_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS guardian_subscriptions (
    subscription_id TEXT PRIMARY KEY,
    customer_id TEXT,
    event_id TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'team')),
    status TEXT NOT NULL CHECK (status IN ('active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused')),
    current_period_end BIGINT
  )`,
];

function databaseInteger(value: unknown, field: string, allowUndefined = false): number | undefined {
  if (value === null || value === undefined) {
    if (allowUndefined) return undefined;
    throw new Error(`${field} is missing from PostgreSQL`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} from PostgreSQL is invalid`);
  return parsed;
}

function recordFromRow(row: Record<string, unknown>): SubscriptionRecord {
  const subscriptionId = row.subscription_id;
  const eventId = row.event_id;
  const customerId = row.customer_id;
  if (typeof subscriptionId !== 'string' || subscriptionId.trim() === '') throw new Error('PostgreSQL subscription id is invalid');
  if (typeof eventId !== 'string' || eventId.trim() === '') throw new Error('PostgreSQL event id is invalid');
  if (customerId !== null && customerId !== undefined && (typeof customerId !== 'string' || customerId.trim() === '')) throw new Error('PostgreSQL customer id is invalid');
  const snapshot: EntitlementSnapshot = normalizeEntitlementSnapshot({
    plan: row.plan,
    status: row.status,
    ...(databaseInteger(row.current_period_end, 'current_period_end', true) === undefined ? {} : {currentPeriodEnd: databaseInteger(row.current_period_end, 'current_period_end')}),
  });
  return {
    subscriptionId,
    ...(customerId === null || customerId === undefined ? {} : {customerId}),
    eventId,
    updatedAt: databaseInteger(row.updated_at, 'updated_at') as number,
    snapshot,
  };
}

/**
 * Transactional PostgreSQL implementation for horizontally scaled webhook
 * workers. A unique event row makes retries safe across multiple instances.
 */
export class PostgresSubscriptionStore implements SubscriptionStore {
  private readonly pool: QueryablePool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresSubscriptionStoreOptions) {
    if (options.pool !== undefined) {
      this.pool = options.pool;
      this.ownsPool = false;
      return;
    }
    const connectionString = options.connectionString?.trim();
    if (!connectionString) throw new Error('PostgreSQL connection string is required');
    this.pool = new Pool({connectionString, max: options.maxConnections ?? 10});
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of schemaStatements) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the schema error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async apply(eventId: string, record: SubscriptionRecord): Promise<SubscriptionApplyResult> {
    if (eventId.trim() === '' || record.subscriptionId.trim() === '') throw new Error('Subscription identifiers are required');
    if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt <= 0) throw new Error('Subscription updatedAt is invalid');
    const snapshot = normalizeEntitlementSnapshot(record.snapshot);
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const inserted = await client.query(
        'INSERT INTO guardian_processed_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
        [eventId],
      );
      if ((inserted.rowCount ?? inserted.rows.length) === 0) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return 'duplicate';
      }
      await client.query(
        `INSERT INTO guardian_subscriptions (subscription_id, customer_id, event_id, updated_at, plan, status, current_period_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (subscription_id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           event_id = EXCLUDED.event_id,
           updated_at = EXCLUDED.updated_at,
           plan = EXCLUDED.plan,
           status = EXCLUDED.status,
           current_period_end = EXCLUDED.current_period_end
         WHERE EXCLUDED.updated_at >= guardian_subscriptions.updated_at`,
        [record.subscriptionId, record.customerId ?? null, record.eventId, record.updatedAt, snapshot.plan, snapshot.status, snapshot.currentPeriodEnd ?? null],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return 'applied';
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the database error */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async get(subscriptionId: string): Promise<SubscriptionRecord | undefined> {
    if (subscriptionId.trim() === '') throw new Error('Subscription id is required');
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT subscription_id, customer_id, event_id, updated_at, plan, status, current_period_end FROM guardian_subscriptions WHERE subscription_id = $1',
        [subscriptionId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : recordFromRow(row);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
