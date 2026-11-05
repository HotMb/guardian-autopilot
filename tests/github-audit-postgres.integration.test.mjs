import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {access, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import pg from 'pg';
import {PostgresGitHubAuditQueue} from '../dist/github-audit-queue.js';

const exec = promisify(execFile);
const bin = process.env.GUARDIAN_TEST_POSTGRES_BIN;
const exe = (name) => join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);

async function unusedLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('PostgreSQL migration and lease takeover fence stale attempts', {skip: !bin, timeout: 120_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'guardian-pg-integration-'));
  const rootRelative = relative(tmpdir(), root);
  if (isAbsolute(rootRelative) || !rootRelative.startsWith('guardian-pg-integration-') || rootRelative.includes('..')) throw new Error('Unsafe PostgreSQL test directory');
  const data = join(root, 'data');
  const password = randomBytes(24).toString('hex');
  const pwfile = join(root, 'password');
  const port = await unusedLocalPort();
  let startAttempted = false;
  let pool;
  try {
    await writeFile(pwfile, password, {mode: 0o600});
    await exec(exe('initdb'), ['-D', data, '-U', 'guardian_test', '--auth=scram-sha-256', '--pwfile', pwfile, '--no-locale'], {windowsHide: true, timeout: 60_000});
    startAttempted = true;
    await exec(exe('pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], {windowsHide: true, timeout: 60_000});
    pool = new pg.Pool({host: '127.0.0.1', port, user: 'guardian_test', password, database: 'postgres', max: 2});
    const queue = new PostgresGitHubAuditQueue({pool});
    await queue.initialize();
    // Recreate the pre-migration schema, then check that startup upgrades it.
    await pool.query('ALTER TABLE guardian_github_audit_jobs DROP COLUMN lease_token');
    await queue.initialize();
    const job = {deliveryId: `1:${'a'.repeat(40)}`, installationId: 1, repositoryId: 1, owner: 'owner', repository: 'repo', fullName: 'owner/repo', ref: 'refs/heads/main', commitSha: 'a'.repeat(40)};
    assert.equal(await queue.enqueue(job), 'queued');
    const old = await queue.claim();
    await queue.setCheckRunId(job.deliveryId, 100, old.leaseToken);
    await pool.query("UPDATE guardian_github_audit_jobs SET lease_until = NOW() - INTERVAL '1 second'");
    const current = await queue.claim();
    assert.notEqual(current.leaseToken, old.leaseToken);
    assert.equal(current.attempts, 2);
    await assert.rejects(queue.setCheckRunId(job.deliveryId, 101, old.leaseToken), /lease/i);
    await assert.rejects(queue.complete(job.deliveryId, old.leaseToken), /lease/i);
    await assert.rejects(queue.fail(job.deliveryId, 'stale', old.leaseToken), /lease/i);
    await queue.setCheckRunId(job.deliveryId, 102, current.leaseToken);
    await queue.complete(job.deliveryId, current.leaseToken);
    const result = await pool.query('SELECT status, check_run_id FROM guardian_github_audit_jobs');
    assert.equal(result.rows[0].status, 'completed');
    assert.equal(Number(result.rows[0].check_run_id), 102);
    const retryJob = {...job, deliveryId: `1:${'b'.repeat(40)}`, commitSha: 'b'.repeat(40)};
    assert.equal(await queue.enqueue(retryJob), 'queued');
    const failedAttempt = await queue.claim();
    await queue.fail(retryJob.deliveryId, 'network_failure', failedAttempt.leaseToken);
    await pool.query('UPDATE guardian_github_audit_jobs SET available_at = NOW() WHERE delivery_id = $1', [retryJob.deliveryId]);
    const retry = await queue.claim();
    assert.notEqual(retry.leaseToken, failedAttempt.leaseToken);
    await queue.renewLease(retryJob.deliveryId, retry.leaseToken);
    await assert.rejects(queue.complete(retryJob.deliveryId, failedAttempt.leaseToken), /lease/i);
    await queue.complete(retryJob.deliveryId, retry.leaseToken);
  } finally {
    await pool?.end();
    if (startAttempted) {
      try { await exec(exe('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], {windowsHide: true, timeout: 60_000}); }
      catch {
        let pidExists = true;
        try { await access(join(data, 'postmaster.pid')); } catch { pidExists = false; }
        if (pidExists) throw new Error(`Temporary PostgreSQL may still be running; preserved ${root}`);
      }
    }
    await rm(root, {recursive: true, force: true});
  }
});
