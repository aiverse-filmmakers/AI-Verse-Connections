import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readyService, tmpHome } from '../test-support/helpers.js';

test('receipt indexes recover an appended ledger tail and keep idempotency and recent budget lookups scoped', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  const key = { connectionId: 'api', capability: 'send', idempotencyKey: 'same-key' };
  const oldBudget = {
    receiptId: 'cxr-index-old-budget', timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    connectionId: 'api', capability: 'historic', outcome: 'success', attemptedExternal: true
  };
  await service.store.appendReceipt(oldBudget);
  const first = {
    receiptId: 'cxr-index-first', timestamp: new Date().toISOString(),
    ...key, executionId: 'cxe-index-first', outcome: 'pending', executionActive: true
  };
  await service.store.appendReceipt(first);
  assert.deepEqual(await service.store.idempotencyHistory(key), [first]);

  const crashedWriterRecord = {
    receiptId: 'cxr-index-crash-tail', timestamp: new Date().toISOString(),
    ...key, executionId: 'cxe-index-crash-tail', outcome: 'success', attemptedExternal: true
  };
  await fs.appendFile(path.join(home, 'receipts.ndjson'), JSON.stringify(crashedWriterRecord) + '\n');
  const history = await service.store.idempotencyHistory(key);
  assert.deepEqual(history.map((receipt) => receipt.receiptId), [first.receiptId, crashedWriterRecord.receiptId]);
  assert.equal((await service.store.findIdempotentReceipt({ ...key, outcomes: ['success'] })).receiptId, crashedWriterRecord.receiptId);
  assert.deepEqual((await service.store.budgetReceipts('api')).map((receipt) => receipt.receiptId), [crashedWriterRecord.receiptId]);
  assert.equal((await service.store.readReceipts()).length, 3);

  const bucketDir = path.join(home, '.receipt-index', 'idempotency');
  const bucket = (await fs.readdir(bucketDir)).find((name) => name.endsWith('.ndjson'));
  await fs.rm(path.join(bucketDir, bucket));
  assert.deepEqual((await service.store.idempotencyHistory(key)).map((receipt) => receipt.receiptId), [first.receiptId, crashedWriterRecord.receiptId]);
  assert.equal((await service.store.readReceipts()).length, 3);

  await fs.rm(path.join(home, '.receipt-index'), { recursive: true, force: true });
  assert.equal((await service.store.findIdempotentReceipt({ ...key, outcomes: ['success'] })).receiptId, crashedWriterRecord.receiptId);
  assert.equal((await service.store.readReceipts()).length, 3);
});


test('unresolved execution lookup is capability-scoped and promotes the next pending effect', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  const base = { connectionId: 'api', capability: 'send', timestamp: new Date().toISOString(), outcome: 'pending', executionActive: true };
  await service.store.appendReceipt({ ...base, receiptId: 'cxr-unresolved-a', executionId: 'cxe-unresolved-a' });
  await service.store.appendReceipt({ ...base, receiptId: 'cxr-unresolved-b', executionId: 'cxe-unresolved-b' });
  const first = await service.store.unresolvedReceipts('api', 'send');
  assert.equal(first.length, 1);
  assert.equal(first[0].executionId, 'cxe-unresolved-a');

  await service.store.appendReceipt({
    receiptId: 'cxr-unresolved-a-reconciled', timestamp: new Date().toISOString(),
    connectionId: 'api', capability: 'send', executionId: 'cxe-unresolved-a',
    outcome: 'external-reconciled-not-applied', attemptedExternal: false
  });
  const promoted = await service.store.unresolvedReceipts('api', 'send');
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].executionId, 'cxe-unresolved-b');
  assert.deepEqual(await service.store.unresolvedReceipts('api', 'other-capability'), []);
});

test('indexed execution fails closed when the append-only receipt history is corrupted', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  await service.store.appendReceipt({
    receiptId: 'cxr-corrupt-index', timestamp: new Date().toISOString(),
    connectionId: 'api', capability: 'send', idempotencyKey: 'key',
    executionId: 'cxe-corrupt-index', outcome: 'pending', executionActive: true
  });
  await service.store.idempotencyHistory({ connectionId: 'api', capability: 'send', idempotencyKey: 'key' });
  const file = path.join(home, 'receipts.ndjson');
  const original = await fs.readFile(file, 'utf8');
  const corrupted = original.replace('"outcome":"pending"', '"outcome":{ending"');
  assert.notEqual(corrupted, original);
  await fs.writeFile(file, corrupted, { mode: 0o600 });

  await assert.rejects(
    service.store.idempotencyHistory({ connectionId: 'api', capability: 'send', idempotencyKey: 'key' }),
    (error) => error.code === 'RECEIPT_LOG_CORRUPT'
  );
  assert.equal(await fs.readFile(file, 'utf8'), corrupted);
});

test('uninstall preserves canonical receipt history and its derived indexes', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  await service.store.appendReceipt({
    receiptId: 'cxr-index-purge', timestamp: new Date().toISOString(),
    connectionId: 'api', capability: 'send', idempotencyKey: 'key', outcome: 'success'
  });
  await service.store.idempotencyHistory({ connectionId: 'api', capability: 'send', idempotencyKey: 'key' });
  assert.ok(await fs.stat(path.join(home, '.receipt-index')));
  await service.uninstall();
  assert.ok(await fs.stat(path.join(home, '.receipt-index')));
  assert.equal((await service.store.readReceipts()).length, 1);
  assert.ok(await fs.stat(home));
});
