import { TRUST_LABEL } from './constants.js';
import { assertConnectionUsable, assertWithinUsageBudget, effectiveLimits } from './policy.js';
import { fail } from './errors.js';
import { nowIso, randomId } from './util.js';

export async function execute(id, request) {
  const lifecycle = await this.store.getLifecycle();
  if (!lifecycle.installed || !lifecycle.setup || !lifecycle.enabled) fail('COMPONENT_NOT_READY', 'Connections component is not enabled and ready');
  const initial = await this.getBoundConnection(id);
  const initialCap = assertConnectionUsable(initial, request);
  const limits = effectiveLimits(initial);
  const receipts = await this.store.readReceipts();
  assertWithinUsageBudget(receipts, initial, limits);
  let reservation = null;
  if (request.idempotencyKey) {
    const reservationResult = await this.store.withLock(async () => {
      const all = await this.store.readReceipts();
      const latest = all.filter((r) => r.connectionId === id && r.capability === request.capability && r.idempotencyKey === request.idempotencyKey).at(-1);
      if (latest?.outcome === 'success' || latest?.outcome === 'provider-error') return { terminal: latest };
      if (latest?.outcome === 'failure') return { terminalFailure: latest };
      if (latest?.outcome === 'pending') return { pending: latest };
      const hold = { receiptId: randomId('cxp'), timestamp: nowIso(), connectionId: id, capability: request.capability, idempotencyKey: request.idempotencyKey, outcome: 'pending', attemptedExternal: false };
      await this.store.appendReceipt(hold);
      return { hold };
    });
    if (reservationResult.terminal) return { deduplicated: true, receipt: reservationResult.terminal, result: reservationResult.terminal.resultSummary };
    if (reservationResult.terminalFailure) fail('IDEMPOTENCY_TERMINAL_FAILURE', 'This idempotency key already reached a failure outcome; use a new key after reviewing the prior receipt', { receiptId: reservationResult.terminalFailure.receiptId, errorCode: reservationResult.terminalFailure.errorCode });
    if (reservationResult.pending) fail('IDEMPOTENCY_IN_PROGRESS', 'An execution with this idempotency key is already in progress');
    reservation = reservationResult.hold;
  }
  if (this.hooks.beforeFinalEdge) await this.hooks.beforeFinalEdge({ connection: initial, request });

  // Mandatory final-edge authority re-check. Any revocation or narrowing after planning wins here.
  const current = await this.getBoundConnection(id);
  const capability = assertConnectionUsable(current, request);
  if (capability.fingerprint !== initialCap.fingerprint || capability.risk !== initialCap.risk) fail('AUTHORITY_CHANGED', 'Connection authority changed between plan and execution edge');
  const adapter = this.adapters[current.provider];
  if (!adapter) fail('PROVIDER_UNSUPPORTED', `Provider ${current.provider} is unsupported`);
  const startedAt = nowIso();
  try {
    const raw = await adapter.execute(current, request.input || {}, effectiveLimits(current), capability);
    const receipt = {
      receiptId: randomId('cxr'), timestamp: nowIso(), startedAt,
      systemId: request.systemId, workspaceId: request.workspaceId || null,
      actor: request.actor || 'unknown', connectionId: id, provider: current.provider,
      capability: request.capability, sourceName: capability.sourceName, risk: capability.risk,
      approval: capability.risk === 'read' ? 'not-required' : 'explicit',
      idempotencyKey: request.idempotencyKey || null,
      outcome: raw.ok === false ? 'provider-error' : 'success', attemptedExternal: true,
      externalStatus: raw.status ?? null,
      provenance: { externalCanonical: true, connectionOrigin: current.provider === 'mcp' ? current.mcp?.origin : new URL(current.config.baseUrl).origin },
      trust: TRUST_LABEL,
      securitySignals: raw.securitySignals || { suspicious: false, patterns: [] },
      resultSummary: { ok: raw.ok !== false, status: raw.status ?? null, trust: TRUST_LABEL }
    };
    await this.store.withLock(async () => {
      const duplicate = await this.store.findIdempotentReceipt({ connectionId: id, capability: request.capability, idempotencyKey: request.idempotencyKey });
      if (duplicate) return;
      await this.store.appendReceipt(receipt);
    });
    return { deduplicated: false, trust: TRUST_LABEL, provenance: receipt.provenance, securitySignals: receipt.securitySignals, data: raw, receipt };
  } catch (err) {
    if (err.code === 'MCP_NOT_AUTHORIZED') {
      await this.store.mutateRegistry((r) => {
        const c = r.connections[id];
        if (c) c.status = { ...c.status, authorized: false, approved: false, healthy: false, lastError: 'needs_reauth' };
      });
    }
    const receipt = {
      receiptId: randomId('cxr'), timestamp: nowIso(), startedAt,
      systemId: request.systemId, workspaceId: request.workspaceId || null, actor: request.actor || 'unknown',
      connectionId: id, provider: current.provider, capability: request.capability, idempotencyKey: request.idempotencyKey || null,
      outcome: 'failure', attemptedExternal: true, errorCode: err.code || 'ERROR', errorMessage: err.message, trust: TRUST_LABEL
    };
    await this.store.withLock(() => this.store.appendReceipt(receipt));
    throw err;
  }
}
