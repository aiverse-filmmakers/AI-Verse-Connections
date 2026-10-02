import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionsError } from '../src/errors.js';
import { tmpHome, startServer, readyService, approveGeneric, expectCode } from '../test-support/helpers.js';

function barrier(count) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async () => {
    arrived++;
    if (arrived === count) release();
    await gate;
  };
}

function request(capability, key) {
  return {
    capability,
    systemId: 'sys-a',
    workspaceId: 'ws-a',
    grantedCapabilities: [capability],
    idempotencyKey: key,
    input: { method: 'POST', path: '/v1/x' }
  };
}

async function assertLifecycleFence(action) {
  let externalCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    if (req.url === '/v1/x') {
      externalCalls++;
      return res.end('{}');
    }
    return res.writeHead(404).end();
  });

  try {
    const home = await tmpHome();
    const service = await readyService(home);
    const cap = await approveGeneric(service, 'lifecycle-edge', {
      baseUrl: server.url,
      risk: 'read'
    });

    service.hooks.beforeFinalEdge = async () => action(service);

    await expectCode(
      service.execute('lifecycle-edge', request(cap, `lifecycle-${action.name}`)),
      'COMPONENT_NOT_READY'
    );

    assert.equal(externalCalls, 0);

    const receipts = await service.store.readReceipts();
    const keyed = receipts.filter((r) => r.idempotencyKey === `lifecycle-${action.name}`);
    assert.equal(keyed[0]?.outcome, 'pending');
    assert.equal(keyed.at(-1)?.outcome, 'failure');
    assert.equal(keyed.at(-1)?.attemptedExternal, false);
    assert.equal(keyed.at(-1)?.preProvider, true);
    assert.equal(receipts.some((r) => r.budgetReserved === true), false);
  } finally {
    await server.close();
  }
}

async function disableComponent(service) {
  await service.disable();
}

async function uninstallComponent(service) {
  await service.uninstall();
}

test('WSA-2026-032 final edge re-reads component lifecycle after a concurrent disable', async () => {
  await assertLifecycleFence(disableComponent);
});

test('WSA-2026-032 final edge re-reads component lifecycle after a concurrent uninstall', async () => {
  await assertLifecycleFence(uninstallComponent);
});

async function runBudgetRace({ maxCallsPerMinute, maxCallsPerDay, expectedCode, prefix }) {
  let externalCalls = 0;
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    if (req.url === '/v1/x') {
      externalCalls++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return res.end('{}');
    }
    return res.writeHead(404).end();
  });

  try {
    const home = await tmpHome();
    const service = await readyService(home);
    const cap = await approveGeneric(service, `budget-${prefix}`, {
      baseUrl: server.url,
      risk: 'read',
      limits: { maxCallsPerMinute, maxCallsPerDay }
    });

    service.hooks.beforeFinalEdge = barrier(2);

    const firstKey = `${prefix}-a`;
    const secondKey = `${prefix}-b`;
    const settled = await Promise.allSettled([
      service.execute(`budget-${prefix}`, request(cap, firstKey)),
      service.execute(`budget-${prefix}`, request(cap, secondKey))
    ]);

    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter((result) => result.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason instanceof ConnectionsError, true);
    assert.equal(rejected[0].reason.code, expectedCode);
    assert.equal(externalCalls, 1);

    const receipts = await service.store.readReceipts();
    const reservations = receipts.filter((r) => r.budgetReserved === true);
    assert.equal(reservations.length, 1);

    const budgetId = reservations[0].budgetReservationId;
    assert.ok(budgetId);
    const terminal = receipts.filter((r) => r.budgetReservationId === budgetId && r.budgetState === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].outcome, 'success');
    assert.equal(terminal[0].attemptedExternal, true);

    const terminalFailures = receipts.filter((r) =>
      [firstKey, secondKey].includes(r.idempotencyKey)
      && r.outcome === 'failure'
      && r.preProvider === true
    );
    assert.equal(terminalFailures.length, 1);
    assert.equal(terminalFailures[0].attemptedExternal, false);

    const counted = receipts.filter((r) =>
      r.connectionId === `budget-${prefix}`
      && (r.budgetReserved === true || (r.attemptedExternal === true && !r.budgetReservationId))
    );
    assert.equal(counted.length, 1);
  } finally {
    await server.close();
  }
}

test('WSA-2026-032 atomically reserves maxCallsPerMinute across distinct idempotency keys', async () => {
  await runBudgetRace({
    maxCallsPerMinute: 1,
    maxCallsPerDay: 10,
    expectedCode: 'RATE_LIMIT_EXCEEDED',
    prefix: 'minute'
  });
});

test('WSA-2026-032 atomically reserves maxCallsPerDay across distinct idempotency keys', async () => {
  await runBudgetRace({
    maxCallsPerMinute: 10,
    maxCallsPerDay: 1,
    expectedCode: 'DAILY_BUDGET_EXCEEDED',
    prefix: 'day'
  });
});

test('WSA-2026-032 terminalizes a provider-edge budget reservation when the adapter fails', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    return res.writeHead(404).end();
  });
  t.after(server.close);

  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'provider-failure', {
    baseUrl: server.url,
    risk: 'read',
    limits: { maxCallsPerMinute: 1, maxCallsPerDay: 1 }
  });

  service.adapters['generic-api'].execute = async () => {
    throw new ConnectionsError('TEST_PROVIDER_FAILURE', 'deterministic provider-edge failure');
  };

  await expectCode(
    service.execute('provider-failure', request(cap, 'provider-failure-key')),
    'TEST_PROVIDER_FAILURE'
  );

  const receipts = await service.store.readReceipts();
  const reservation = receipts.find((r) => r.connectionId === 'provider-failure' && r.budgetReserved === true);
  assert.ok(reservation?.budgetReservationId);

  const terminal = receipts.find((r) =>
    r.budgetReservationId === reservation.budgetReservationId
    && r.budgetState === 'terminal'
  );
  assert.equal(terminal?.outcome, 'failure');
  assert.equal(terminal?.errorCode, 'TEST_PROVIDER_FAILURE');
  assert.equal(terminal?.attemptedExternal, true);

  await expectCode(
    service.execute('provider-failure', request(cap, 'provider-failure-key-2')),
    'RATE_LIMIT_EXCEEDED'
  );
});
