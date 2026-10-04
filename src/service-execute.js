import { TRUST_LABEL } from './constants.js';
import { assertComponentReady, assertConnectionUsable, assertWithinUsageBudget, effectiveLimits } from './policy.js';
import { fail } from './errors.js';
import { assertInstallationSystem } from './system-binding.js';
import { nowIso, randomId } from './util.js';
import { executionOwnerLiveness, inspectExternalEffects, makeExecutionOwner, markExecutionActive, markExecutionInactive } from './external-effect-state.js';

function idempotencyMatch(receipt, id, request) {
  return receipt.connectionId === id
    && receipt.capability === request.capability
    && receipt.idempotencyKey === request.idempotencyKey;
}

function executionHistory(receipts, executionId) {
  return receipts.filter((r) => r.executionId === executionId);
}

async function releaseBudgetReservation(store, receipt, resolution = 'not-attempted') {
  if (!receipt?.budgetReservationId) return;
  await store.appendReceipt({
    receiptId: randomId('cxq'),
    timestamp: nowIso(),
    connectionId: receipt.connectionId,
    capability: receipt.capability,
    idempotencyKey: receipt.idempotencyKey || null,
    executionId: receipt.executionId,
    budgetReservationId: receipt.budgetReservationId,
    outcome: 'budget-released',
    budgetReserved: false,
    budgetState: 'released',
    releaseReason: resolution,
    attemptedExternal: false
  });
}

async function terminalizePreProviderFailure(service, id, request, executionId, owner, err) {
  await service.store.withLock(async () => {
    const history = await service.store.executionHistory(executionId);
    if (history.some((r) => r.providerEdgeEntered === true || r.outcome === 'external-unknown')) return;
    const reservation = history.findLast((r) => r.budgetReserved === true && r.budgetReservationId);
    await releaseBudgetReservation(service.store, reservation, 'pre-provider-failure');
    await service.store.appendReceipt({
      receiptId: randomId('cxr'),
      timestamp: nowIso(),
      systemId: request.systemId,
      workspaceId: request.workspaceId || null,
      actor: request.actor || 'unknown',
      connectionId: id,
      capability: request.capability,
      idempotencyKey: request.idempotencyKey || null,
      executionId,
      executionOwner: owner,
      executionActive: false,
      outcome: 'failure',
      attemptedExternal: false,
      errorCode: err.code || 'ERROR',
      preProvider: true,
      trust: TRUST_LABEL
    });
  });
}

function unknownEffectFailure(receipt) {
  fail('IDEMPOTENCY_OUTCOME_UNKNOWN', 'A provider effect may have happened for this idempotency key; reconcile the recorded execution before retrying', {
    receiptId: receipt?.receiptId || null,
    executionId: receipt?.executionId || null
  });
}

function inProgressFailure(receipt) {
  fail('IDEMPOTENCY_IN_PROGRESS', 'An execution with this idempotency key is already in progress', {
    executionId: receipt?.executionId || null
  });
}

async function recordRecoveredUnknown(store, id, request, executionId, owner, latest) {
  const unknown = {
    receiptId: randomId('cxr'),
    timestamp: nowIso(),
    systemId: request.systemId || latest?.systemId || null,
    workspaceId: request.workspaceId || latest?.workspaceId || null,
    actor: request.actor || 'recovery',
    connectionId: id,
    capability: request.capability,
    idempotencyKey: request.idempotencyKey || latest?.idempotencyKey || null,
    executionId,
    executionOwner: owner || latest?.executionOwner || null,
    executionActive: false,
    outcome: 'external-unknown',
    providerEdgeEntered: true,
    attemptedExternal: true,
    budgetReservationId: latest?.budgetReservationId || null,
    recovered: true,
    trust: TRUST_LABEL
  };
  await store.appendReceipt(unknown);
  return unknown;
}

