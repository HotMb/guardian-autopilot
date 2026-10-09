import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReceiptStore} from '../dist/receipts.js';

test('restores a changed or deleted file from a finalized receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-receipt-'));
  const file = join(root, 'file.ts');
  await writeFile(file, 'before\n');
  const store = new ReceiptStore(join(root, '.receipts'));
  const receipt = await store.begin(['file.ts']);
  await writeFile(file, 'after\n');
  await store.finalize(receipt.id);
  await store.rollback(receipt.id);

  assert.equal(await readFile(file, 'utf8'), 'before\n');
});

test('uses compare-and-swap and refuses to overwrite a conflicting edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleancode-receipt-conflict-'));
  const file = join(root, 'file.ts');
  await writeFile(file, 'before\n');
  const store = new ReceiptStore(join(root, '.receipts'));
  const receipt = await store.begin(['file.ts']);
  await writeFile(file, 'expected-after\n');
  await store.finalize(receipt.id);
  await writeFile(file, 'someone-else\n');

  await assert.rejects(() => store.rollback(receipt.id), /conflict/i);
  assert.equal(await readFile(file, 'utf8'), 'someone-else\n');
});

