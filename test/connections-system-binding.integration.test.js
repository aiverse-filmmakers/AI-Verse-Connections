import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionsService } from '../src/service.js';
import { tmpHome, startServer, readyService, approveGeneric, expectCode } from '../test-support/helpers.js';

function genericOptions(baseUrl, systemId = 'sys-a') {
  return {
    id: 'api',
    systemId,
    workspaceIds: ['ws-a'],
    credentialHandle: 'none',
    authorization: { type: 'none' },
    config: {
      baseUrl,
      allowedMethods: ['POST'],
      allowedPathPrefixes: ['/v1'],
      healthPath: '/health',
      healthMethod: 'HEAD'
    },
    limits: { allowPrivateNetwork: true },
    risk: 'read'
  };
}

async function setConnectionSystem(service, id, systemId) {
  await service.store.mutateRegistry((registry) => {
    const connection = registry.connections[id];
    assert.ok(connection);
    connection.systemId = systemId;
  });
}

test('WSA-2026-030 connection creation cannot escape the setup system binding', async () => {
  const home = await tmpHome();
  const service = await readyService(home);

  await expectCode(service.addGeneric({
    ...genericOptions('https://api.example.test', 'sys-b'),
    id: 'generic-b'
  }), 'SYSTEM_BINDING_MISMATCH');

  await expectCode(service.addMcp({
    id: 'mcp-b',
    systemId: 'sys-b',
    workspaceIds: ['ws-a'],
    credentialHandle: 'none',
    authorization: { type: 'none' },
    config: { url: 'https://mcp.example.test/mcp' }
  }), 'SYSTEM_BINDING_MISMATCH');

  assert.deepEqual(await service.listConnections(), []);
});

test('WSA-2026-030 verify, admit and approve reject legacy foreign-system connection state', async (t) => {
  let healthCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health') {
      healthCalls++;
      return res.writeHead(204).end();
    }
    return res.writeHead(404).end();
  });
  t.after(server.close);

  const home = await tmpHome();
  const service = await readyService(home);
  const connection = await service.addGeneric(genericOptions(server.url));

  await setConnectionSystem(service, 'api', 'sys-b');
  await expectCode(service.verify('api'), 'SYSTEM_BINDING_MISMATCH');
  assert.equal(healthCalls, 0);

  await setConnectionSystem(service, 'api', 'sys-a');
  await service.verify('api');
  assert.equal(healthCalls, 1);

  await setConnectionSystem(service, 'api', 'sys-b');
  await expectCode(service.admitCapability('api', {
    sourceName: 'request',
    capability: connection.capabilities['generic.api.request'].capability,
    risk: 'read'
  }), 'SYSTEM_BINDING_MISMATCH');

  await setConnectionSystem(service, 'api', 'sys-a');
  await service.admitCapability('api', {
    sourceName: 'request',
    capability: 'generic.api.request',
    risk: 'read'
  });

  await setConnectionSystem(service, 'api', 'sys-b');
  await expectCode(service.approveConnection('api'), 'SYSTEM_BINDING_MISMATCH');

  const doctor = await service.doctor();
  assert.equal(doctor.doctor.ok, false);
  assert.equal(
    doctor.doctor.checks.some((check) => check.connectionId === 'api' && check.name === 'system-binding' && check.ok === false),
    true
  );
});

test('WSA-2026-030 execution rejects a foreign connection even when request matches that foreign system', async (t) => {
  let externalCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    if (req.url === '/v1/x') {
      externalCalls++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }
    return res.writeHead(404).end();
  });
  t.after(server.close);

  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'api', { baseUrl: server.url, risk: 'read' });

  await setConnectionSystem(service, 'api', 'sys-b');
  await expectCode(service.execute('api', {
    capability: cap,
    systemId: 'sys-b',
    workspaceId: 'ws-a',
    grantedCapabilities: [cap],
    input: { method: 'POST', path: '/v1/x' }
  }), 'SYSTEM_BINDING_MISMATCH');

  assert.equal(externalCalls, 0);
});

test('WSA-2026-030 provider edge re-reads lifecycle system binding after planning', async (t) => {
  let externalCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    if (req.url === '/v1/x') {
      externalCalls++;
      return res.end('{}');
    }
    return res.writeHead(404).end();
  });
  t.after(server.close);

  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'api', { baseUrl: server.url, risk: 'read' });

  service.hooks.beforeFinalEdge = async () => {
    await service.store.setLifecycle({ systemId: 'sys-b' });
  };

  await expectCode(service.execute('api', {
    capability: cap,
    systemId: 'sys-a',
    workspaceId: 'ws-a',
    grantedCapabilities: [cap],
    input: { method: 'POST', path: '/v1/x' }
  }), 'SYSTEM_BINDING_MISMATCH');

  assert.equal(externalCalls, 0);
});

test('WSA-2026-030 setup cannot silently rebind and explicit rebind forces fresh authority', async (t) => {
  let externalCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    if (req.url === '/v1/x') {
      externalCalls++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }
    return res.writeHead(404).end();
  });
  t.after(server.close);

  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'api', { baseUrl: server.url, risk: 'read' });

  await expectCode(service.setup({ systemId: 'sys-b' }), 'SYSTEM_REBIND_REQUIRED');
  assert.equal((await service.status()).lifecycle.systemId, 'sys-a');
  assert.equal((await service.getConnection('api')).systemId, 'sys-a');

  await expectCode(
    service.rebindSystem({ fromSystemId: 'sys-x', systemId: 'sys-b' }),
    'SYSTEM_REBIND_SOURCE_MISMATCH'
  );

  const rebound = await service.rebindSystem({ fromSystemId: 'sys-a', systemId: 'sys-b' });
  assert.equal(rebound.systemId, 'sys-b');
  assert.deepEqual(rebound.migratedConnectionIds, ['api']);
  assert.equal((await service.status()).lifecycle.systemId, 'sys-b');

  const migrated = await service.getConnection('api');
  assert.equal(migrated.systemId, 'sys-b');
  assert.equal(migrated.status.liveVerified, false);
  assert.equal(migrated.status.authorized, false);
  assert.equal(migrated.status.approved, false);
  assert.equal(migrated.capabilities[cap].admitted, false);
  assert.equal(migrated.capabilities[cap].reviewRequired, true);

  await service.verify('api');
  await service.admitCapability('api', { sourceName: 'request', capability: cap, risk: 'read' });
  await service.approveConnection('api');

  await expectCode(service.execute('api', {
    capability: cap,
    systemId: 'sys-a',
    workspaceId: 'ws-a',
    grantedCapabilities: [cap],
    input: { method: 'POST', path: '/v1/x' }
  }), 'SYSTEM_SCOPE_DENIED');

  const result = await service.execute('api', {
    capability: cap,
    systemId: 'sys-b',
    workspaceId: 'ws-a',
    grantedCapabilities: [cap],
    input: { method: 'POST', path: '/v1/x' }
  });
  assert.equal(result.data.ok, true);
  assert.equal(externalCalls, 1);
});

test('WSA-2026-030 explicit rebind refuses undeclared third-system registry state', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  await service.addGeneric({
    ...genericOptions('https://api.example.test'),
    id: 'foreign'
  });
  await setConnectionSystem(service, 'foreign', 'sys-c');

  await expectCode(
    service.rebindSystem({ fromSystemId: 'sys-a', systemId: 'sys-b' }),
    'SYSTEM_REBIND_FOREIGN_CONNECTION'
  );

  assert.equal((await service.status()).lifecycle.systemId, 'sys-a');
  assert.equal((await service.getConnection('foreign')).systemId, 'sys-c');
});
