import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_ID, VERSION } from './constants.js';
import { fail } from './errors.js';

export async function install() {
  await this.store.ensureHome();
  return this.store.setLifecycle({ installed: true, installedVersion: VERSION, enabled: false });
}


export async function setup({ systemId }) {
  if (!systemId) fail('SYSTEM_ID_REQUIRED', 'setup requires an explicit system id');
  const lifecycle = await this.store.getLifecycle();
  if (!lifecycle.installed) fail('INSTALL_REQUIRED', 'Install Connections before setup');
  await this.store.getRegistry();
  return this.store.setLifecycle({ setup: true, enabled: true, systemId });
}


export async function status() {
  const lifecycle = await this.store.getLifecycle();
  let state = 'absent';
  if (lifecycle.installed) state = lifecycle.setup ? (lifecycle.enabled ? 'ready' : 'disabled') : 'setup-required';
  const registry = await this.store.getRegistry();
  const counts = { total: 0, configured: 0, liveVerified: 0, healthy: 0, authorized: 0, approved: 0 };
  for (const c of Object.values(registry.connections)) {
    counts.total++;
    for (const k of ['configured', 'liveVerified', 'healthy', 'authorized', 'approved']) if (c.status?.[k]) counts[k]++;
  }
  return { componentId: COMPONENT_ID, version: VERSION, state, lifecycle, connections: counts };
}


export async function doctor() {
  const status = await this.status();
  const checks = [];
  checks.push({ depth: 'structural', name: 'installed-state', ok: status.lifecycle.installed });
  checks.push({ depth: 'attachment/discovery', name: 'setup', ok: status.lifecycle.setup, detail: status.lifecycle.systemId });
  const registry = await this.store.getRegistry();
  for (const c of Object.values(registry.connections)) {
    const credential = await this.credentials.probe(c.credentialHandle || 'none');
    checks.push({ depth: 'dependency', connectionId: c.id, name: 'credential-handle', ok: credential.available, backend: credential.backend, error: credential.error });
    checks.push({ depth: 'runtime', connectionId: c.id, name: 'last-live-verification', ok: !!c.status?.liveVerified, at: c.status?.lastVerifiedAt || null });
    checks.push({ depth: 'operational', connectionId: c.id, name: 'connection-health', ok: !!c.status?.healthy && !!c.status?.authorized, error: c.status?.lastError || null });
  }
  const ok = checks.every((c) => c.ok) && status.state === 'ready';
  return { ...status, doctor: { ok, depthChecked: ['structural', 'attachment/discovery', 'runtime', 'dependency', 'operational'], checks } };
}


export async function enable() { return this.store.setLifecycle({ enabled: true }); }

export async function disable() { return this.store.setLifecycle({ enabled: false }); }

export async function update() {
  const lifecycle = await this.store.getLifecycle();
  if (!lifecycle.installed) fail('INSTALL_REQUIRED', 'Connections is not installed');
  return { updated: false, managedExternally: true, currentVersion: VERSION, message: 'Software updates are owned by AI-Verse Distribution/package management; canonical Connections state is not migrated implicitly.' };
}


export async function uninstall({ purge = false } = {}) {
  if (purge) { await this.store.purgeAll(); return { uninstalled: true, purged: true }; }
  const state = await this.store.setLifecycle({ installed: false, setup: false, enabled: false });
  return { uninstalled: true, purged: false, statePreserved: true, lifecycle: state };
}


export async function putCredential(id, secret) { return { credentialHandle: await this.credentials.putVault(id, secret) }; }

export async function deleteCredential(handle) { await this.credentials.delete(handle); return { deleted: true, handle }; }

export async function componentDescriptor() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'component.json');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return { componentId: COMPONENT_ID, version: VERSION, lifecycleCommands: ['install','setup','status','doctor','enable','disable','update','uninstall'] }; }
}
