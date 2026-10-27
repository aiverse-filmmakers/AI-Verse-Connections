import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpHome, startServer, readyService, expectCode } from '../test-support/helpers.js';

// All keys and providers in this suite are synthetic, local loopback mocks.
// These requests neither reach the real providers nor create paid media.
test('raw Higgsfield-style key uses Authorization: Key without saving raw key in the registry or receipt', async (t) => {
  const key = 'synthetic-higgsfield-key-not-real';
  const seen = [];
  const server = await startServer((req, res) => {
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    if (req.url === '/health' && req.method === 'HEAD') return res.writeHead(204).end();
    if (req.url === '/v1/info' && req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, fake: true }));
    }
    res.writeHead(404).end();
  });
  t.after(server.close);
  const home = await tmpHome();
  const service = await readyService(home, { AIVERSE_CONNECTIONS_MASTER_KEY: 'synthetic-master-key-0123456789abcd' });
  const { credentialHandle } = await service.putCredential('higgsfield-local', key);
  const c = await service.addGeneric({
    id: 'hf', systemId: 'sys-a', workspaceIds: ['ws-a'], credentialHandle,
    authorization: { type: 'key' },
    config: { baseUrl: server.url, healthPath: '/health', healthMethod: 'HEAD',
      allowedMethods: ['GET'], allowedPathPrefixes: ['/v1'] },
    limits: { allowPrivateNetwork: true }, risk: 'read'
  });
  const verified = await service.verify('hf');
  assert.equal(verified.status.liveVerified, true);
  const cap = Object.keys(c.capabilities)[0];
  await service.admitCapability('hf', { sourceName: 'request', capability: cap, risk: 'read' });
  await service.approveConnection('hf');
  const result = await service.execute('hf', {
    systemId: 'sys-a', workspaceId: 'ws-a', actor: 'synthetic',
    capability: cap, grantedCapabilities: [cap],
    idempotencyKey: 'hf-synthetic-read', input: { method: 'GET', path: '/v1/info' }
  });
  assert.equal(result.trust, 'untrusted_external');
  assert.deepEqual(seen.map((r) => r.authorization), [`Key ${key}`, `Key ${key}`]);
  assert.equal(seen.length, 2);
  const persisted = (await Promise.all(['registry.json', 'receipts.ndjson']
    .map((name) => fs.readFile(path.join(home, name), 'utf8')))).join('\n');
  assert.equal(persisted.includes(key), false);
  assert.equal(persisted.includes(credentialHandle), true);
});

