import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConnectionsService } from '../src/service.js';
import { tmpHome, startServer, readBody, readyService, approveGeneric, expectCode } from '../test-support/helpers.js';

const childPath = fileURLToPath(new URL('../test-support/external-effect-child.js', import.meta.url));

function executionRequest(capability, idempotencyKey = 'crash-boundary-1') {
  return {
    capability,
    systemId: 'sys-a',
    workspaceId: 'ws-a',
    actor: 'wsa-055-test',
    grantedCapabilities: [capability],
    approval: { approved: true },
    idempotencyKey,
    input: { method: 'POST', path: '/v1/write', body: { value: 1 } }
  };
}

function startChild(home, mode, capability, providerUrl) {
  return fork(childPath, [home, mode, 'effect', capability, providerUrl], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
}

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for child ' + type)), 10000);
    child.on('message', (message) => {
      if (message?.type !== type) return;
      clearTimeout(timer);
      resolve(message);
    });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Child exited before ' + type + ' (code ' + code + ')'));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function crashAt(home, mode, capability, providerUrl, messageType) {
  const child = startChild(home, mode, capability, providerUrl);
  const message = await waitForMessage(child, messageType);
  if (mode === 'before-provider' || mode === 'after-budget-reservation') child.send({ crash: true });
  await waitForExit(child);
  assert.equal(child.exitCode, 97);
  return message;
}

async function setup(t, limits = {}) {
  let calls = 0;
  const server = await startServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'HEAD') return res.writeHead(204).end();
    if (req.url === '/v1/write' && req.method === 'POST') {
      calls++;
      await readBody(req);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ applied: true, calls }));
    }
    res.writeHead(404).end();
  });
  t.after(server.close);
  const home = await tmpHome();
  const service = await readyService(home);
  const capability = await approveGeneric(service, 'effect', {
    baseUrl: server.url,
    limits: { maxCallsPerMinute: 1, maxCallsPerDay: 10, ...limits }
  });
  return { home, service, capability, server, calls: () => calls };
}

test('crash before provider budget reservation safely recovers and reuses the same key', async (t) => {
  const ctx = await setup(t);
  await crashAt(ctx.home, 'before-provider', ctx.capability, ctx.server.url, 'reserved');
  const result = await ctx.service.execute('effect', executionRequest(ctx.capability));
  assert.equal(result.receipt.outcome, 'success');
  assert.equal(ctx.calls(), 1);
  const receipts = await ctx.service.store.readReceipts();
  assert.ok(receipts.some((r) => r.outcome === 'abandoned-pre-provider'));
});

test('crash after budget reservation releases unused capacity before safe retry', async (t) => {
  const ctx = await setup(t);
  await crashAt(ctx.home, 'after-budget-reservation', ctx.capability, ctx.server.url, 'budget-reserved');
  const result = await ctx.service.execute('effect', executionRequest(ctx.capability));
  assert.equal(result.receipt.outcome, 'success');
  assert.equal(ctx.calls(), 1);
  const receipts = await ctx.service.store.readReceipts();
  assert.ok(receipts.some((r) => r.outcome === 'budget-released' && r.releaseReason === 'crashed-before-provider-edge'));
});

test('provider-edge crash is unknown, budgeted, visible to doctor, and needs explicit not-applied reconciliation', async (t) => {
  const ctx = await setup(t);
  const edge = await crashAt(ctx.home, 'after-edge', ctx.capability, ctx.server.url, 'edge');
  assert.equal(ctx.calls(), 0);
  await expectCode(ctx.service.execute('effect', executionRequest(ctx.capability)), 'IDEMPOTENCY_OUTCOME_UNKNOWN');
  const doctor = await ctx.service.doctor();
  const recovery = doctor.doctor.checks.find((check) => check.name === 'external-effect-recovery');
  assert.equal(recovery.ok, false);
  assert.equal(recovery.detail.unresolved[0].executionId, edge.executionId);
  await expectCode(ctx.service.execute('effect', executionRequest(ctx.capability, 'different-key')), 'RATE_LIMIT_EXCEEDED');

  const reconciled = await ctx.service.reconcileExternalEffect('effect', {
    executionId: edge.executionId,
    resolution: 'not-applied',
    operatorConfirmed: true,
    actor: 'local-operator',
    note: 'Provider lookup confirms the request was not applied'
  });
  assert.equal(reconciled.outcome, 'external-reconciled-not-applied');
  const result = await ctx.service.execute('effect', executionRequest(ctx.capability));
  assert.equal(result.receipt.outcome, 'success');
  assert.equal(ctx.calls(), 1);
});

test('crash after provider response remains unknown and applied reconciliation prevents replay', async (t) => {
  const ctx = await setup(t);
  const response = await crashAt(ctx.home, 'after-provider-response', ctx.capability, ctx.server.url, 'provider-response');
  assert.equal(ctx.calls(), 1);
  await expectCode(ctx.service.execute('effect', executionRequest(ctx.capability)), 'IDEMPOTENCY_OUTCOME_UNKNOWN');
  await expectCode(ctx.service.execute('effect', executionRequest(ctx.capability, 'different-key')), 'RATE_LIMIT_EXCEEDED');
  const reconciled = await ctx.service.reconcileExternalEffect('effect', {
    executionId: response.executionId,
    resolution: 'applied',
    operatorConfirmed: true,
    actor: 'local-operator',
    note: 'Provider confirms the request was applied'
  });
  assert.equal(reconciled.outcome, 'external-reconciled-applied');
  await expectCode(ctx.service.execute('effect', executionRequest(ctx.capability)), 'IDEMPOTENCY_OUTCOME_UNKNOWN');
  assert.equal(ctx.calls(), 1);
});

test('reconciliation cannot be invoked without explicit local operator confirmation and evidence note', async (t) => {
  const ctx = await setup(t);
  const edge = await crashAt(ctx.home, 'after-edge', ctx.capability, ctx.server.url, 'edge');
  await expectCode(ctx.service.reconcileExternalEffect('effect', {
    executionId: edge.executionId, resolution: 'not-applied', operatorConfirmed: false,
    note: 'Provider lookup confirms no execution'
  }), 'RECONCILIATION_CONFIRMATION_REQUIRED');
  await expectCode(ctx.service.reconcileExternalEffect('effect', {
    executionId: edge.executionId, resolution: 'not-applied', operatorConfirmed: true,
    note: 'short'
  }), 'RECONCILIATION_NOTE_REQUIRED');
});
