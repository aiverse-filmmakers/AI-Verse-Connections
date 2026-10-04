import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './errors.js';

const SCHEMA_VERSION = 2;
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
  constructor(home, receiptsPath) {
    this.home = home;
    this.receiptsPath = receiptsPath;
    this.root = path.join(home, '.receipt-index');
    this.metaPath = path.join(this.root, 'meta.json');
    this.catalogPath = path.join(this.root, 'catalog.json');
    this.catalogFiles = null;
    this.idempotencyDir = path.join(this.root, 'idempotency');
    this.executionDir = path.join(this.root, 'execution');
    this.budgetDir = path.join(this.root, 'budget');
    this.unresolvedDir = path.join(this.root, 'unresolved');
    this.unresolvedSummaryDir = path.join(this.root, 'unresolved-summary');
    this.rebuilding = false;
    this.rebuildFileStates = null;
    this.rebuildIdempotencyCurrent = null;
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
      fs.mkdir(this.unresolvedDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.unresolvedSummaryDir, { recursive: true, mode: 0o700 })
    ]);
    this.rebuilding = true;
    this.rebuildFileStates = new Map();
    this.rebuildIdempotencyCurrent = new Map();
    this.catalogFiles = new Set();
    let offset = 0;
    let lineNumber = 0;
    let validReceiptCount = 0;
    const processLine = async (line) => {
      lineNumber += 1;
      if (!line.toString('utf8').trim()) return;
      let receipt;
      try { receipt = JSON.parse(line.toString('utf8')); }
      catch {
        await this.failCorrupt('Connections receipt log contains malformed data; history was preserved and external execution is blocked', {
          line: lineNumber, byteOffset: offset, validReceiptCount
        });
      }
      validReceiptCount += 1;
      await this.indexReceipt(receipt, { offset, lineLength: line.length });
    };
    const stat = await this.logStat();
    if (stat) {
      let pending = Buffer.alloc(0);
      for await (const data of createReadStream(this.receiptsPath)) {
        const chunk = Buffer.concat([pending, data]);
        let start = 0;
        for (let i = 0; i < chunk.length; i += 1) {
          if (chunk[i] !== 10) continue;
          const line = chunk.subarray(start, i);
          await processLine(line);
          offset += line.length + 1;
          start = i + 1;
        }
        pending = chunk.subarray(start);
      }
      if (pending.length) {
        await processLine(pending);
        offset += pending.length;
      }
    }
    let receiptLogHandle = null;
    if (this.rebuildIdempotencyCurrent.size > 0) receiptLogHandle = await fs.open(this.receiptsPath, 'r');
    try {
      for (const [bucket, pointers] of [...this.rebuildIdempotencyCurrent]) {
        const entries = new Map();
        for (const [keyHash, pointer] of pointers) {
          const offset = pointer.offset;
          const line = Buffer.alloc(pointer.lineLength);
          const { bytesRead } = await receiptLogHandle.read(line, 0, line.length, offset);
          if (bytesRead !== line.length) {
            await this.failCorrupt('Connections receipt history changed while its idempotency index was rebuilding', {
              byteOffset: offset
            });
          }
          let receipt;
          try { receipt = JSON.parse(line.toString('utf8')); }
          catch { await this.failCorrupt('Connections receipt log contains malformed data during idempotency index rebuild', { byteOffset: offset }); }
          entries.set(keyHash, {
            receipt,
            executionId: pointer.executionId || receipt.executionId || null
          });
        }
        const file = path.join(this.idempotencyDir, bucket + '.json');
        await atomicJson(file, this.serializeCurrent(entries));
        this.catalogFiles.add(path.relative(this.root, file).split(path.sep).join('/'));
        this.rebuildIdempotencyCurrent.delete(bucket);
      }
    } finally {
      await receiptLogHandle?.close();
    }
    for (const [file, state] of this.rebuildFileStates) await atomicJson(file + '.meta.json', state);
    await atomicJson(this.catalogPath, { schemaVersion: SCHEMA_VERSION, files: [...this.catalogFiles].sort() });
    this.rebuilding = false;
    this.rebuildFileStates = null;
    this.rebuildIdempotencyCurrent = null;
    await this.writeMeta(offset, await this.logStat());
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

  unresolvedSummaryPath(connectionId, capability) {
    return path.join(this.unresolvedSummaryDir, safeComponent(connectionId), safeComponent(capability) + '.json');
  }

  async updateUnresolvedSummary(receipt, edgeEntered, { terminal = false } = {}) {
    const file = this.unresolvedSummaryPath(receipt.connectionId, receipt.capability);
    let current;
    try { current = await readJson(file); }
    catch { await this.rebuild(); current = await readJson(file); }
    if (!terminal) {
      if (!current || current.receipt?.executionId === receipt.executionId
        || current.receipt?.receiptId === receipt.receiptId) {
        await atomicJson(file, { edgeEntered, receipt });
      }
      return;
    }
    const sameExecution = receipt.executionId
      ? current?.receipt?.executionId === receipt.executionId
      : current?.receipt?.receiptId === receipt.receiptId;
    if (!sameExecution) return;
    const directory = path.join(this.unresolvedDir, safeComponent(receipt.connectionId), safeComponent(receipt.capability));
    let names = [];
    try { names = await fs.readdir(directory); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let candidate;
      try { candidate = await readJson(path.join(directory, name)); }
      catch { continue; }
      if (candidate?.receipt?.capability === receipt.capability) {
        await atomicJson(file, { edgeEntered: candidate.edgeEntered === true, receipt: candidate.receipt });
        return;
      }
    }
    await fs.rm(file, { force: true });
  }

  async appendIndexed(file, line) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (this.rebuilding) {
      const state = this.rebuildFileStates.get(file) || { schemaVersion: SCHEMA_VERSION, count: 0, bytes: 0, digest: hash('') };
      await fs.appendFile(file, line, { mode: 0o600 });
      state.count += 1;
      state.bytes += lineBytes;
      state.digest = hash(state.digest + '\0' + line.trimEnd());
      this.rebuildFileStates.set(file, state);
      this.catalogFiles.add(path.relative(this.root, file).split(path.sep).join('/'));
      return true;
    }
    let meta;
    try { meta = await readJson(file + '.meta.json'); }
    catch { await this.rebuild(); return false; }
    let stat;
    try { stat = await fs.stat(file); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    if (!this.catalogFiles?.has(relative) && stat?.size) { await this.rebuild(); return false; }
    if (!meta) {
      if (stat?.size) { await this.rebuild(); return false; }
      meta = { schemaVersion: SCHEMA_VERSION, count: 0, bytes: 0, digest: hash('') };
    }
    if (meta.schemaVersion !== SCHEMA_VERSION || meta.bytes !== (stat?.size || 0)) {
      await this.rebuild();
      return false;
    }
    await fs.appendFile(file, line, { mode: 0o600 });
    await atomicJson(file + '.meta.json', {
      schemaVersion: SCHEMA_VERSION,
      count: meta.count + 1,
      bytes: meta.bytes + lineBytes,
      digest: hash(meta.digest + '\0' + line.trimEnd())
    });
    if (!this.catalogFiles.has(relative)) {
      this.catalogFiles.add(relative);
      await atomicJson(this.catalogPath, { schemaVersion: SCHEMA_VERSION, files: [...this.catalogFiles].sort() });
    }
    return true;
  }

  async indexReceipt(receipt, { offset, lineLength } = {}) {
    const line = JSON.stringify(receipt) + '\n';
    const paths = [];
    const key = indexedKey(receipt);
    if (isBudgetEvidence(receipt)) {
      const day = String(receipt.timestamp || '').slice(0, 10) || 'unknown-day';
      paths.push(path.join(this.budgetDir, safeComponent(receipt.connectionId), day + '.ndjson'));
    }
    if (receipt.executionId) {
      const executionPath = path.join(this.executionDir, safeComponent(receipt.executionId) + '.ndjson');
      if (isTerminal(receipt)) await fs.rm(executionPath, { force: true });
      else paths.push(executionPath);
    }
    for (const file of paths) {
      if (!await this.appendIndexed(file, line)) return;
    }
    if (key) {
      const keyHash = hash(key);
      const bucket = keyHash.slice(0, 3);
      if (this.rebuilding) {
        let entries = this.rebuildIdempotencyCurrent.get(bucket);
        if (!entries) {
          entries = new Map();
          this.rebuildIdempotencyCurrent.set(bucket, entries);
        }
        const previous = entries.get(keyHash);
        const pointer = { offset, lineLength };
        if (receipt.executionId || previous?.executionId) pointer.executionId = receipt.executionId || previous.executionId;
        entries.set(keyHash, pointer);
      } else {
        await this.writeCurrentIdempotency(key, receipt);
      }
    }
    if (receipt.executionId && receipt.connectionId) {
      const edge = receipt.providerEdgeEntered === true || receipt.outcome === 'external-unknown' || (receipt.outcome === 'failure' && receipt.attemptedExternal === true);
      if (isTerminal(receipt)) {
        await fs.rm(this.unresolvedPath(receipt.connectionId, receipt.capability, receipt.executionId), { force: true });
        await this.updateUnresolvedSummary(receipt, false, { terminal: true });
      } else {
        const previous = await readJson(this.unresolvedPath(receipt.connectionId, receipt.capability, receipt.executionId));
        const edgeEntered = Boolean(previous?.edgeEntered || edge);
        await this.writeUnresolved(receipt, edgeEntered);
        await this.updateUnresolvedSummary(receipt, edgeEntered);
      }
    } else if (receipt.connectionId && receipt.idempotencyKey
      && ['pending', 'budget-reserved', 'failure'].includes(receipt.outcome)) {
      const legacyDir = path.join(this.unresolvedDir, safeComponent(receipt.connectionId), safeComponent(receipt.capability));
      const legacyPath = path.join(legacyDir, 'legacy-' + safeComponent(receipt.receiptId) + '.json');
      if (isTerminal(receipt)) await fs.rm(legacyPath, { force: true });
      else {
        const edgeEntered = receipt.outcome === 'failure' && receipt.attemptedExternal === true;
        await atomicJson(legacyPath, { edgeEntered, receipt });
        await this.updateUnresolvedSummary(receipt, edgeEntered);
      }
    }
  }

  unresolvedPath(connectionId, capability, executionId) {
    return path.join(this.unresolvedDir, safeComponent(connectionId), safeComponent(capability), safeComponent(executionId) + '.json');
  }

  async writeUnresolved(receipt, edgeEntered) {
    await atomicJson(this.unresolvedPath(receipt.connectionId, receipt.capability, receipt.executionId), {
      edgeEntered,
      receipt
    });
  }

  async ensure() {
    let meta;
    try { meta = await readJson(this.metaPath); }
    catch { return this.rebuild(); }
    let catalog;
    try { catalog = await readJson(this.catalogPath); }
    catch { return this.rebuild(); }
    if (!catalog || catalog.schemaVersion !== SCHEMA_VERSION || !Array.isArray(catalog.files)
      || catalog.files.some((file) => typeof file !== 'string')) return this.rebuild();
    this.catalogFiles = new Set(catalog.files);
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
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    if (!this.catalogFiles?.has(relative)) {
      try {
        await fs.stat(file);
        await this.rebuild();
        return this.readIndexed(file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return [];
      }
    }
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      let meta;
      try { meta = await readJson(file + '.meta.json'); }
      catch { await this.rebuild(); return this.readIndexed(file); }
      await this.rebuild();
      return this.readIndexed(file);
    }
    let meta;
    try { meta = await readJson(file + '.meta.json'); }
    catch { await this.rebuild(); return this.readIndexed(file); }
    if (!meta || meta.schemaVersion !== SCHEMA_VERSION) {
      await this.rebuild();
      return this.readIndexed(file);
    }
    const seen = new Set();
    const result = [];
    let count = 0;
    let digest = hash('');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let item;
      try { item = JSON.parse(line); }
      catch { await this.rebuild(); return this.readIndexed(file); }
      count += 1;
      digest = hash(digest + '\0' + line);
      const receipt = item.receipt || item;
      if (!seen.has(receipt.receiptId)) { seen.add(receipt.receiptId); result.push(receipt); }
    }
    if (meta.count !== count || meta.bytes !== Buffer.byteLength(raw, 'utf8') || meta.digest !== digest) {
      await this.rebuild();
      return this.readIndexed(file);
    }
    return result;
  }

  async idempotencyHistory({ connectionId, capability, idempotencyKey }) {
    if (!idempotencyKey) return [];
    await this.ensure();
    const key = [connectionId || '', capability || '', idempotencyKey].join('\0');
    const result = [];
    let pending = Buffer.alloc(0);
    const processLine = async (line) => {
      if (!line.trim()) return;
      let receipt;
      try { receipt = JSON.parse(line); }
      catch { await this.failCorrupt('Connections receipt log contains malformed data during idempotency history inspection'); }
      if (indexedKey(receipt) === key) result.push(receipt);
    };
    try {
      for await (const data of createReadStream(this.receiptsPath)) {
        const chunk = Buffer.concat([pending, data]);
        let start = 0;
        for (let i = 0; i < chunk.length; i += 1) {
          if (chunk[i] !== 10) continue;
          await processLine(chunk.subarray(start, i).toString('utf8'));
          start = i + 1;
        }
        pending = chunk.subarray(start);
      }
      if (pending.length) await processLine(pending.toString('utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return result;
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

  async unresolvedReceipts(connectionId, capability) {
    await this.ensure();
    if (!capability) return [];
    const file = this.unresolvedSummaryPath(connectionId, capability);
    try {
      const record = await readJson(file);
      return record?.receipt ? [{ ...record.receipt, providerEdgeEntered: record.edgeEntered }] : [];
    } catch {
      await this.rebuild();
      const record = await readJson(file);
      return record?.receipt ? [{ ...record.receipt, providerEdgeEntered: record.edgeEntered }] : [];
    }
  }

  serializeCurrent(entries) {
    const value = Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
    return { schemaVersion: SCHEMA_VERSION, entries: value, digest: hash(JSON.stringify(value)) };
  }

  async writeCurrentIdempotency(key, receipt) {
    const keyHash = hash(key);
    const bucket = keyHash.slice(0, 3);
    const file = path.join(this.idempotencyDir, bucket + '.json');
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    let current = new Map();
    if (this.catalogFiles?.has(relative)) {
      let record;
      try { record = await readJson(file); }
      catch { await this.rebuild(); return; }
      if (!record || record.schemaVersion !== SCHEMA_VERSION || !record.entries
        || record.digest !== hash(JSON.stringify(record.entries))) {
        await this.rebuild();
        return;
      }
      current = new Map(Object.entries(record.entries));
    } else {
      try {
        await fs.stat(file);
        await this.rebuild();
        return;
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    const previous = current.get(keyHash);
    current.set(keyHash, {
      receipt,
      executionId: receipt.executionId || previous?.executionId || null
    });
    await atomicJson(file, this.serializeCurrent(current));
    if (!this.catalogFiles.has(relative)) {
      this.catalogFiles.add(relative);
      await atomicJson(this.catalogPath, { schemaVersion: SCHEMA_VERSION, files: [...this.catalogFiles].sort() });
    }
  }

  async idempotencyLatest({ connectionId, capability, idempotencyKey }) {
    if (!idempotencyKey) return null;
    await this.ensure();
    const key = [connectionId || '', capability || '', idempotencyKey].join('\0');
    const keyHash = hash(key);
    const file = path.join(this.idempotencyDir, keyHash.slice(0, 3) + '.json');
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    if (!this.catalogFiles?.has(relative)) {
      try {
        await fs.stat(file);
        await this.rebuild();
        return this.idempotencyLatest({ connectionId, capability, idempotencyKey });
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return null;
      }
    }
    let record;
    try { record = await readJson(file); }
    catch { await this.rebuild(); return this.idempotencyLatest({ connectionId, capability, idempotencyKey }); }
    if (!record || record.schemaVersion !== SCHEMA_VERSION || !record.entries
      || record.digest !== hash(JSON.stringify(record.entries))) {
      await this.rebuild();
      return this.idempotencyLatest({ connectionId, capability, idempotencyKey });
    }
    return record.entries[keyHash] || null;
  }
}
