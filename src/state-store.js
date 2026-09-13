import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STATE_SCHEMA_VERSION } from './constants.js';
import { fail } from './errors.js';
import { nowIso } from './util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultHome() {
  return process.env.AIVERSE_CONNECTIONS_HOME || path.join(os.homedir(), '.aiverse', 'connections');
}

export class StateStore {
  constructor(home = defaultHome()) {
    this.home = home;
    this.lifecyclePath = path.join(home, 'lifecycle.json');
    this.registryPath = path.join(home, 'registry.json');
    this.vaultPath = path.join(home, 'credentials.enc.json');
    this.receiptsPath = path.join(home, 'receipts.ndjson');
    this.lockPath = path.join(home, '.write.lock');
  }

  async ensureHome() { await fs.mkdir(this.home, { recursive: true, mode: 0o700 }); }

  async readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (err) {
      if (err.code === 'ENOENT') return structuredClone(fallback);
      fail('STATE_READ_FAILED', `Failed reading ${file}`, { cause: err.message });
    }
  }

  async atomicWriteJson(file, value) {
    await this.ensureHome();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async withLock(fn, { timeoutMs = 5000 } = {}) {
    await this.ensureHome();
    const started = Date.now();
    while (true) {
      try {
        await fs.mkdir(this.lockPath);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (Date.now() - started > timeoutMs) fail('STATE_LOCK_TIMEOUT', 'Timed out waiting for Connections state lock');
        await sleep(25);
      }
    }
    try { return await fn(); }
    finally { await fs.rm(this.lockPath, { recursive: true, force: true }); }
  }

  async getLifecycle() {
    return this.readJson(this.lifecyclePath, {
      schemaVersion: STATE_SCHEMA_VERSION,
      installed: false,
      setup: false,
      enabled: false,
      systemId: null,
      installedVersion: null,
      updatedAt: null
    });
  }

  async setLifecycle(patch) {
    return this.withLock(async () => {
      const current = await this.getLifecycle();
      const next = { ...current, ...patch, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: nowIso() };
      await this.atomicWriteJson(this.lifecyclePath, next);
      return next;
    });
  }

  async getRegistry() {
    return this.readJson(this.registryPath, { schemaVersion: STATE_SCHEMA_VERSION, connections: {} });
  }

  async setRegistry(registry) {
    registry.schemaVersion = STATE_SCHEMA_VERSION;
    await this.atomicWriteJson(this.registryPath, registry);
  }

  async mutateRegistry(mutator) {
    return this.withLock(async () => {
      const registry = await this.getRegistry();
      const result = await mutator(registry);
      await this.setRegistry(registry);
      return result;
    });
  }

  async appendReceipt(receipt) {
    await this.ensureHome();
    await fs.appendFile(this.receiptsPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  }

  async readReceipts() {
    try {
      const raw = await fs.readFile(this.receiptsPath, 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async findIdempotentReceipt({ connectionId, capability, idempotencyKey, outcomes = ['success'] }) {
    if (!idempotencyKey) return null;
    const receipts = await this.readReceipts();
    return receipts.findLast((r) => r.connectionId === connectionId && r.capability === capability && r.idempotencyKey === idempotencyKey && outcomes.includes(r.outcome)) || null;
  }

  async purgeAll() { await fs.rm(this.home, { recursive: true, force: true }); }
}
