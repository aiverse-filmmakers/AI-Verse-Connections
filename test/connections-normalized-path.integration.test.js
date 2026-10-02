import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome, startServer, readyService, approveGeneric, expectCode } from '../test-support/helpers.js';

test('WSA-2026-033 rejects path-confusion forms before Generic API fetch and authorizes the normalized pathname', async (t) => {
  let externalCalls = 0;
  const seen = [];
  const server = await startServer((req, res) => {
    if (req.url === '/health' && req.method === 'HEAD') return res.writeHead(204).end();
    externalCalls++;
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  t.after(server.close);

  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'paths', {
    baseUrl: server.url,
    allowedPathPrefixes: ['/v1'],
    risk: 'read'
  });

  const request = (path, key) => service.execute('paths', {
    capability: cap,
    systemId: 'sys-a',
    workspaceId: 'ws-a',
    grantedCapabilities: [cap],
    idempotencyKey: key,
    input: { method: 'POST', path }
  });

  const confused = [
    ['/v1/../admin', 'plain-dotdot'],
    ['/v1/./admin', 'plain-dot'],
    ['/v1/%2e%2e/admin', 'encoded-dotdot'],
    ['/v1/%2E%2e/admin', 'mixed-case-dotdot'],
    ['/v1/.%2e/admin', 'mixed-dotdot'],
    ['/v1/%2fadmin', 'encoded-slash'],
    ['/v1/%2Fadmin', 'encoded-slash-upper'],
    ['/v1/%5cadmin', 'encoded-backslash'],
    ['/v1/%5Cadmin', 'encoded-backslash-upper'],
    ['/v1\\..\\admin', 'raw-backslash'],
    ['/v1/%252e%252e/admin', 'double-encoded-dotdot'],
    ['/v1/%252fadmin', 'double-encoded-slash']
  ];

  for (const [path, key] of confused) {
    await expectCode(request(path, key), 'PATH_CONFUSION_FORBIDDEN');
  }

  await expectCode(request('/v10/admin', 'prefix-boundary'), 'PATH_NOT_ALLOWED');
  assert.equal(externalCalls, 0);

  const allowed = await request('/v1/item?next=%2e%2e%2Fadmin&mode=query-only', 'query-only');
  assert.equal(allowed.data.status, 200);
  assert.equal(externalCalls, 1);
  assert.equal(seen[0], '/v1/item?next=%2e%2e%2Fadmin&mode=query-only');
});

test('WSA-2026-033 canonicalizes admitted prefixes and rejects ambiguous prefix configuration', async () => {
  const home = await tmpHome();
  const service = await readyService(home);

  const base = {
    systemId: 'sys-a',
    workspaceIds: ['ws-a'],
    credentialHandle: 'none',
    authorization: { type: 'none' },
    limits: { allowPrivateNetwork: true },
    risk: 'read'
  };

  await expectCode(service.addGeneric({
    ...base,
    id: 'bad-dot-prefix',
    config: {
      baseUrl: 'https://example.com',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/v1/%2e%2e/admin'],
      healthPath: '/',
      healthMethod: 'HEAD'
    }
  }), 'PATH_CONFUSION_FORBIDDEN');

  await expectCode(service.addGeneric({
    ...base,
    id: 'bad-separator-prefix',
    config: {
      baseUrl: 'https://example.com',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/v1/%2Fadmin'],
      healthPath: '/',
      healthMethod: 'HEAD'
    }
  }), 'PATH_CONFUSION_FORBIDDEN');

  await expectCode(service.addGeneric({
    ...base,
    id: 'bad-query-prefix',
    config: {
      baseUrl: 'https://example.com',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/v1?scope=admin'],
      healthPath: '/',
      healthMethod: 'HEAD'
    }
  }), 'INVALID_PATH_PREFIX');
});

test('WSA-2026-033 rechecks the normalized outbound pathname after request construction and before fetch', async (t) => {
  let externalCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health' && req.method === 'HEAD') return res.writeHead(204).end();
    externalCalls++;
    res.end('{}');
  });
  t.after(server.close);

  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'final-path', {
    baseUrl: server.url,
    allowedPathPrefixes: ['/v1'],
    risk: 'read'
  });

  const adapter = service.adapters['generic-api'];
  const originalAuthHeaders = adapter.authHeaders.bind(adapter);
  adapter.authHeaders = async (connection) => {
    connection.config.allowedPathPrefixes = ['/other'];
    return originalAuthHeaders(connection);
  };

  await expectCode(service.execute('final-path', {
    capability: cap,
    systemId: 'sys-a',
    workspaceId: 'ws-a',
    grantedCapabilities: [cap],
    idempotencyKey: 'final-path-recheck',
    input: { method: 'POST', path: '/v1/allowed-before-final-check' }
  }), 'PATH_NOT_ALLOWED');

  assert.equal(externalCalls, 0);
});
