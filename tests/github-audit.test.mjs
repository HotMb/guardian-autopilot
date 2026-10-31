import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {c as createTar} from 'tar';
import test from 'node:test';
import {parseGitHubAuditEvent} from '../dist/github-audit.js';
import {processGitHubAuditJob} from '../dist/github-audit.js';
import {PostgresGitHubAuditQueue} from '../dist/github-audit-queue.js';
import {startGitHubAuditWorker} from '../dist/github-audit-worker.js';

const validPush = () => ({
  installation: {id: 901},
  repository: {id: 1701, full_name: 'HotMb/sample-app', name: 'sample-app', owner: {login: 'HotMb'}},
  ref: 'refs/heads/main',
  after: 'a'.repeat(40),
  deleted: false,
});

test('accepts every commit in a signed push as separate metadata-only audit work', () => {
  const firstSha = 'b'.repeat(40);
  const headSha = 'a'.repeat(40);
  const parsed = parseGitHubAuditEvent('push', 'delivery-001', {...validPush(), commits: [{id: firstSha}, {id: headSha}]});
  assert.deepEqual(parsed, {
    kind: 'push',
    jobs: [firstSha, headSha].map((commitSha) => ({
      deliveryId: `1701:${commitSha}`,
      installationId: 901,
      repositoryId: 1701,
      owner: 'HotMb',
      repository: 'sample-app',
      fullName: 'HotMb/sample-app',
      ref: 'refs/heads/main',
      commitSha,
    })),
  });
});

test('uses the pushed head when a push has no commit list and rejects oversized or malformed lists', () => {
  const headSha = 'a'.repeat(40);
  assert.deepEqual(parseGitHubAuditEvent('push', 'delivery-head', validPush()), {
    kind: 'push',
    jobs: [{
      deliveryId: `1701:${headSha}`,
      installationId: 901,
      repositoryId: 1701,
      owner: 'HotMb',
      repository: 'sample-app',
      fullName: 'HotMb/sample-app',
      ref: 'refs/heads/main',
      commitSha: headSha,
    }],
  });
  const commits = Array.from({length: 21}, (_, index) => ({id: index.toString(16).padStart(40, '0')}));
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-large', {...validPush(), commits}), /configured commit limit/i);
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-bad-commit', {...validPush(), commits: [{id: 'not-a-sha'}]}), /commit sha/i);
});

test('ignores non-push events, tag pushes, branch deletion, and empty heads', () => {
  assert.deepEqual(parseGitHubAuditEvent('ping', 'delivery-002', {}), {kind: 'ignored'});
  assert.deepEqual(parseGitHubAuditEvent('push', 'delivery-003', {...validPush(), ref: 'refs/tags/v1.0.0'}), {kind: 'ignored'});
  assert.deepEqual(parseGitHubAuditEvent('push', 'delivery-004', {...validPush(), deleted: true}), {kind: 'ignored'});
  assert.deepEqual(parseGitHubAuditEvent('push', 'delivery-005', {...validPush(), after: '0'.repeat(40)}), {kind: 'ignored'});
});

test('rejects malformed delivery, repository, installation, ref, and commit identifiers', () => {
  assert.throws(() => parseGitHubAuditEvent('push', '', validPush()), /delivery id/i);
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-006', {...validPush(), repository: {...validPush().repository, full_name: 'Other/repo'}}), /repository identity/i);
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-007', {...validPush(), installation: {id: 0}}), /installation/i);
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-008', {...validPush(), ref: 'main'}), /branch ref/i);
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-009', {...validPush(), after: '../unsafe'}), /commit sha/i);
});

test('refuses repository paths and branch values that could escape the audit scope', () => {
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-010', {...validPush(), repository: {...validPush().repository, name: '../sample-app', full_name: 'HotMb/../sample-app'}}), /repository identity/i);
  assert.throws(() => parseGitHubAuditEvent('push', 'delivery-011', {...validPush(), ref: 'refs/heads/../../main'}), /branch ref/i);
});

