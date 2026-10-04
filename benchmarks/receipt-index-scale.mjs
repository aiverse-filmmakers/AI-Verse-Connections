import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StateStore } from '../src/state-store.js';

const samples = 25;
const target = { connectionId: 'scale-connection', capability: 'scale.send', idempotencyKey: 'scale-hot-key' };

async function medianFor(size) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'connections-receipt-scale-'));
  try {
    const store = new StateStore(home);
    await store.claimHome();
    await store.setLifecycle({ installed: true, setup: true, enabled: true, systemId: 'scale-system' });
    const handle = await fs.open(store.receiptsPath, 'w', 0o600);
    try {
      for (let i = 0; i < size; i += 1) {
        await handle.write(JSON.stringify({
          receiptId: 'history-' + i,
          timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          ...target,
          ...(i === size - 1 ? { executionId: 'history-execution-anchor' } : {}),
          outcome: 'pre-provider-failure',
          attemptedExternal: false
        }) + '\n');
      }
    } finally { await handle.close(); }

    global.gc?.();
    const rebuildStarted = performance.now();
    const rebuilt = await store.idempotencyLatest(target);
    if (rebuilt?.receipt?.receiptId !== 'history-' + (size - 1)
      || rebuilt.executionId !== 'history-execution-anchor') {
      throw new Error('Rebuilt hot-key state did not preserve the latest receipt and execution identity');
    }
    const rebuildMs = performance.now() - rebuildStarted;
    const timings = [];
    for (let i = 0; i < samples; i += 1) {
      const started = performance.now();
      const found = await store.idempotencyLatest(target);
      const expectedReceiptId = i === 0 ? 'history-' + (size - 1) : 'scale-success-' + (i - 1);
      if (found?.receipt?.receiptId !== expectedReceiptId) {
        throw new Error('Unexpected latest idempotency receipt: ' + found?.receipt?.receiptId + ', expected ' + expectedReceiptId);
      }
      const executionId = 'scale-execution-' + i;
      const timestamp = new Date().toISOString();
      await store.appendReceipt({
        receiptId: 'scale-pending-' + i, timestamp, ...target,
        executionId, outcome: 'pending', executionActive: true
      });
      await store.appendReceipt({
        receiptId: 'scale-success-' + i, timestamp, ...target,
        executionId, outcome: 'success', attemptedExternal: true
      });
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    global.gc?.();
    const memory = process.memoryUsage();
    return { records: size, rebuildMs: Number(rebuildMs.toFixed(3)), medianMs: Number(timings[Math.floor(timings.length / 2)].toFixed(3)), heapMiB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)), rssMiB: Number((memory.rss / 1024 / 1024).toFixed(1)) };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function distinctKeyRebuildMemory(size) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'connections-receipt-distinct-scale-'));
  try {
    const store = new StateStore(home);
    await store.claimHome();
    await store.setLifecycle({ installed: true, setup: true, enabled: true, systemId: 'scale-system' });
    const handle = await fs.open(store.receiptsPath, 'w', 0o600);
    try {
      for (let i = 0; i < size; i += 1) {
        await handle.write(JSON.stringify({
          receiptId: 'distinct-history-' + i,
          timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          connectionId: 'scale-connection', capability: 'scale.send',
          idempotencyKey: 'distinct-key-' + i,
          outcome: 'pre-provider-failure', attemptedExternal: false
        }) + '\n');
      }
    } finally { await handle.close(); }

    global.gc?.();
    let peakHeapBytes = process.memoryUsage().heapUsed;
    let peakRssBytes = process.memoryUsage().rss;
    const sampler = setInterval(() => {
      const memory = process.memoryUsage();
      peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
    }, 10);
    try {
      const found = await store.idempotencyLatest({
        connectionId: 'scale-connection', capability: 'scale.send', idempotencyKey: 'distinct-key-' + (size - 1)
      });
      if (found?.receipt?.receiptId !== 'distinct-history-' + (size - 1)) {
        throw new Error('Distinct-key rebuild lost the latest receipt');
      }
    } finally { clearInterval(sampler); }
    global.gc?.();
    const memory = process.memoryUsage();
    return {
      records: size,
      peakHeapMiB: Number((peakHeapBytes / 1024 / 1024).toFixed(1)),
      peakRssMiB: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
      postGcHeapMiB: Number((memory.heapUsed / 1024 / 1024).toFixed(1))
    };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

const small = await medianFor(1_000);
const large = await medianFor(100_000);
const ratio = Number((large.medianMs / Math.max(small.medianMs, 0.05)).toFixed(2));
const smallDistinct = await distinctKeyRebuildMemory(1_000);
const largeDistinct = await distinctKeyRebuildMemory(100_000);
console.log(JSON.stringify({ benchmark: 'same-key replay plus distinct-key index rebuild', samples, repeatedKey: { small, large, ratio }, distinctKeyRebuild: { small: smallDistinct, large: largeDistinct } }, null, 2));
if (ratio > 4) throw new Error('Receipt lookup/commit scale ratio exceeded 4x: ' + ratio);
if (large.heapMiB > small.heapMiB + 32) throw new Error('Post-rebuild heap growth exceeded 32 MiB: ' + small.heapMiB + ' -> ' + large.heapMiB);
if (largeDistinct.peakHeapMiB > 128) throw new Error('Distinct-key index rebuild peak heap exceeded 128 MiB: ' + largeDistinct.peakHeapMiB);
if (largeDistinct.peakRssMiB > 320) throw new Error('Distinct-key index rebuild peak RSS exceeded 320 MiB: ' + largeDistinct.peakRssMiB);
if (largeDistinct.postGcHeapMiB > smallDistinct.postGcHeapMiB + 32) {
  throw new Error('Distinct-key post-rebuild heap growth exceeded 32 MiB: ' + smallDistinct.postGcHeapMiB + ' -> ' + largeDistinct.postGcHeapMiB);
}
