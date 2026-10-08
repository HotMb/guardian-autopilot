import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {FileSubscriptionStore} from '../dist/subscriptions.js';

const record = {
  subscriptionId: 'sub_file_001',
  customerId: 'cus_file_001',
  eventId: 'evt_file_001',
  updatedAt: 1_800_000_000,
  snapshot: {plan: 'pro', status: 'active', currentPeriodEnd: 1_800_086_400},
};

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
