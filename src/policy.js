import { DEFAULT_LIMITS } from './constants.js';
import { fail } from './errors.js';

export function effectiveLimits(connection) {
  return { ...DEFAULT_LIMITS, ...(connection.limits || {}) };
}

export function assertConnectionUsable(connection, request) {
  if (!connection) fail('CONNECTION_NOT_FOUND', 'Connection does not exist');
  if (!connection.enabled) fail('CONNECTION_DISABLED', 'Connection is disabled');
  const s = connection.status || {};
  if (!s.configured) fail('CONNECTION_NOT_CONFIGURED', 'Connection is not configured');
  if (!s.liveVerified) fail('CONNECTION_NOT_LIVE_VERIFIED', 'Connection has not been live verified');
  if (!s.healthy) fail('CONNECTION_UNHEALTHY', 'Connection is not healthy');
  if (!s.authorized) fail('CONNECTION_NOT_AUTHORIZED', 'Connection is not currently authorized');
  if (!s.approved) fail('CONNECTION_NOT_APPROVED', 'Connection capabilities require explicit approval');
  if (!request.systemId || request.systemId !== connection.systemId) fail('SYSTEM_SCOPE_DENIED', 'Connection system scope does not match caller');
  const workspaces = connection.workspaceIds || [];
  if (workspaces.length > 0 && (!request.workspaceId || !workspaces.includes(request.workspaceId))) {
    fail('WORKSPACE_SCOPE_DENIED', 'Connection is not granted to this workspace');
  }
  const cap = connection.capabilities?.[request.capability];
  if (!cap || !cap.admitted) fail('CAPABILITY_NOT_ADMITTED', `Capability ${request.capability} is not admitted`);
  if (cap.reviewRequired) fail('CAPABILITY_REVIEW_REQUIRED', `Capability ${request.capability} changed and requires permission review`);
  if (request.grantedCapabilities && !request.grantedCapabilities.includes(request.capability)) {
    fail('DELEGATED_AUTHORITY_DENIED', 'Caller capability lease does not include this capability');
  }
  if (cap.risk !== 'read' && !request.approval?.approved) fail('ACTION_APPROVAL_REQUIRED', 'This external side effect requires an explicit approval at execution time');
  return cap;
}

export function assertWithinUsageBudget(receipts, connection, limits, now = Date.now()) {
  const relevant = receipts.filter((r) => r.connectionId === connection.id && r.attemptedExternal === true);
  const minute = relevant.filter((r) => now - Date.parse(r.timestamp) < 60_000).length;
  const day = relevant.filter((r) => now - Date.parse(r.timestamp) < 86_400_000).length;
  if (minute >= limits.maxCallsPerMinute) fail('RATE_LIMIT_EXCEEDED', 'Connection per-minute call budget exceeded');
  if (day >= limits.maxCallsPerDay) fail('DAILY_BUDGET_EXCEEDED', 'Connection daily call budget exceeded');
}
