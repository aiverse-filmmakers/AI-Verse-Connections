import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { COMPONENT_ID, STATE_SCHEMA_VERSION } from './constants.js';
import { fail } from './errors.js';
import { nowIso } from './util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const OWNERSHIP_FILENAME = 'ownership.json';
const OWNERSHIP_SCHEMA_VERSION = 1;
const OWNED_ENTRIES = new Set([
  'lifecycle.json',
  'registry.json',
  'credentials.enc.json',
  'receipts.ndjson',
  '.write.lock',
  OWNERSHIP_FILENAME
]);
const ATOMIC_JSON_FILES = ['lifecycle.json', 'registry.json', 'credentials.enc.json'];
const LEGACY_ENTRIES = new Set([
  'lifecycle.json',
  'registry.json',
  'credentials.enc.json',
  'receipts.ndjson',
  '.write.lock'
]);

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function protectedHomes() {
  const values = [
    path.parse(path.resolve(os.homedir())).root,
    os.homedir(),
    path.dirname(os.homedir()),
    os.tmpdir(),
    process.env.SystemRoot,
    process.env.WINDIR,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    '/',
    '/etc',
    '/usr',
    '/var',
    '/opt',
    '/home',
    '/Users',
    '/System',
    '/Library',
    '/Applications',
    '/private/etc',
    '/private/var',
    '/private/tmp'
  ].filter(Boolean);
  return new Set(values.map(pathKey));
}

function assertNotBroadHome(value) {
  if (protectedHomes().has(pathKey(value))) {
    fail('UNSAFE_CONNECTIONS_HOME', `Refusing broad or system Connections home: ${path.resolve(value)}`);
  }
}

async function lstatOrNull(value) {
  try { return await fs.lstat(value); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function isOwnedTempEntry(name) {
  return ATOMIC_JSON_FILES.some((base) => name.startsWith(`${base}.`) && name.endsWith('.tmp'));
}

function isKnownOwnedEntry(name) {
  return OWNED_ENTRIES.has(name) || name.startsWith('.write.lock.stale.') || name.startsWith('.write.lock.reclaim.') || isOwnedTempEntry(name);
}

async function removeKnownEntry(fullPath) {
  const stat = await lstatOrNull(fullPath);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    await fs.unlink(fullPath);
    return;
  }
  await fs.rm(fullPath, { recursive: true, force: true });
}

const LOCK_SCHEMA_VERSION = 1;
const LOCK_RECOVERY_SUFFIX = '.reclaim';

async function processLiveness(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'live'; }
  catch (err) {
    if (err.code === 'ESRCH') return 'dead';
    if (err.code === 'EPERM') return 'live';
    return 'unknown';
  }
}

async function readLockRecord(lockPath) {
  let stat;
  try { stat = await fs.lstat(lockPath); }
  catch (err) { if (err.code === 'ENOENT') return { state: 'clear', ok: true }; throw err; }
  if (stat.isSymbolicLink()) return { state: 'invalid', ok: false, reason: 'symlink' };
  if (stat.isDirectory()) return { state: 'legacy-unverifiable', ok: false, reason: 'legacy-directory-lock' };
  if (!stat.isFile()) return { state: 'invalid', ok: false, reason: 'not-a-regular-file' };
  let owner;
  try { owner = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return { state: 'clear', ok: true }; return { state: 'unverifiable', ok: false, reason: 'malformed-holder-record' }; }
  if (owner.schemaVersion !== LOCK_SCHEMA_VERSION || typeof owner.token !== 'string' || !owner.token || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.hostname !== 'string' || !owner.hostname) {
    return { state: 'unverifiable', ok: false, reason: 'invalid-holder-record' };
  }
  if (owner.hostname !== os.hostname()) return { state: 'foreign-host', ok: false, owner };
  const liveness = await processLiveness(owner.pid);
  if (liveness === 'dead') return { state: 'stale-holder', ok: false, owner };
  if (liveness !== 'live') return { state: 'unverifiable', ok: false, owner, reason: 'process-liveness-unknown' };
  return { state: 'held', ok: true, owner };
}

export function defaultHome() {
  return process.env.AIVERSE_CONNECTIONS_HOME || path.join(os.homedir(), '.aiverse', 'connections');
}

export class StateStore {
  constructor(home = defaultHome()) {
    this.home = path.resolve(home);
    this.lifecyclePath = path.join(this.home, 'lifecycle.json');
    this.registryPath = path.join(this.home, 'registry.json');
    this.vaultPath = path.join(this.home, 'credentials.enc.json');
    this.receiptsPath = path.join(this.home, 'receipts.ndjson');
    this.lockPath = path.join(this.home, '.write.lock');
    this.ownershipPath = path.join(this.home, OWNERSHIP_FILENAME);
  }

