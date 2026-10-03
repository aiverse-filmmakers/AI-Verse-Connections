import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConnectionsService } from '../src/service.js';
import { StateStore } from '../src/state-store.js';
import { tmpHome, expectCode } from '../test-support/helpers.js';

const childPath = fileURLToPath(new URL('../test-support/write-lock-child.js', import.meta.url));

function startChild(home, mode) {
  return fork(childPath, [home, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

function waitForMessage(child, expected) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for child message: ${expected}`)), 10000);
    child.on('message', (message) => {
      if (message?.type !== expected) return;
      clearTimeout(timer);
      resolve(message);
    });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited before ${expected} (code ${code})`));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

test('live cross-process holder is never reclaimed and doctor reports it as healthy', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();
  await service.setup({ systemId: 'sys-lock' });

  const child = startChild(home, 'hold');
  const held = await waitForMessage(child, 'acquired');
  const health = await service.store.inspectWriteLock();
  assert.equal(health.state, 'held');
  assert.equal(health.owner.pid, held.pid);
  const doctor = await service.doctor();
  assert.equal(doctor.doctor.checks.find((check) => check.name === 'write-lock').ok, true);

  await expectCode(service.store.withLock(() => {}, { timeoutMs: 100 }), 'STATE_LOCK_TIMEOUT');
  assert.equal((await service.store.inspectWriteLock()).owner.pid, held.pid);

  child.send({ release: true });
  await waitForExit(child);
  await service.store.withLock(() => {});
  assert.equal((await service.store.inspectWriteLock()).state, 'clear');
});

test('crashed process holder is diagnosed and safely reclaimed by the next canonical mutation', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();
  await service.setup({ systemId: 'sys-crash' });

  const child = startChild(home, 'hold');
  await waitForMessage(child, 'acquired');
  child.kill();
  await waitForExit(child);

  const before = await service.store.inspectWriteLock();
  assert.equal(before.state, 'stale-holder');
  const doctor = await service.doctor();
  const lockCheck = doctor.doctor.checks.find((check) => check.name === 'write-lock');
  assert.equal(lockCheck.ok, false);
  assert.equal(lockCheck.detail.state, 'stale-holder');

  await service.store.setLifecycle({ enabled: false });
  assert.equal((await service.store.inspectWriteLock()).state, 'clear');
  assert.equal((await service.store.getLifecycle()).enabled, false);
});

test('concurrent processes serialize after crashed-holder recovery without lost mutations', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();

  const holder = startChild(home, 'hold');
  await waitForMessage(holder, 'acquired');
  holder.kill();
  await waitForExit(holder);

  const workers = Array.from({ length: 5 }, () => startChild(home, 'bump'));
  const done = workers.map((worker) => waitForMessage(worker, 'done'));
  for (const worker of workers) worker.send({ go: true });
  await Promise.all(done);
  await Promise.all(workers.map(waitForExit));

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'counter.json'), 'utf8')), { value: 5 });
  assert.equal((await service.store.inspectWriteLock()).state, 'clear');
});

test('unidentifiable legacy directory lock is surfaced and fails closed', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();
  await fs.mkdir(path.join(home, '.write.lock'));

  const doctor = await service.doctor();
  const lockCheck = doctor.doctor.checks.find((check) => check.name === 'write-lock');
  assert.equal(lockCheck.ok, false);
  assert.equal(lockCheck.detail.state, 'legacy-unverifiable');
  await expectCode(service.store.withLock(() => {}), 'STATE_LOCK_UNRECOVERABLE');
  assert.equal((await fs.stat(path.join(home, '.write.lock'))).isDirectory(), true);
});
