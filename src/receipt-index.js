import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './errors.js';

const SCHEMA_VERSION = 1;
const TAIL_ANCHOR_BYTES = 512;
const DAY_MS = 86_400_000;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function indexedKey(receipt) {
  if (!receipt.idempotencyKey) return null;
  return [receipt.connectionId || '', receipt.capability || '', receipt.idempotencyKey].join('\0');
}

function safeComponent(value) {
  return hash(String(value || ''));
}

function isTerminal(receipt) {
  if (receipt.outcome === 'failure' && receipt.attemptedExternal === true) return false;
  return [
    'success', 'provider-error', 'failure', 'pre-provider-failure',
    'abandoned-pre-provider', 'external-reconciled-applied',
    'external-reconciled-not-applied'
  ].includes(receipt.outcome);
}

function isBudgetEvidence(receipt) {
  return receipt.budgetReserved === true
    || receipt.attemptedExternal === true
    || receipt.outcome === 'budget-released'
    || ['abandoned-pre-provider', 'external-reconciled-not-applied'].includes(receipt.outcome);
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

export class ReceiptIndex {
  constructor(home, receiptsPath, inspectReceiptLog) {
    this.home = home;
    this.receiptsPath = receiptsPath;
    this.inspectReceiptLog = inspectReceiptLog;
    this.root = path.join(home, '.receipt-index');
    this.metaPath = path.join(this.root, 'meta.json');
    this.idempotencyDir = path.join(this.root, 'idempotency');
    this.executionDir = path.join(this.root, 'execution');
    this.budgetDir = path.join(this.root, 'budget');
    this.unresolvedDir = path.join(this.root, 'unresolved');
  }

  async failCorrupt(message, details = {}) {
    fail('RECEIPT_LOG_CORRUPT', message, details);
  }

  async logStat() {
    try { return await fs.stat(this.receiptsPath); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }

  async tailAnchor(size) {
    if (!size) return hash('');
    const start = Math.max(0, size - TAIL_ANCHOR_BYTES);
    const handle = await fs.open(this.receiptsPath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      return hash(buf);
    } finally { await handle.close(); }
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.rebuild();
  }

  async rebuild() {
    await fs.rm(this.root, { recursive: true, force: true });
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.mkdir(this.idempotencyDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.executionDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.budgetDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.unresolvedDir, { recursive: true, mode: 0o700 })
    ]);
    let raw;
    try { raw = await fs.readFile(this.receiptsPath); }
    catch (err) { if (err.code === 'ENOENT') raw = Buffer.alloc(0); else throw err; }
    let offset = 0;
    const executions = new Map();
    const lines = raw.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (line.trim()) {
        let receipt;
        try { receipt = JSON.parse(line); }
        catch {
          await this.failCorrupt('Connections receipt log contains malformed data; history was preserved and external execution is blocked', {
            line: i + 1, byteOffset: offset, validReceiptCount: i
          });
        }
        await this.indexReceipt(receipt, false);
        if (receipt.executionId) {
          const prior = executions.get(receipt.executionId) || { edgeEntered: false, latest: null };
          prior.edgeEntered = prior.edgeEntered || receipt.providerEdgeEntered === true || receipt.outcome === 'external-unknown' || (receipt.outcome === 'failure' && receipt.attemptedExternal === true);
          prior.latest = receipt;
          executions.set(receipt.executionId, prior);
          if (isTerminal(receipt)) executions.delete(receipt.executionId);
        }
      }
      offset += lineBytes + (i < lines.length - 1 ? 1 : 0);
    }
    for (const [executionId, record] of executions) {
      if (!record.latest.connectionId) continue;
      await this.writeUnresolved(record.latest, record.edgeEntered);
    }
    const stat = await this.logStat();
    await this.writeMeta(stat?.size || 0, stat);
  }

  async writeMeta(offset, stat) {
    await atomicJson(this.metaPath, {
      schemaVersion: SCHEMA_VERSION,
      offset,
      logSize: stat?.size || 0,
      mtimeMs: stat?.mtimeMs || 0,
      ctimeMs: stat?.ctimeMs || 0,
      ino: stat?.ino || 0,
      anchor: await this.tailAnchor(stat?.size || 0)
    });
  }

  async indexReceipt(receipt, append = true) {
    const line = JSON.stringify(receipt) + '\n';
    const paths = [];
    const key = indexedKey(receipt);
    if (key) paths.push(path.join(this.idempotencyDir, safeComponent(key).slice(0, 3) + '.ndjson'));
    if (isBudgetEvidence(receipt)) {
      const day = String(receipt.timestamp || '').slice(0, 10) || 'unknown-day';
      paths.push(path.join(this.budgetDir, safeComponent(receipt.connectionId), day + '.ndjson'));
    }
    if (receipt.executionId) {
      const executionPath = path.join(this.executionDir, safeComponent(receipt.executionId) + '.ndjson');
      paths.push(executionPath);
      if (isTerminal(receipt)) await fs.rm(executionPath, { force: true });
    }
    if (append) {
      for (const file of paths) {
        if (file.startsWith(this.executionDir) && isTerminal(receipt)) continue;
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(file, line, { mode: 0o600 });
      }
    } else {
      for (const file of paths) {
        if (file.startsWith(this.executionDir) && isTerminal(receipt)) continue;
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(file, line, { mode: 0o600 });
      }
    }
    if (receipt.executionId && receipt.connectionId) {
      const edge = receipt.providerEdgeEntered === true || receipt.outcome === 'external-unknown' || (receipt.outcome === 'failure' && receipt.attemptedExternal === true);
      if (isTerminal(receipt)) await fs.rm(this.unresolvedPath(receipt.connectionId, receipt.executionId), { force: true });
      else {
        const previous = await readJson(this.unresolvedPath(receipt.connectionId, receipt.executionId));
        await this.writeUnresolved(receipt, Boolean(previous?.edgeEntered || edge));
      }
    } else if (receipt.connectionId && receipt.idempotencyKey
      && ['pending', 'budget-reserved', 'failure'].includes(receipt.outcome)) {
      const legacyDir = path.join(this.unresolvedDir, safeComponent(receipt.connectionId));
      const legacyPath = path.join(legacyDir, 'legacy-' + safeComponent(receipt.receiptId) + '.json');
      if (isTerminal(receipt)) await fs.rm(legacyPath, { force: true });
      else await atomicJson(legacyPath, { edgeEntered: receipt.outcome === 'failure' && receipt.attemptedExternal === true, receipt });
    }
  }

  unresolvedPath(connectionId, executionId) {
    return path.join(this.unresolvedDir, safeComponent(connectionId), safeComponent(executionId) + '.json');
  }

  async writeUnresolved(receipt, edgeEntered) {
    await atomicJson(this.unresolvedPath(receipt.connectionId, receipt.executionId), {
      edgeEntered,
      receipt
    });
  }

  async ensure() {
    let meta;
    try { meta = await readJson(this.metaPath); }
    catch { return this.rebuild(); }
    if (!meta || meta.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(meta.offset)) return this.initialize();
    const stat = await this.logStat();
    const size = stat?.size || 0;
    if (size < meta.offset) await this.failCorrupt('Connections receipt log was shortened after its index checkpoint', { indexedBytes: meta.offset, bytes: size });
    if (size === meta.offset) {
      if (stat && (stat.mtimeMs !== meta.mtimeMs || stat.ctimeMs !== meta.ctimeMs || stat.ino !== meta.ino)) return this.rebuild();
      return;
    }
    if (meta.anchor !== await this.tailAnchor(meta.offset)) await this.failCorrupt('Connections receipt history changed before the indexed append boundary', { indexedBytes: meta.offset, bytes: size });
    const handle = await fs.open(this.receiptsPath, 'r');
    try {
      let position = meta.offset;
      let pending = Buffer.alloc(0);
      const buffer = Buffer.alloc(64 * 1024);
      while (position < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
        if (!bytesRead) break;
        position += bytesRead;
        const chunk = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let i = 0; i < chunk.length; i += 1) {
          if (chunk[i] !== 10) continue;
          const line = chunk.subarray(start, i).toString('utf8');
          if (line.trim()) {
            let receipt;
            try { receipt = JSON.parse(line); }
            catch { await this.failCorrupt('Connections receipt log contains malformed appended data', { byteOffset: position - chunk.length + start }); }
            await this.indexReceipt(receipt);
          }
          start = i + 1;
        }
        pending = chunk.subarray(start);
      }
      if (pending.length) await this.failCorrupt('Connections receipt log ends with an incomplete appended record', { byteOffset: size - pending.length });
    } finally { await handle.close(); }
    await this.writeMeta(size, await this.logStat());
  }

  async append(receipt) {
    await this.ensure();
    const stat = await this.logStat();
    const offset = stat?.size || 0;
    let separator = Buffer.alloc(0);
    if (offset > 0) {
      const handle = await fs.open(this.receiptsPath, 'r');
      try {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, offset - 1);
        if (last[0] !== 10) separator = Buffer.from('\n');
      } finally { await handle.close(); }
    }
    const line = Buffer.concat([separator, Buffer.from(JSON.stringify(receipt) + '\n', 'utf8')]);
    await fs.appendFile(this.receiptsPath, line, { mode: 0o600 });
    await this.indexReceipt(receipt);
    await this.writeMeta(offset + line.length, await this.logStat());
    return receipt;
  }

  async readIndexed(file) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const seen = new Set();
      const result = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let item;
        try { item = JSON.parse(line); }
        catch { await this.rebuild(); return this.readIndexed(file); }
        const receipt = item.receipt || item;
        if (!seen.has(receipt.receiptId)) { seen.add(receipt.receiptId); result.push(receipt); }
      }
      return result;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async idempotencyHistory({ connectionId, capability, idempotencyKey }) {
    if (!idempotencyKey) return [];
    await this.ensure();
    const key = [connectionId || '', capability || '', idempotencyKey].join('\0');
    const records = await this.readIndexed(path.join(this.idempotencyDir, safeComponent(key).slice(0, 3) + '.ndjson'));
    return records.filter((receipt) => indexedKey(receipt) === key);
  }

  async executionHistory(executionId) {
    if (!executionId) return [];
    await this.ensure();
    return this.readIndexed(path.join(this.executionDir, safeComponent(executionId) + '.ndjson'));
  }

  async budgetReceipts(connectionId, now = Date.now()) {
    await this.ensure();
    const connectionDir = path.join(this.budgetDir, safeComponent(connectionId));
    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
    return [
      ...await this.readIndexed(path.join(connectionDir, yesterday + '.ndjson')),
      ...await this.readIndexed(path.join(connectionDir, today + '.ndjson'))
    ];
  }

  async unresolvedReceipts(connectionId) {
    await this.ensure();
    const dir = path.join(this.unresolvedDir, safeComponent(connectionId));
    let files;
    try { files = await fs.readdir(dir); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const records = [];
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const record = await readJson(path.join(dir, name));
      if (record?.receipt) records.push({ ...record.receipt, providerEdgeEntered: record.edgeEntered });
    }
    return records;
  }
}