  async inspectHome({ allowMissing = false } = {}) {
    assertNotBroadHome(this.home);
    const stat = await lstatOrNull(this.home);
    if (!stat) {
      if (allowMissing) return { absoluteHome: this.home, realHome: null };
      fail('CONNECTIONS_HOME_NOT_OWNED', `Connections home does not exist: ${this.home}`);
    }
    if (stat.isSymbolicLink()) {
      fail('UNSAFE_CONNECTIONS_HOME', `Connections home may not be a symlink or junction: ${this.home}`);
    }
    if (!stat.isDirectory()) {
      fail('UNSAFE_CONNECTIONS_HOME', `Connections home is not a directory: ${this.home}`);
    }
    const realHome = await fs.realpath(this.home);
    assertNotBroadHome(realHome);
    return { absoluteHome: this.home, realHome };
  }

  async readOwnership(realHome) {
    const markerPath = path.join(realHome, OWNERSHIP_FILENAME);
    const stat = await lstatOrNull(markerPath);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('CONNECTIONS_HOME_OWNERSHIP_INVALID', 'Connections ownership marker must be a regular file');
    }
    let marker;
    try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
    catch (err) {
      fail('CONNECTIONS_HOME_OWNERSHIP_INVALID', 'Connections ownership marker is unreadable or malformed', { cause: err.message });
    }
    if (marker.schemaVersion !== OWNERSHIP_SCHEMA_VERSION || marker.componentId !== COMPONENT_ID) {
      fail('CONNECTIONS_HOME_OWNERSHIP_INVALID', 'Connections ownership marker belongs to a different component or schema');
    }
    if (typeof marker.rootRealpath !== 'string' || pathKey(marker.rootRealpath) !== pathKey(realHome)) {
      fail('CONNECTIONS_HOME_OWNERSHIP_INVALID', 'Connections ownership marker does not bind this exact real path');
    }
    return marker;
  }

  async legacyHomeLooksOwned(realHome, entries) {
    if (!entries.includes('lifecycle.json')) return false;
    if (entries.some((name) => !LEGACY_ENTRIES.has(name) && !isOwnedTempEntry(name))) return false;
    try {
      const lifecycle = JSON.parse(await fs.readFile(path.join(realHome, 'lifecycle.json'), 'utf8'));
      return lifecycle?.schemaVersion === STATE_SCHEMA_VERSION
        && typeof lifecycle.installed === 'boolean'
        && typeof lifecycle.setup === 'boolean'
        && typeof lifecycle.enabled === 'boolean';
    } catch {
      return false;
    }
  }

  async writeOwnership(realHome, existing = null) {
    const markerPath = path.join(realHome, OWNERSHIP_FILENAME);
    const timestamp = nowIso();
    const marker = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      componentId: COMPONENT_ID,
      rootRealpath: realHome,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    };
    try {
      await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return this.readOwnership(realHome);
    }
    return marker;
  }

  async claimHome() {
    let { realHome } = await this.inspectHome({ allowMissing: true });
    if (!realHome) {
      await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
      ({ realHome } = await this.inspectHome());
    }

    const ownership = await this.readOwnership(realHome);
    if (ownership) return { realHome, ownership };

    const entries = await fs.readdir(realHome);
    const fresh = entries.length === 0;
    const legacyOwned = !fresh && await this.legacyHomeLooksOwned(realHome, entries);
    if (!fresh && !legacyOwned) {
      fail('CONNECTIONS_HOME_NOT_OWNED', `Refusing to claim non-empty foreign Connections home: ${this.home}`);
    }
    const marker = await this.writeOwnership(realHome);
    return { realHome, ownership: marker, migratedLegacy: legacyOwned };
  }

  async requireOwnedHome() {
    const { realHome } = await this.inspectHome();
    const ownership = await this.readOwnership(realHome);
    if (!ownership) {
      fail('CONNECTIONS_HOME_NOT_OWNED', `Connections ownership marker is missing: ${this.home}`);
    }
    return { realHome, ownership };
  }

  async ensureHome() { return this.requireOwnedHome(); }

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

  async inspectWriteLock() {
    const { realHome } = await this.inspectHome({ allowMissing: true });
    if (!realHome) return { state: 'clear', ok: true };
    const recovery = await readLockRecord(this.lockPath + LOCK_RECOVERY_SUFFIX);
    if (recovery.state !== 'clear') return { state: recovery.state === 'held' ? 'recovery-in-progress' : 'recovery-lock-unverifiable', ok: recovery.state === 'held', recovery };
    return readLockRecord(this.lockPath);
  }

  async createLockRecord(filePath, owner) {
    const tmp = filePath + '.' + process.pid + '.' + owner.token + '.tmp';
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(owner) + '\n');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.link(tmp, filePath);
      return true;
    } catch (err) { if (err.code === 'EEXIST') return false; throw err; }
    finally { await handle?.close().catch(() => {}); await fs.rm(tmp, { force: true }).catch(() => {}); }
  }

  async releaseLockRecord(filePath, token) {
    const state = await readLockRecord(filePath);
    if (state.state === 'clear') return;
    if (state.owner?.token === token) await fs.unlink(filePath).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }

  async reclaimStaleLock(expectedToken) {
    const recoveryPath = this.lockPath + LOCK_RECOVERY_SUFFIX;
    const gate = { schemaVersion: LOCK_SCHEMA_VERSION, purpose: 'stale-lock-recovery', token: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), acquiredAt: nowIso() };
    const claimed = await this.createLockRecord(recoveryPath, gate);
    if (!claimed) {
      const recovery = await readLockRecord(recoveryPath);
      if (recovery.state === 'stale-holder') {
        fail('STATE_LOCK_RECOVERY_REQUIRED', 'A prior stale-lock recovery was interrupted; inspect doctor and safely clear its dead recovery holder', {
          pid: recovery.owner.pid,
          hostname: recovery.owner.hostname
        });
      }
      if (['legacy-unverifiable', 'invalid', 'unverifiable', 'foreign-host'].includes(recovery.state)) {
        fail('STATE_LOCK_RECOVERY_REQUIRED', 'Connections state lock recovery holder cannot be verified', {
          state: recovery.state,
          reason: recovery.reason || null,
          pid: recovery.owner?.pid || null,
          hostname: recovery.owner?.hostname || null
        });
      }
      return false;
    }
    try {
      const current = await readLockRecord(this.lockPath);
      if (current.state !== 'stale-holder' || current.owner.token !== expectedToken) return false;
      const quarantine = this.lockPath + '.stale.' + expectedToken;
      try { await fs.rename(this.lockPath, quarantine); }
      catch (err) { if (['ENOENT', 'EEXIST'].includes(err.code)) return false; throw err; }
      const moved = await readLockRecord(quarantine);
      if (moved.owner?.token !== expectedToken || moved.state !== 'stale-holder') {
        // The recovery claim prevents another reclaimer from racing this check.
        const restored = moved.owner && await this.createLockRecord(this.lockPath, moved.owner);
        if (restored) await fs.rm(quarantine, { force: true });
        return false;
      }
      await fs.unlink(quarantine);
      return true;
    } finally { await this.releaseLockRecord(recoveryPath, gate.token); }
  }

  async withLock(fn, { timeoutMs = 5000 } = {}) {
    await this.ensureHome();
    const started = Date.now();
    const owner = { schemaVersion: LOCK_SCHEMA_VERSION, token: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), acquiredAt: nowIso() };
    while (true) {
      const health = await readLockRecord(this.lockPath);
      if (health.state === 'clear') {
        const recovery = await readLockRecord(this.lockPath + LOCK_RECOVERY_SUFFIX);
        if (recovery.state === 'clear') { if (await this.createLockRecord(this.lockPath, owner)) break; continue; }
        if (recovery.state !== 'held') fail('STATE_LOCK_RECOVERY_REQUIRED', 'Connections state lock recovery is itself incomplete or unverifiable', { state: recovery.state, reason: recovery.reason || null });
      } else if (health.state === 'stale-holder') {
        await this.reclaimStaleLock(health.owner.token);
      } else if (['legacy-unverifiable', 'invalid', 'unverifiable', 'foreign-host'].includes(health.state)) {
        fail('STATE_LOCK_UNRECOVERABLE', 'Connections state lock holder cannot be safely verified; inspect doctor before removing it', { state: health.state, reason: health.reason || null, hostname: health.owner?.hostname || null, pid: health.owner?.pid || null });
      }
      if (Date.now() - started > timeoutMs) fail('STATE_LOCK_TIMEOUT', 'Timed out waiting for Connections state lock', { state: health.state });
      await sleep(25);
    }
    try { return await fn(); }
    finally { await this.releaseLockRecord(this.lockPath, owner.token); }
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

  async setLifecycleUnlocked(patch) {
    const current = await this.getLifecycle();
    const next = { ...current, ...patch, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: nowIso() };
    await this.atomicWriteJson(this.lifecyclePath, next);
    return next;
  }

  async setLifecycle(patch) {
    return this.withLock(() => this.setLifecycleUnlocked(patch));
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

  async purgeAll() {
    const { realHome } = await this.requireOwnedHome();
    const entries = await fs.readdir(realHome);
    const preservedEntries = entries.filter((name) => !isKnownOwnedEntry(name));

    for (const name of entries) {
      if (name === OWNERSHIP_FILENAME || !isKnownOwnedEntry(name)) continue;
      await removeKnownEntry(path.join(realHome, name));
    }

    await removeKnownEntry(path.join(realHome, OWNERSHIP_FILENAME));

    let rootRemoved = false;
    if (preservedEntries.length === 0) {
      try {
        await fs.rmdir(realHome);
        rootRemoved = true;
      } catch (err) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
      }
    }
    return { rootRemoved, preservedEntries };
  }
}
