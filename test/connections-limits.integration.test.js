import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionsService } from '../src/service.js';
import { tmpHome, startServer, readBody, readyService, approveGeneric, expectCode } from '../test-support/helpers.js';

test('rate budget counts attempted external calls and blocks before the next provider edge', async (t) => {
  let calls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health') return res.writeHead(204).end();
    if (req.url === '/v1/x') { calls++; return res.end('{}'); }
    res.writeHead(404).end();
  });
  t.after(server.close);
  const home = await tmpHome();
  const service = await readyService(home);
  const cap = await approveGeneric(service, 'budget', { baseUrl: server.url, risk: 'read', limits: { maxCallsPerMinute: 1, maxCallsPerDay: 2 } });
  await service.execute('budget', { capability: cap, systemId: 'sys-a', workspaceId: 'ws-a', grantedCapabilities: [cap], input: { method: 'POST', path: '/v1/x' } });
  await expectCode(service.execute('budget', { capability: cap, systemId: 'sys-a', workspaceId: 'ws-a', grantedCapabilities: [cap], input: { method: 'POST', path: '/v1/x' } }), 'RATE_LIMIT_EXCEEDED');
  assert.equal(calls, 1);
});

test('private-network targets are blocked by default', async () => {
  const home = await tmpHome();
  const service = await readyService(home);
  await service.addGeneric({
    id: 'private', systemId: 'sys-a', workspaceIds: [], credentialHandle: 'none', authorization: { type: 'none' },
    config: { baseUrl: 'http://127.0.0.1:9999', allowedMethods: ['GET'], allowedPathPrefixes: ['/'], healthPath: '/', healthMethod: 'HEAD' },
    limits: { allowPrivateNetwork: false }, risk: 'read'
  });
  await expectCode(service.verify('private'), 'HTTPS_REQUIRED');
});
