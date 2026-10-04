import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConnectionsService } from '../src/service.js';
import { tmpHome, startServer, readBody, readyService, approveGeneric, expectCode } from '../test-support/helpers.js';

test('lifecycle exposes install/setup/status/doctor/disable/enable/uninstall without purging canonical state', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  assert.equal((await service.status()).state, 'absent');
  await service.install();
  assert.equal((await service.status()).state, 'setup-required');
  await service.setup({ systemId: 'sys-a' });
  assert.equal((await service.status()).state, 'ready');
  assert.equal((await service.doctor()).doctor.ok, true);
  await service.disable();
  assert.equal((await service.status()).state, 'disabled');
  await service.enable();
  assert.equal((await service.status()).state, 'ready');
  await service.uninstall();
  assert.equal((await service.status()).state, 'absent');
  assert.ok(await fs.stat(home));
});

test('generic authenticated API path uses opaque vault handle and never persists raw secret in registry or receipts', async (t) => {
  let calls = 0;
  const server = await startServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'HEAD') {
      assert.equal(req.headers.authorization, 'Bearer super-secret-token');
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/v1/send' && req.method === 'POST') {
      calls++;
      assert.equal(req.headers.authorization, 'Bearer super-secret-token');
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, echo: body }));
      return;
    }
    res.writeHead(404).end();
  });
  t.after(server.close);

  const home = await tmpHome();
  const env = { AIVERSE_CONNECTIONS_MASTER_KEY: '0123456789abcdef0123456789abcdef' };
  const service = await readyService(home, env);
  const { credentialHandle } = await service.putCredential('api-token', 'super-secret-token');
  assert.equal(credentialHandle, 'vault:api-token');
  const cap = await approveGeneric(service, 'api', {
    baseUrl: server.url,
    credentialHandle,
    authorization: { type: 'bearer' }
  });
  const result = await service.execute('api', {
    capability: cap,
    systemId: 'sys-a', workspaceId: 'ws-a', actor: 'test', grantedCapabilities: [cap],
    approval: { approved: true }, idempotencyKey: 'send-1',
    input: { method: 'POST', path: '/v1/send', body: { hello: 'world' } }
  });
  assert.equal(result.trust, 'untrusted_external');
  assert.equal(result.data.data.echo.hello, 'world');
  assert.equal(calls, 1);
  const disk = [
    await fs.readFile(path.join(home, 'registry.json'), 'utf8'),
    await fs.readFile(path.join(home, 'receipts.ndjson'), 'utf8')
  ].join('\n');
  assert.equal(disk.includes('super-secret-token'), false);
  assert.equal(disk.includes('vault:api-token'), true);
});

test('system/workspace scope and final-edge revocation are enforced outside model reasoning', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    if (req.url === '/v1/x') return res.end(JSON.stringify({ ok: true }));
    res.writeHead(404).end();
  });
  t.after(server.close);
  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'scoped', { baseUrl: server.url, risk: 'read' });

  await expectCode(service.execute('scoped', {
    capability: cap, systemId: 'sys-b', workspaceId: 'ws-a', grantedCapabilities: [cap], input: { method: 'POST', path: '/v1/x' }
  }), 'SYSTEM_SCOPE_DENIED');
  await expectCode(service.execute('scoped', {
    capability: cap, systemId: 'sys-a', workspaceId: 'ws-b', grantedCapabilities: [cap], input: { method: 'POST', path: '/v1/x' }
  }), 'WORKSPACE_SCOPE_DENIED');

  service.hooks.beforeFinalEdge = async () => { await service.revoke('scoped'); };
  await expectCode(service.execute('scoped', {
    capability: cap, systemId: 'sys-a', workspaceId: 'ws-a', grantedCapabilities: [cap], idempotencyKey: 'revoked-edge', input: { method: 'POST', path: '/v1/x' }
  }), 'CONNECTION_UNHEALTHY');
});


test('malformed receipt history is reported by doctor and preserved without dropping its valid prefix', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  const valid = JSON.stringify({ receiptId: 'cxr-valid-prefix', outcome: 'success', connectionId: 'api', capability: 'send' });
  const raw = `${valid}\n{broken-json}\n${JSON.stringify({ receiptId: 'cxr-after-corruption', outcome: 'success' })}\n`;
  const receiptsPath = path.join(home, 'receipts.ndjson');
  await fs.writeFile(receiptsPath, raw, { mode: 0o600 });

  const inspected = await service.store.inspectReceiptLog();
  assert.equal(inspected.ok, false);
  assert.equal(inspected.receipts.length, 1);
  assert.equal(inspected.receipts[0].receiptId, 'cxr-valid-prefix');
  assert.equal(inspected.corruption.line, 2);
  assert.equal(inspected.corruption.validReceiptCount, 1);
  assert.equal(inspected.corruption.truncatedTail, false);

  const doctor = await service.doctor();
  assert.equal(doctor.doctor.ok, false);
  const integrity = doctor.doctor.checks.find((item) => item.name === 'receipt-log-integrity');
  const recovery = doctor.doctor.checks.find((item) => item.name === 'external-effect-recovery');
  assert.equal(integrity.ok, false);
  assert.equal(integrity.detail.line, 2);
  assert.equal(recovery.ok, false);
  assert.equal(recovery.detail.unresolved, 'unknown');

  await expectCode(service.store.readReceipts(), 'RECEIPT_LOG_CORRUPT');
  assert.equal(await fs.readFile(receiptsPath, 'utf8'), raw, 'inspection must not truncate or rewrite source evidence');
});

test('truncated final receipt line is identified as a tail and blocks receipt consumers', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  const valid = JSON.stringify({ receiptId: 'cxr-valid-prefix', outcome: 'success' });
  const raw = `${valid}\n{"receiptId":"cxr-truncated"`;
  await fs.writeFile(path.join(home, 'receipts.ndjson'), raw, { mode: 0o600 });

  const inspected = await service.store.inspectReceiptLog();
  assert.equal(inspected.ok, false);
  assert.equal(inspected.corruption.line, 2);
  assert.equal(inspected.corruption.validReceiptCount, 1);
  assert.equal(inspected.corruption.truncatedTail, true);
  await expectCode(service.store.findIdempotentReceipt({
    connectionId: 'api', capability: 'send', idempotencyKey: 'retry-after-crash'
  }), 'RECEIPT_LOG_CORRUPT');
  assert.equal(await fs.readFile(path.join(home, 'receipts.ndjson'), 'utf8'), raw);
});
