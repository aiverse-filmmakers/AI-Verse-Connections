import os from 'node:os';

const ACTIVE_EXECUTIONS_KEY = Symbol.for('ai-verse.connections.active-execution-tokens');
const activeExecutions = globalThis[ACTIVE_EXECUTIONS_KEY] || (globalThis[ACTIVE_EXECUTIONS_KEY] = new Set());

export function makeExecutionOwner(token) {
  return { token, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
}

export function markExecutionActive(token) { activeExecutions.add(token); }
export function markExecutionInactive(token) { activeExecutions.delete(token); }

export function executionOwnerLiveness(owner) {
  if (!owner || typeof owner.token !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.hostname !== 'string') return 'unknown';
  if (owner.hostname !== os.hostname()) return 'foreign-host';
  if (owner.pid === process.pid) return activeExecutions.has(owner.token) ? 'live' : 'dead';
  try { process.kill(owner.pid, 0); return 'live'; }
  catch (err) {
    if (err.code === 'ESRCH') return 'dead';
    if (err.code === 'EPERM') return 'live';
    return 'unknown';
  }
}

const TERMINAL = new Set([
  'success', 'provider-error', 'pre-provider-failure',
  'abandoned-pre-provider', 'external-reconciled-applied',
  'external-reconciled-not-applied'
]);

export function inspectExternalEffects(receipts) {
  const byExecution = new Map();
  const legacy = [];
  for (const receipt of receipts) {
    if (typeof receipt.executionId === 'string' && receipt.executionId) {
      const history = byExecution.get(receipt.executionId) || [];
      history.push(receipt);
      byExecution.set(receipt.executionId, history);
    } else if (receipt.idempotencyKey && ['pending', 'budget-reserved', 'failure'].includes(receipt.outcome)) {
      legacy.push(receipt);
    }
  }

  const unresolved = [];
  const abandonedBeforeEdge = [];
  const inProgress = [];
  for (const [executionId, history] of byExecution) {
    const latest = history.at(-1);
    if (TERMINAL.has(latest.outcome) && !(latest.outcome === 'failure' && latest.attemptedExternal === true)) continue;
    const edgeEntered = history.some((r) => r.providerEdgeEntered === true || r.outcome === 'external-unknown' || (r.outcome === 'failure' && r.attemptedExternal === true));
    const holder = latest.executionOwner || history.find((r) => r.executionOwner)?.executionOwner;
    const liveness = latest.executionActive === false ? 'dead' : executionOwnerLiveness(holder);
    const item = { executionId, receiptId: latest.receiptId, connectionId: latest.connectionId, capability: latest.capability, state: edgeEntered ? 'external-unknown' : 'abandoned-before-provider', liveness };
    if (liveness === 'live') inProgress.push(item);
    else if (edgeEntered || liveness !== 'dead') unresolved.push(item);
    else abandonedBeforeEdge.push(item);
  }
  for (const receipt of legacy) {
    if (TERMINAL.has(receipt.outcome) && !(receipt.outcome === 'failure' && receipt.attemptedExternal === true)) continue;
    unresolved.push({
      executionId: null,
      receiptId: receipt.receiptId,
      connectionId: receipt.connectionId,
      capability: receipt.capability,
      state: 'legacy-outcome-unverifiable',
      liveness: 'unknown'
    });
  }
  return { unresolved, abandonedBeforeEdge, inProgress };
}