test('KIE credit probe is read-only and refuses provider errors hidden behind HTTP 200', async (t) => {
  let reply = { code: 200, msg: 'success', data: 0 };
  const seen = [];
  const server = await startServer((req, res) => {
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    if (req.method !== 'GET' || req.url !== '/api/v1/chat/credit') return res.writeHead(404).end();
    res.setHeader('content-type', 'application/json');
    res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
  t.after(server.close);
  const service = await readyService(await tmpHome(), { AIVERSE_CONNECTIONS_MASTER_KEY: 'synthetic-master-key-0123456789abcd' });
  const { credentialHandle } = await service.putCredential('kie-local', 'synthetic-kie-key-not-real');
  const c = await service.addGeneric({
    id: 'kie', systemId: 'sys-a', workspaceIds: ['ws-a'], credentialHandle,
    authorization: { type: 'bearer' },
    config: { baseUrl: server.url, allowedMethods: ['GET'], allowedPathPrefixes: ['/api/v1/chat/credit'],
      healthPath: '/api/v1/chat/credit', healthMethod: 'GET', healthCheck: 'kie-credit' },
    limits: { allowPrivateNetwork: true }, risk: 'read'
  });
  assert.equal((await service.verify('kie')).status.authorized, true);
  const cap = Object.keys(c.capabilities)[0];
  await service.admitCapability('kie', { sourceName: 'request', capability: cap, risk: 'read' });
  await service.approveConnection('kie');

  for (const [body, code] of [
    [{ code: 401, msg: 'bad key', data: null }, 'GENERIC_NOT_AUTHORIZED'],
    [{ code: 429, msg: 'throttled', data: null }, 'GENERIC_HEALTH_FAILED'],
    ['{invalid-json', 'GENERIC_HEALTH_FAILED'],
    [{ code: 200, msg: 'success', data: null }, 'GENERIC_HEALTH_FAILED']
  ]) {
    reply = body;
    await expectCode(service.verify('kie'), code);
    const state = (await service.listConnections()).find((x) => x.id === 'kie').status;
    assert.equal(state.liveVerified, false);
    assert.equal(state.healthy, false);
    assert.equal(state.authorized, false);
    assert.equal(state.approved, false);
  }
  assert.ok(seen.length >= 5);
  assert.ok(seen.every((x) => x.method === 'GET' && x.path === '/api/v1/chat/credit' &&
    x.authorization === 'Bearer synthetic-kie-key-not-real'));
});

test('KIE-specific response validation cannot silently fall back to an unrelated HEAD probe', async () => {
  const service = await readyService(await tmpHome());
  await expectCode(service.addGeneric({
    id: 'bad-kie', systemId: 'sys-a',
    config: { baseUrl: 'https://api.kie.ai', allowedMethods: ['GET'],
      allowedPathPrefixes: ['/api'], healthPath: '/health', healthMethod: 'HEAD',
      healthCheck: 'kie-credit' }
  }), 'GENERIC_HEALTH_CHECK_CONFIG_INVALID');
});

test('delayed verification cannot restore a revoked or replaced provider credential', async (t) => {
  for (const change of ['revoke', 'replace']) {
    let signalRequest;
    let releaseRequest;
    const started = new Promise((resolve) => { signalRequest = resolve; });
    const blocked = new Promise((resolve) => { releaseRequest = resolve; });
    let calls = 0;
    const server = await startServer(async (req, res) => {
      if (req.url !== '/health' || req.method !== 'HEAD') return res.writeHead(404).end();
      calls++;
      if (calls === 1) {
        signalRequest();
        await blocked;
      }
      res.writeHead(204).end();
    });
    t.after(server.close);
    const service = await readyService(await tmpHome(), {
      AIVERSE_CONNECTIONS_MASTER_KEY: 'synthetic-master-key-0123456789abcd'
    });
    const { credentialHandle } = await service.putCredential('old-' + change, 'synthetic-old-key');
    await service.addGeneric({
      id: 'race', systemId: 'sys-a', workspaceIds: ['ws-a'], credentialHandle,
      authorization: { type: 'bearer' },
      config: { baseUrl: server.url, healthPath: '/health', healthMethod: 'HEAD',
        allowedMethods: ['GET'], allowedPathPrefixes: ['/v1'] },
      limits: { allowPrivateNetwork: true }, risk: 'read'
    });
    const checking = service.verify('race');
    await started;
    if (change === 'revoke') {
      await service.revoke('race');
    } else {
      const next = await service.putCredential('new-' + change, 'synthetic-new-key');
      await service.reauth('race', next.credentialHandle);
    }
    releaseRequest();
    await expectCode(checking, 'CONNECTION_CHANGED_DURING_VERIFY');
    const state = (await service.listConnections()).find((c) => c.id === 'race').status;
    assert.equal(state.authorized, false);
    assert.equal(state.approved, false);
    if (change === 'revoke') {
      await expectCode(service.verify('race'), 'CONNECTION_REVOKED');
      const next = await service.putCredential('after-revoke', 'synthetic-reconnected-key');
      await service.reauth('race', next.credentialHandle);
    }
    // An explicit replacement/re-auth may now be verified with its own key.
    assert.equal((await service.verify('race')).status.authorized, true);
  }
});
