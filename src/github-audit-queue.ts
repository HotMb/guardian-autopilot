import {Pool} from 'pg';
import type {GitHubAuditJob} from './github-audit.js';

type QueryResult = {rowCount?: number | null; rows: Array<Record<string, unknown>>};
type QueryableClient = {query(text: string, values?: readonly unknown[]): Promise<QueryResult>; release(): void};
type QueryablePool = {connect(): Promise<QueryableClient>; end(): Promise<void>};

export type ClaimedGitHubAuditJob = GitHubAuditJob & {attempts: number; checkRunId?: number};

export type GitHubAuditQueueOptions = {
  connectionString?: string;
  pool?: QueryablePool;
  maxConnections?: number;
  maxAttempts?: number;
};

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS guardian_github_audit_jobs (
    delivery_id TEXT PRIMARY KEY,
    installation_id BIGINT NOT NULL CHECK (installation_id > 0),
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    owner TEXT NOT NULL,
    repository TEXT NOT NULL,
    full_name TEXT NOT NULL,
    ref TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    check_run_id BIGINT,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error_code TEXT,
    UNIQUE (repository_id, commit_sha)
  )`,
  'CREATE INDEX IF NOT EXISTS guardian_github_audit_jobs_ready ON guardian_github_audit_jobs (available_at, created_at) WHERE status IN (\'queued\', \'processing\')',
  'CREATE INDEX IF NOT EXISTS guardian_github_audit_jobs_retention ON guardian_github_audit_jobs (completed_at) WHERE status IN (\'completed\', \'failed\')',
];

function positiveInteger(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`GitHub audit ${name} from PostgreSQL is invalid`);
  return parsed;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`GitHub audit ${name} from PostgreSQL is invalid`);
  return value;
}

function jobFromRow(row: Record<string, unknown>): ClaimedGitHubAuditJob {
  const checkRunId = row.check_run_id === null || row.check_run_id === undefined ? undefined : positiveInteger(row.check_run_id, 'check run id');
  return {
    deliveryId: text(row.delivery_id, 'delivery id'),
    installationId: positiveInteger(row.installation_id, 'installation id'),
    repositoryId: positiveInteger(row.repository_id, 'repository id'),
    owner: text(row.owner, 'owner'),
    repository: text(row.repository, 'repository name'),
    fullName: text(row.full_name, 'full name'),
    ref: text(row.ref, 'branch ref'),
    commitSha: text(row.commit_sha, 'commit SHA'),
    attempts: positiveInteger(row.attempts, 'attempt count'),
    ...(checkRunId === undefined ? {} : {checkRunId}),
  };
}

/** Durable, idempotent queue. It stores event metadata only, never source files or report contents. */
export class PostgresGitHubAuditQueue {
  private readonly pool: QueryablePool;
  private readonly ownsPool: boolean;
  private readonly maxAttempts: number;

  constructor(options: GitHubAuditQueueOptions) {
    if (options.pool !== undefined) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      const connectionString = options.connectionString?.trim();
      if (!connectionString) throw new Error('GitHub audit PostgreSQL connection is required');
      this.pool = new Pool({connectionString, max: options.maxConnections ?? 1});
      this.ownsPool = true;
    }
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) throw new Error('GitHub audit maxAttempts must be between 1 and 10');
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of schemaStatements) await client.query(statement);
      await client.query("DELETE FROM guardian_github_audit_jobs WHERE status IN ('completed', 'failed') AND completed_at < NOW() - INTERVAL '30 days'");
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* keep the schema error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueue(job: GitHubAuditJob): Promise<'queued' | 'duplicate'> {
    if (job.deliveryId.trim() === '' || job.deliveryId.length > 255) throw new Error('GitHub audit delivery id is invalid');
    if (!Number.isSafeInteger(job.installationId) || job.installationId <= 0 || !Number.isSafeInteger(job.repositoryId) || job.repositoryId <= 0) throw new Error('GitHub audit repository identifiers are invalid');
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO guardian_github_audit_jobs
         (delivery_id, installation_id, repository_id, owner, repository, full_name, ref, commit_sha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING RETURNING delivery_id`,
        [job.deliveryId, job.installationId, job.repositoryId, job.owner, job.repository, job.fullName, job.ref, job.commitSha],
      );
      return (result.rowCount ?? result.rows.length) === 0 ? 'duplicate' : 'queued';
    } finally {
      client.release();
    }
  }

  async claim(): Promise<ClaimedGitHubAuditJob | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("DELETE FROM guardian_github_audit_jobs WHERE status IN ('completed', 'failed') AND completed_at < NOW() - INTERVAL '30 days'");
      await client.query(
        `UPDATE guardian_github_audit_jobs
         SET status = 'failed', error_code = 'retry_limit_reached', completed_at = NOW(), lease_until = NULL, updated_at = NOW()
         WHERE attempts >= $1 AND (status = 'queued' OR (status = 'processing' AND lease_until <= NOW()))`,
        [this.maxAttempts],
      );
      const result = await client.query(
        `WITH ready AS (
           SELECT delivery_id
           FROM guardian_github_audit_jobs
           WHERE attempts < $1 AND available_at <= NOW()
             AND (status = 'queued' OR (status = 'processing' AND lease_until <= NOW()))
           ORDER BY created_at, delivery_id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE guardian_github_audit_jobs AS job
         SET status = 'processing', attempts = job.attempts + 1,
             lease_until = NOW() + INTERVAL '10 minutes', updated_at = NOW()
         FROM ready
         WHERE job.delivery_id = ready.delivery_id
         RETURNING job.delivery_id, job.installation_id, job.repository_id, job.owner, job.repository,
                   job.full_name, job.ref, job.commit_sha, job.attempts, job.check_run_id`,
        [this.maxAttempts],
      );
      return result.rows[0] === undefined ? undefined : jobFromRow(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async setCheckRunId(deliveryId: string, checkRunId: number): Promise<void> {
    if (!Number.isSafeInteger(checkRunId) || checkRunId <= 0) throw new Error('GitHub check run id is invalid');
    await this.update('UPDATE guardian_github_audit_jobs SET check_run_id = $2, updated_at = NOW() WHERE delivery_id = $1 AND status = \'processing\'', [deliveryId, checkRunId]);
  }

  async complete(deliveryId: string): Promise<void> {
    await this.update("UPDATE guardian_github_audit_jobs SET status = 'completed', completed_at = NOW(), lease_until = NULL, error_code = NULL, updated_at = NOW() WHERE delivery_id = $1 AND status = 'processing'", [deliveryId]);
  }

  async fail(deliveryId: string, errorCode: string): Promise<void> {
    const safeCode = /^[a-z0-9_-]{1,80}$/.test(errorCode) ? errorCode : 'audit_processing_failed';
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE guardian_github_audit_jobs
         SET status = CASE WHEN attempts < $2 THEN 'queued' ELSE 'failed' END,
             available_at = NOW() + make_interval(secs => LEAST(120, GREATEST(5, attempts * 10))),
             completed_at = CASE WHEN attempts < $2 THEN NULL ELSE NOW() END,
             lease_until = NULL, error_code = $3, updated_at = NOW()
         WHERE delivery_id = $1 AND status = 'processing'`,
        [deliveryId, this.maxAttempts, safeCode],
      );
    } finally {
      client.release();
    }
  }

  private async update(query: string, values: readonly unknown[]): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query(query, values); }
    finally { client.release(); }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
