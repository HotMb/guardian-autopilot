import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {request} from 'node:http';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {c as createTar} from 'tar';
import test from 'node:test';
import {processGitHubAuditJob} from '../dist/github-audit.js';
import {startGitHubAuditWorker} from '../dist/github-audit-worker.js';
import {createBillingWebhookServer} from '../dist/server.js';
import {MemorySubscriptionStore} from '../dist/subscriptions.js';

const webhookSecret = 'github-e2e-webhook-secret';
const sha1 = 'b'.repeat(40);
const sha2 = 'a'.repeat(40);

function signature(body) {
  return `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
}

function sendPush(server, body, deliveryId) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/webhooks/github',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({statusCode: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function createQueue() {
  const jobs = new Map();
  const completed = [];
  const failed = [];
  let resolveAll;
  let rejectAny;
  const allProcessed = new Promise((resolve, reject) => { resolveAll = resolve; rejectAny = reject; });
  return {
    jobs,
    completed,
    failed,
    allProcessed,
    async enqueue(job) {
      if (jobs.has(job.deliveryId)) return 'duplicate';
      jobs.set(job.deliveryId, {job, status: 'queued', attempts: 0, checkRunId: undefined});
      return 'queued';
    },
    async claim() {
      const entry = [...jobs.values()].find((candidate) => candidate.status === 'queued');
      if (entry === undefined) return undefined;
      entry.status = 'processing';
      entry.attempts += 1;
      return {...entry.job, attempts: entry.attempts, ...(entry.checkRunId === undefined ? {} : {checkRunId: entry.checkRunId})};
    },
    async setCheckRunId(deliveryId, checkRunId) {
      const entry = jobs.get(deliveryId);
      assert.ok(entry);
      entry.checkRunId = checkRunId;
    },
    async complete(deliveryId) {
      const entry = jobs.get(deliveryId);
      assert.ok(entry);
      entry.status = 'completed';
      completed.push(deliveryId);
      if (completed.length === 2) resolveAll();
    },
    async fail(deliveryId, errorCode) {
      failed.push({deliveryId, errorCode});
      rejectAny(new Error(`audit failed: ${errorCode}`));
    },
  };
}

async function createArchive(root, commitLabel) {
  const source = join(root, `source-${commitLabel}`);
  const archivePath = join(root, `${commitLabel}.tar.gz`);
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({name: `fixture-${commitLabel}`, scripts: {preinstall: 'throw new Error("repository scripts must not run")'}}));
  await writeFile(join(source, 'app.js'), `export const commit = '${commitLabel}';\n`);
  await createTar({gzip: true, cwd: source, file: archivePath}, ['package.json', 'app.js']);
  return readFile(archivePath);
}

test('end-to-end GitHub push authenticates, queues every commit, scans archives, publishes checks, and deduplicates redelivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-github-e2e-'));
  const queue = createQueue();
  const archives = new Map([
    [sha1, await createArchive(root, 'first')],
    [sha2, await createArchive(root, 'head')],
  ]);
  const createdChecks = [];
  const completedChecks = [];
  const fakeGitHub = {
    async getRepository(owner, name) {
      return {id: 1701, fullName: `${owner}/${name}`, defaultBranch: 'main', private: true};
    },
    async downloadRepositoryArchive(_owner, _name, sha) {
      const archive = archives.get(sha);
      assert.ok(archive, `unexpected commit archive ${sha}`);
      return new Response(Readable.toWeb(Readable.from([archive])));
    },
    async createCheckRun(owner, name, sha, externalId) {
      const id = createdChecks.length + 1;
      createdChecks.push({owner, name, sha, externalId, id});
      return id;
    },
    async completeCheckRun(owner, name, id, output) {
      completedChecks.push({owner, name, id, output});
    },
  };
  const worker = startGitHubAuditWorker(queue, (job, saveCheckRunId) => processGitHubAuditJob(
    job,
    () => fakeGitHub,
    saveCheckRunId,
  ), {pollIntervalMs: 100, log: (message) => assert.fail(`unexpected worker log: ${message}`)});
  const server = createBillingWebhookServer({
    githubWebhookSecret: webhookSecret,
    githubAuditEnqueue: (job) => queue.enqueue(job),
    store: new MemorySubscriptionStore(),
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const payload = {
      ref: 'refs/heads/main',
      before: 'c'.repeat(40),
      after: sha2,
      deleted: false,
      commits: [{id: sha1, distinct: true, message: 'first'}, {id: sha2, distinct: true, message: 'head'}],
      installation: {id: 901},
      repository: {id: 1701, name: 'sample-app', full_name: 'HotMb/sample-app', owner: {login: 'HotMb'}},
    };
    const body = JSON.stringify(payload);
    const accepted = await sendPush(server, body, 'delivery-e2e-001');
    assert.deepEqual(accepted, {statusCode: 202, json: {status: 'queued', deliveryId: 'delivery-e2e-001', commitCount: 2}});

    await Promise.race([
      queue.allProcessed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for commit reports')), 8_000)),
    ]);

    assert.equal(queue.jobs.size, 2);
    assert.equal(queue.completed.length, 2);
    assert.equal(queue.failed.length, 0);
    assert.deepEqual(createdChecks.map((check) => check.sha).sort(), [sha1, sha2].sort());
    assert.equal(completedChecks.length, 2);
    for (const check of completedChecks) {
      assert.equal(check.owner, 'HotMb');
      assert.equal(check.name, 'sample-app');
      assert.equal(check.output.conclusion, 'neutral');
      assert.match(check.output.summary, /read-only/i);
      assert.match(check.output.summary, /did not execute repository scripts/i);
      assert.doesNotMatch(check.output.summary, /repository scripts must not run/);
    }

    const replay = await sendPush(server, body, 'delivery-e2e-replay');
    assert.deepEqual(replay, {statusCode: 200, json: {status: 'duplicate', deliveryId: 'delivery-e2e-replay', commitCount: 2}});
    assert.equal(queue.jobs.size, 2);
    assert.equal(createdChecks.length, 2);
  } finally {
    await worker.close();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, {recursive: true, force: true});
  }
});
