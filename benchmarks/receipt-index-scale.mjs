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
          connectionId: 'historic-' + (i % 500),
          capability: 'history.read',
          outcome: 'success'
        }) + '\n');
      }
    } finally { await handle.close(); }

    global.gc?.();
    const rebuildStarted = performance.now();
    await store.idempotencyHistory(target);
    const rebuildMs = performance.now() - rebuildStarted;
    const timings = [];
    for (let i = 0; i < samples; i += 1) {
      const started = performance.now();
      const found = await store.idempotencyHistory(target);
      if (found.length !== i * 2) throw new Error('Unexpected indexed key history length: ' + found.length);
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

const small = await medianFor(1_000);
const large = await medianFor(100_000);
const ratio = Number((large.medianMs / Math.max(small.medianMs, 0.05)).toFixed(2));
console.log(JSON.stringify({ benchmark: 'indexed receipt lookup and pending/terminal commit', samples, small, large, ratio }, null, 2));
if (ratio > 4) throw new Error('Receipt lookup/commit scale ratio exceeded 4x: ' + ratio);
if (large.heapMiB > small.heapMiB + 32) throw new Error('Post-rebuild heap growth exceeded 32 MiB: ' + small.heapMiB + ' -> ' + large.heapMiB);
