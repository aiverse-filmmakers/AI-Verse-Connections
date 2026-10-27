import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome, startServer, readyService, approveGeneric, expectCode } from '../test-support/helpers.js';

// The public ConnectionsService (not only its CLI) is an owner execution edge.
// Connection admission must never substitute for the *caller* capability lease.
test('admitted read capability requires an explicit delegated grant before the provider edge', async (t) => {
  let providerCalls = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/health' && req.method === 'HEAD') return res.writeHead(204).end();
    if (req.url === '/v1/data' && req.method === 'GET') {
      providerCalls++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ result: 'synthetic' }));
    }
    return res.writeHead(404).end();
  });
  t.after(server.close);

  const service = await readyService(await tmpHome());
  const cap = await approveGeneric(service, 'delegated-floor', {
    baseUrl: server.url, risk: 'read', allowedMethods: ['GET']
  });
  const request = {
    systemId: 'sys-a', workspaceId: 'ws-a', capability: cap,
    input: { method: 'GET', path: '/v1/data' }
  };
  for (const grants of [undefined, null, [], ['wrong.capability'], 'not-an-array']) {
    const supplied = grants === undefined ? {} : { grantedCapabilities: grants };
    await expectCode(service.execute('delegated-floor', {
      ...request, ...supplied, idempotencyKey: 'no-delegated-grant-' + String(grants)
    }), 'DELEGATED_AUTHORITY_DENIED');
    assert.equal(providerCalls, 0, 'rejected callers must not reach provider');
  }

  // Existing, explicitly authorized consumers remain unchanged.
  const accepted = await service.execute('delegated-floor', {
    ...request, grantedCapabilities: [cap], idempotencyKey: 'explicit-grant'
  });
  assert.equal(accepted.receipt.outcome, 'success');
  assert.equal(accepted.trust, 'untrusted_external');
  assert.equal(providerCalls, 1);
});
