import crypto from 'node:crypto';
import { fail } from './errors.js';

function parseHandle(handle) {
  if (!handle || typeof handle !== 'string') fail('CREDENTIAL_HANDLE_REQUIRED', 'A credential handle is required');
  const idx = handle.indexOf(':');
  if (idx < 1) fail('INVALID_CREDENTIAL_HANDLE', 'Credential handles must use backend:id form');
  return { backend: handle.slice(0, idx), id: handle.slice(idx + 1) };
}

function deriveKey(master, salt) {
  return crypto.scryptSync(master, salt, 32);
}

export class CredentialManager {
  constructor(store, env = process.env) {
    this.store = store;
    this.env = env;
  }

  async resolve(handle) {
    if (!handle || handle === 'none') return null;
    const { backend, id } = parseHandle(handle);
    if (backend === 'env') {
      const value = this.env[id];
      if (!value) fail('CREDENTIAL_UNAVAILABLE', `Environment credential ${id} is not available`);
      return value;
    }
    if (backend === 'vault') return this.resolveVault(id);
    fail('CREDENTIAL_BACKEND_UNSUPPORTED', `Unsupported credential backend: ${backend}`);
  }

  async putVault(id, secret) {
    if (!id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) fail('INVALID_CREDENTIAL_ID', 'Credential id contains unsupported characters');
    if (!secret) fail('EMPTY_CREDENTIAL', 'Credential secret must not be empty');
    const master = this.env.AIVERSE_CONNECTIONS_MASTER_KEY;
    if (!master || master.length < 16) fail('MASTER_KEY_REQUIRED', 'AIVERSE_CONNECTIONS_MASTER_KEY must be set to at least 16 characters for the local encrypted vault');
    return this.store.withLock(async () => {
      const vault = await this.store.readJson(this.store.vaultPath, { schemaVersion: 1, entries: {} });
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = deriveKey(master, salt);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      vault.entries[id] = {
        algorithm: 'aes-256-gcm+scrypt',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: encrypted.toString('base64')
      };
      await this.store.atomicWriteJson(this.store.vaultPath, vault);
      return `vault:${id}`;
    });
  }

  async resolveVault(id) {
    const master = this.env.AIVERSE_CONNECTIONS_MASTER_KEY;
    if (!master || master.length < 16) fail('MASTER_KEY_REQUIRED', 'AIVERSE_CONNECTIONS_MASTER_KEY must be set to at least 16 characters for the local encrypted vault');
    const vault = await this.store.readJson(this.store.vaultPath, { schemaVersion: 1, entries: {} });
    const entry = vault.entries[id];
    if (!entry) fail('CREDENTIAL_UNAVAILABLE', `Vault credential ${id} does not exist`);
    try {
      const key = deriveKey(master, Buffer.from(entry.salt, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      fail('CREDENTIAL_DECRYPT_FAILED', `Could not decrypt vault credential ${id}`);
    }
  }

  async delete(handle) {
    const { backend, id } = parseHandle(handle);
    if (backend !== 'vault') fail('CREDENTIAL_DELETE_UNSUPPORTED', 'Only vault credentials are mutable through Connections');
    return this.store.withLock(async () => {
      const vault = await this.store.readJson(this.store.vaultPath, { schemaVersion: 1, entries: {} });
      delete vault.entries[id];
      await this.store.atomicWriteJson(this.store.vaultPath, vault);
    });
  }

  async probe(handle) {
    if (!handle || handle === 'none') return { available: true, backend: 'none' };
    const { backend } = parseHandle(handle);
    try { await this.resolve(handle); return { available: true, backend }; }
    catch (err) { return { available: false, backend, error: err.code || err.message }; }
  }
}