async function reserveExecution(service, id, request, executionId, owner) {
  return service.store.withLock(async () => {
    const all = request.idempotencyKey
      ? await service.store.idempotencyHistory({ connectionId: id, capability: request.capability, idempotencyKey: request.idempotencyKey })
      : await service.store.unresolvedReceipts(id, request.capability);
    if (request.idempotencyKey) {
      const prior = all.filter((r) => idempotencyMatch(r, id, request));
      const latest = prior.at(-1);
      if (latest?.outcome === 'success' || latest?.outcome === 'provider-error') return { terminal: latest };
      if (latest?.outcome === 'external-reconciled-applied') return { reconciledApplied: latest };
      if (latest?.outcome === 'failure' && latest.attemptedExternal !== true) return { terminalFailure: latest };
      if (latest?.outcome === 'pre-provider-failure') return { terminalFailure: latest };
      if (latest?.outcome === 'abandoned-pre-provider' || latest?.outcome === 'external-reconciled-not-applied') {
        // The previous operation was proven not to have crossed the provider edge.
      } else if (latest && ['pending', 'budget-reserved', 'external-unknown'].includes(latest.outcome)) {
        const currentExecutionId = latest.executionId || prior.findLast((r) => r.executionId)?.executionId;
        const history = currentExecutionId ? await service.store.executionHistory(currentExecutionId) : prior;
        const currentOwner = latest.executionOwner || history.findLast((r) => r.executionOwner)?.executionOwner;
        const crossedEdge = history.some((r) => r.providerEdgeEntered === true || r.outcome === 'external-unknown');
        const liveness = latest.executionActive === false ? 'dead' : executionOwnerLiveness(currentOwner);
        if (liveness === 'live') return { pending: latest };
        if (crossedEdge || liveness !== 'dead' || !currentExecutionId) {
          const unknown = latest.outcome === 'external-unknown' && latest.executionActive === false
            ? latest
            : await recordRecoveredUnknown(service.store, id, request, currentExecutionId || randomId('cxe'), currentOwner, latest);
          return { unknown };
        }
        const budget = history.findLast((r) => r.budgetReserved === true && r.budgetReservationId);
        await releaseBudgetReservation(service.store, budget, 'crashed-before-provider-edge');
        await service.store.appendReceipt({
          receiptId: randomId('cxr'),
          timestamp: nowIso(),
          connectionId: id,
          capability: request.capability,
          idempotencyKey: request.idempotencyKey,
          executionId: currentExecutionId,
          executionOwner: currentOwner,
          executionActive: false,
          outcome: 'abandoned-pre-provider',
          attemptedExternal: false,
          recovered: true
        });
      } else if (latest?.outcome === 'failure' && latest.attemptedExternal === true) {
        return { unknown: await recordRecoveredUnknown(service.store, id, request, latest.executionId || randomId('cxe'), latest.executionOwner, latest) };
      }
    } else {
      const effectState = inspectExternalEffects(all);
      const pending = effectState.inProgress.find((r) => r.connectionId === id && r.capability === request.capability);
      if (pending) return { pending };
      const unresolved = effectState.unresolved.find((r) => r.connectionId === id && r.capability === request.capability);
      if (unresolved) return { unknown: unresolved };
    }

    const hold = {
      receiptId: randomId('cxp'),
      timestamp: nowIso(),
      systemId: request.systemId,
      workspaceId: request.workspaceId || null,
      actor: request.actor || 'unknown',
      connectionId: id,
      capability: request.capability,
      idempotencyKey: request.idempotencyKey || null,
      executionId,
      executionOwner: owner,
      executionActive: true,
      outcome: 'pending',
      attemptedExternal: false
    };
    await service.store.appendReceipt(hold);
    markExecutionActive(executionId);
    return { hold };
  });
}