test('PostgreSQL audit queue stores metadata idempotently, leases work, and records check completion', async () => {
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({sql, values});
          if (sql.includes('INSERT INTO guardian_github_audit_jobs')) return {rowCount: 1, rows: [{delivery_id: job.deliveryId}]};
          if (sql.includes('RETURNING job.delivery_id')) return {rowCount: 1, rows: [{
            delivery_id: job.deliveryId, installation_id: '901', repository_id: '1701', owner: 'HotMb', repository: 'sample-app',
            full_name: 'HotMb/sample-app', ref: 'refs/heads/main', commit_sha: 'a'.repeat(40), attempts: 1, check_run_id: null,
          }]};
          return {rowCount: 1, rows: []};
        },
        release() {},
      };
    },
    async end() {},
  };
  const queue = new PostgresGitHubAuditQueue({pool});
  await queue.initialize();
  const parsed = parseGitHubAuditEvent('push', 'delivery-012', validPush());
  assert.equal(parsed.kind, 'push');
  const job = parsed.jobs[0];
  assert.equal(await queue.enqueue(job), 'queued');
  const beforeClaim = calls.length;
  assert.deepEqual(await queue.claim(), {
    ...job,
    attempts: 1,
  });
  assert.ok(calls.slice(beforeClaim).some(({sql}) => sql.includes("completed_at < NOW() - INTERVAL '30 days'")));
  await queue.setCheckRunId(job.deliveryId, 8001);
  await queue.complete(job.deliveryId);
  assert.ok(calls.some(({sql}) => sql.includes('FOR UPDATE SKIP LOCKED')));
  assert.ok(calls.some(({sql, values}) => sql.includes('check_run_id = $2') && values[1] === 8001));
  assert.ok(calls.some(({sql}) => sql.includes("status = 'completed'")));
  assert.equal(calls.some(({values}) => values.includes('source-code')), false);
});

test('redelivering a failed commit resets it for processing while active and completed jobs stay idempotent', async () => {
  const calls = [];
  let status = 'failed';
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({sql, values});
          if (!sql.includes('INSERT INTO guardian_github_audit_jobs')) return {rowCount: 1, rows: []};
          assert.match(sql, /ON CONFLICT \(repository_id, commit_sha\) DO UPDATE/);
          assert.match(sql, /WHERE guardian_github_audit_jobs\.status = 'failed'/);
          if (status === 'failed') {
            status = 'queued';
            return {rowCount: 1, rows: [{delivery_id: values[0]}]};
          }
          return {rowCount: 0, rows: []};
        },
        release() {},
      };
    },
    async end() {},
  };
  const queue = new PostgresGitHubAuditQueue({pool});
  const job = parseGitHubAuditEvent('push', 'delivery-012-replay', validPush()).jobs[0];

  assert.equal(await queue.enqueue(job), 'queued');
  assert.match(calls[0].sql, /attempts = 0/);
  assert.match(calls[0].sql, /completed_at = NULL/);
  assert.match(calls[0].sql, /error_code = NULL/);
  assert.equal(await queue.enqueue(job), 'duplicate');
  status = 'completed';
  assert.equal(await queue.enqueue(job), 'duplicate');
});

test('PostgreSQL audit queue retries with bounded delays and eventually marks jobs failed', async () => {
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) { calls.push({sql, values}); return {rowCount: 1, rows: []}; },
        release() {},
      };
    },
    async end() {},
  };
  const queue = new PostgresGitHubAuditQueue({pool, maxAttempts: 3});
  await queue.fail('delivery-013', 'network_failure');
  assert.ok(calls[0].sql.includes("CASE WHEN attempts < $2 THEN 'queued' ELSE 'failed' END"));
  assert.equal(calls[0].values[1], 3);
  await queue.fail('delivery-013', 'unsafe error with secrets');
  assert.equal(calls[1].values[2], 'audit_processing_failed');
});

