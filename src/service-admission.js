import { fail } from './errors.js';
import { nowIso, sha256 } from './util.js';

export async function admitCapability(id, { sourceName, capability, risk = 'write' }) {
  if (!['read', 'write', 'admin'].includes(risk)) fail('INVALID_RISK', 'Risk must be read, write or admin');
  return this.store.mutateRegistry((r) => {
    const c = r.connections[id];
    if (!c) fail('CONNECTION_NOT_FOUND', `Connection ${id} not found`);
    const entry = Object.values(c.capabilities || {}).find((x) => x.sourceName === sourceName || x.capability === capability);
    if (!entry) fail('CAPABILITY_NOT_FOUND', `No discovered capability matches ${sourceName || capability}`);
    const oldKey = entry.capability;
    const newKey = capability || oldKey;
    if (newKey !== oldKey && c.capabilities[newKey]) fail('CAPABILITY_EXISTS', `Capability ${newKey} already exists`);
    delete c.capabilities[oldKey];
    entry.capability = newKey;
    entry.admitted = true;
    entry.reviewRequired = false;
    entry.risk = risk;
    c.capabilities[newKey] = entry;
    c.status.approved = false;
    c.updatedAt = nowIso();
    return structuredClone(entry);
  });
}


export async function approveConnection(id) {
  return this.store.mutateRegistry((r) => {
    const c = r.connections[id];
    if (!c) fail('CONNECTION_NOT_FOUND', `Connection ${id} not found`);
    if (!c.status.liveVerified || !c.status.healthy || !c.status.authorized) fail('VERIFY_REQUIRED', 'Connection must be live-verified, healthy and authorized before approval');
    const admitted = Object.values(c.capabilities || {}).filter((x) => x.admitted && !x.reviewRequired);
    if (!admitted.length) fail('NO_ADMITTED_CAPABILITIES', 'Admit at least one capability before approval');
    c.status.approved = true;
    c.approval = { approvedAt: nowIso(), capabilityFingerprint: sha256(admitted.map((x) => ({ capability: x.capability, fingerprint: x.fingerprint, risk: x.risk })).sort((a, b) => a.capability.localeCompare(b.capability))) };
    return structuredClone(c);
  });
}


export async function revoke(id) {
  return this.store.mutateRegistry((r) => {
    const c = r.connections[id];
    if (!c) fail('CONNECTION_NOT_FOUND', `Connection ${id} not found`);
    c.status = { ...c.status, authorized: false, approved: false, healthy: false, lastError: 'revoked' };
    c.revokedAt = nowIso();
    return structuredClone(c);
  });
}


export async function reauth(id, credentialHandle) {
  return this.store.mutateRegistry((r) => {
    const c = r.connections[id];
    if (!c) fail('CONNECTION_NOT_FOUND', `Connection ${id} not found`);
    c.credentialHandle = credentialHandle;
    c.status = { ...c.status, liveVerified: false, healthy: false, authorized: false, approved: false, lastError: null };
    c.reauthAt = nowIso();
    return structuredClone(c);
  });
}