export async function execute(id, request) {
  const executionId = randomId('cxe');
  const owner = makeExecutionOwner(executionId);
  let active = false;
  try {
    const lifecycle = await this.store.getLifecycle();
    assertComponentReady(lifecycle);

    const initial = await this.getBoundConnection(id);
    const initialCap = assertConnectionUsable(initial, request);
    const reservationResult = await reserveExecution(this, id, request, executionId, owner);
    if (reservationResult.hold) active = true;
    if (reservationResult.terminal) {
      return { deduplicated: true, receipt: reservationResult.terminal, result: reservationResult.terminal.resultSummary };
    }
    if (reservationResult.reconciledApplied) unknownEffectFailure(reservationResult.reconciledApplied);
    if (reservationResult.terminalFailure) {
      fail('IDEMPOTENCY_TERMINAL_FAILURE', 'This idempotency key already reached a failure outcome; review its receipt before using a new key', {
        receiptId: reservationResult.terminalFailure.receiptId,
        errorCode: reservationResult.terminalFailure.errorCode
      });
    }
    if (reservationResult.unknown) unknownEffectFailure(reservationResult.unknown);
    if (reservationResult.pending) inProgressFailure(reservationResult.pending);

    try {
      if (this.hooks.beforeFinalEdge) await this.hooks.beforeFinalEdge({ connection: initial, request });
    } catch (err) {
      await terminalizePreProviderFailure(this, id, request, executionId, owner, err);
      throw err;
    }

    let edge;
    try {
      edge = await this.store.withLock(async () => {
        const currentLifecycle = await this.store.getLifecycle();
        assertComponentReady(currentLifecycle);
        const registry = await this.store.getRegistry();
        const current = registry.connections[id];
        if (!current) fail('CONNECTION_NOT_FOUND', 'Connection ' + id + ' not found');
        assertInstallationSystem(currentLifecycle, current.systemId, { subject: 'Connection ' + id });
        const capability = assertConnectionUsable(current, request);
        if (capability.fingerprint !== initialCap.fingerprint || capability.risk !== initialCap.risk) {
          fail('AUTHORITY_CHANGED', 'Connection authority changed between plan and execution edge');
        }
        const adapter = this.adapters[current.provider];
        if (!adapter) fail('PROVIDER_UNSUPPORTED', 'Provider ' + current.provider + ' is unsupported');
        const currentLimits = effectiveLimits(current);
        const currentReceipts = await this.store.budgetReceipts(id);
        assertWithinUsageBudget(currentReceipts, current, currentLimits);
        const budgetReservationId = randomId('cxb');
        const common = {
          systemId: request.systemId,
          workspaceId: request.workspaceId || null,
          actor: request.actor || 'unknown',
          connectionId: id,
          provider: current.provider,
          capability: request.capability,
          idempotencyKey: request.idempotencyKey || null,
          executionId,
          executionOwner: owner
        };
        await this.store.appendReceipt({
          receiptId: randomId('cxq'),
          timestamp: nowIso(),
          ...common,
          outcome: 'budget-reserved',
          budgetReserved: true,
          budgetReservationId,
          attemptedExternal: false
        });
        if (this.hooks.afterBudgetReservation) await this.hooks.afterBudgetReservation({ executionId, budgetReservationId });
        const edgeReceipt = {
          receiptId: randomId('cxu'),
          timestamp: nowIso(),
          ...common,
          outcome: 'external-unknown',
          executionActive: true,
          providerEdgeEntered: true,
          attemptedExternal: true,
          budgetReservationId,
          trust: TRUST_LABEL
        };
        await this.store.appendReceipt(edgeReceipt);
        return {
          current: structuredClone(current),
          capability: structuredClone(capability),
          limits: currentLimits,
          adapter,
          budgetReservationId,
          edgeReceipt
        };
      });
    } catch (err) {
      await terminalizePreProviderFailure(this, id, request, executionId, owner, err);
      throw err;
    }

    const { current, capability, adapter, budgetReservationId, edgeReceipt } = edge;
    const startedAt = nowIso();
    try {
      if (this.hooks.afterProviderEdge) await this.hooks.afterProviderEdge({ connection: current, request, executionId, receipt: edgeReceipt });
      const raw = await adapter.execute(current, request.input || {}, edge.limits, capability);
      if (this.hooks.afterProviderResponse) await this.hooks.afterProviderResponse({ connection: current, request, executionId, response: raw });
      const receipt = {
        receiptId: randomId('cxr'),
        timestamp: nowIso(),
        startedAt,
        systemId: request.systemId,
        workspaceId: request.workspaceId || null,
        actor: request.actor || 'unknown',
        connectionId: id,
        provider: current.provider,
        capability: request.capability,
        sourceName: capability.sourceName,
        risk: capability.risk,
        approval: capability.risk === 'read' ? 'not-required' : 'explicit',
        idempotencyKey: request.idempotencyKey || null,
        executionId,
        executionOwner: owner,
        executionActive: false,
        outcome: raw.ok === false ? 'provider-error' : 'success',
        attemptedExternal: true,
        budgetReservationId,
        budgetState: 'terminal',
        externalStatus: raw.status ?? null,
        provenance: {
          externalCanonical: true,
          connectionOrigin: current.provider === 'mcp' ? current.mcp?.origin : new URL(current.config.baseUrl).origin
        },
        trust: TRUST_LABEL,
        securitySignals: raw.securitySignals || { suspicious: false, patterns: [] },
        resultSummary: { ok: raw.ok !== false, status: raw.status ?? null, trust: TRUST_LABEL }
      };
      await this.store.withLock(async () => {
        await this.store.appendReceipt(receipt);
      });
      return {
        deduplicated: false,
        trust: TRUST_LABEL,
        provenance: receipt.provenance,
        securitySignals: receipt.securitySignals,
        data: raw,
        receipt
      };
    } catch (err) {
      if (err.code === 'MCP_NOT_AUTHORIZED') {
        await this.store.mutateRegistry((r) => {
          const c = r.connections[id];
          if (c) c.status = { ...c.status, authorized: false, approved: false, healthy: false, lastError: 'needs_reauth' };
        });
      }
      const unknown = {
        receiptId: randomId('cxu'),
        timestamp: nowIso(),
        startedAt,
        systemId: request.systemId,
        workspaceId: request.workspaceId || null,
        actor: request.actor || 'unknown',
        connectionId: id,
        provider: current.provider,
        capability: request.capability,
        idempotencyKey: request.idempotencyKey || null,
        executionId,
        executionOwner: owner,
        executionActive: false,
        outcome: 'external-unknown',
        providerEdgeEntered: true,
        attemptedExternal: true,
        budgetReservationId,
        budgetState: 'terminal',
        providerEffectState: 'unknown',
        errorCode: err.code || 'ERROR',
        trust: TRUST_LABEL
      };
      await this.store.withLock(() => this.store.appendReceipt(unknown));
      throw err;
    }
  } finally {
    if (active) markExecutionInactive(executionId);
  }
}