test('audit worker processes one leased job at a time and persists its Check Run id', async () => {
  const parsed = parseGitHubAuditEvent('push', 'delivery-014', validPush());
  const job = {...parsed.jobs[0], attempts: 1};
  const events = [];
  let claimed = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const queue = {
    async claim() { if (claimed) return undefined; claimed = true; return job; },
    async setCheckRunId(deliveryId, checkRunId) { events.push(['check', deliveryId, checkRunId]); },
    async complete(deliveryId) { events.push(['complete', deliveryId]); resolveDone(); },
    async fail() { assert.fail('successful audit must not be retried'); },
  };
  const worker = startGitHubAuditWorker(queue, async (claimedJob, saveCheckRunId) => {
    events.push(['process', claimedJob.deliveryId]);
    await saveCheckRunId(8002);
  }, {pollIntervalMs: 100, log: (message) => events.push(['log', message])});
  await done;
  await worker.close();
  assert.deepEqual(events.slice(0, 3), [
    ['process', job.deliveryId],
    ['check', job.deliveryId, 8002],
    ['complete', job.deliveryId],
  ]);
});

test('audit worker retries failures without logging exception contents', async () => {
  const parsed = parseGitHubAuditEvent('push', 'delivery-015', validPush());
  const job = {...parsed.jobs[0], attempts: 1};
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const queue = {
    async claim() { return job; },
    async setCheckRunId() {},
    async complete() { assert.fail('failed audit must not be completed'); },
    async fail(deliveryId, code) { events.push(['fail', deliveryId, code]); resolveDone(); },
  };
  const worker = startGitHubAuditWorker(queue, async () => { throw new Error('secret source text or token'); }, {pollIntervalMs: 100, log: (message) => events.push(['log', message])});
  await done;
  await worker.close();
  assert.ok(events.some((event) => event[0] === 'fail' && event[2] === 'audit_processing_failed'));
  assert.equal(JSON.stringify(events).includes('secret source text or token'), false);
});

test('audit worker throttles repeated queue outage logs and never includes database error details', async () => {
  let claims = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const logs = [];
  const queue = {async claim() { claims += 1; if (claims === 3) resolveDone(); throw new Error('database password leaked'); }};
  const worker = startGitHubAuditWorker(queue, async () => {}, {pollIntervalMs: 100, log: (message) => logs.push(message)});
  await done;
  await worker.close();
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs.join('\n'), /database password/);
});

test('hosted audit analyzes an ephemeral commit archive without running repository scripts and completes a Check Run', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'guardian-audit-test-'));
  const source = join(temporary, 'source');
  const archivePath = join(temporary, 'repository.tar.gz');
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({scripts: {postinstall: 'throw new Error("must not execute")'}}));
  await writeFile(join(source, 'app.js'), 'export const value = 1;\n');
  await createTar({gzip: true, cwd: source, file: archivePath}, ['package.json', 'app.js']);
  const archive = await readFile(archivePath);
  const calls = [];
  let persistedCheckRun;
  try {
    await processGitHubAuditJob({...parseGitHubAuditEvent('push', 'delivery-016', validPush()).jobs[0], attempts: 1}, () => ({
      async getRepository(owner, name) { return {id: 1701, fullName: `${owner}/${name}`, defaultBranch: 'main', private: true}; },
      async downloadRepositoryArchive() { return new Response(Readable.toWeb(Readable.from([archive]))); },
      async createCheckRun(owner, name, sha, delivery) { calls.push(['create', owner, name, sha, delivery]); return 902; },
      async completeCheckRun(owner, name, id, output) { calls.push(['complete', owner, name, id, output]); },
    }), async (id) => { persistedCheckRun = id; });
    assert.equal(persistedCheckRun, 902);
    assert.deepEqual(calls[0], ['create', 'HotMb', 'sample-app', 'a'.repeat(40), `1701:${'a'.repeat(40)}`]);
    assert.equal(calls[1][0], 'complete');
    assert.equal(calls[1][3], 902);
    assert.equal(calls[1][4].conclusion, 'neutral', calls[1][4].summary);
    assert.match(calls[1][4].summary, /Complete CleanCode report/);
    assert.match(calls[1][4].summary, /did not execute repository scripts/);
    assert.doesNotMatch(calls[1][4].summary, /must not execute/);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});