export async function reconcileExternalEffect(id, request) {
  if (request.operatorConfirmed !== true) fail('RECONCILIATION_CONFIRMATION_REQUIRED', 'Reconciliation requires explicit local operator confirmation');
  if (!['applied', 'not-applied'].includes(request.resolution)) fail('INVALID_RECONCILIATION', 'Resolution must be applied or not-applied');
  if (!request.executionId) fail('EXECUTION_ID_REQUIRED', 'An execution id from doctor output is required');
  const note = String(request.note || '').trim();
  if (note.length < 8 || note.length > 500) fail('RECONCILIATION_NOTE_REQUIRED', 'Provide a non-secret reconciliation note between 8 and 500 characters');

  return this.store.withLock(async () => {
    const history = await this.store.executionHistory(request.executionId);
    const latest = history.at(-1);
    if (!latest || latest.connectionId !== id) fail('EXECUTION_NOT_FOUND', 'Unknown execution id for this connection');
    if (!['external-unknown', 'provider-edge-entered'].includes(latest.outcome)
      && !(latest.outcome === 'failure' && latest.attemptedExternal === true)) {
      fail('EXECUTION_NOT_RECONCILABLE', 'Execution is not in an unresolved provider-effect state', { outcome: latest.outcome });
    }
    if (latest.executionActive === true && executionOwnerLiveness(latest.executionOwner) === 'live') {
      fail('EXECUTION_STILL_ACTIVE', 'The provider execution is still active; reconcile only after it exits');
    }
    if (latest.executionActive === true && executionOwnerLiveness(latest.executionOwner) !== 'dead') {
      fail('EXECUTION_OWNER_UNVERIFIABLE', 'Cannot prove the provider execution has stopped');
    }
    if (request.resolution === 'not-applied') {
      await releaseBudgetReservation(this.store, latest, 'operator-reconciled-not-applied');
    }
    const receipt = {
      receiptId: randomId('cxr'),
      timestamp: nowIso(),
      connectionId: id,
      capability: latest.capability,
      idempotencyKey: latest.idempotencyKey || null,
      executionId: request.executionId,
      executionOwner: latest.executionOwner || null,
      executionActive: false,
      outcome: request.resolution === 'applied' ? 'external-reconciled-applied' : 'external-reconciled-not-applied',
      attemptedExternal: request.resolution === 'applied',
      budgetReservationId: latest.budgetReservationId || null,
      operatorConfirmed: true,
      actor: request.actor || 'cli-operator',
      reconciliationNote: note,
      trust: TRUST_LABEL
    };
    await this.store.appendReceipt(receipt);
    return receipt;
  });
}
