import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome, startServer, readyService, expectCode } from '../test-support/helpers.js';

function mcpOptions(id, url, credentialHandle) {
  return {
    id,
    systemId: 'sys-a',
    workspaceIds: ['ws-a'],
    credentialHandle,
    authorization: { type: 'bearer', resource: `${url}/mcp`, issuer: 'https://issuer.example' },
    config: { url: `${url}/mcp` },
    limits: { allowPrivateNetwork: true }
  };
}

test('WSA-2026-031 keeps MCP bearer credential handles bound to one origin across add, reauth and verify', async (t) => {
  let originBRequests = 0;
  const originA = await startServer((req, res) => res.writeHead(500).end());
  const originB = await startServer((req, res) => {
    originBRequests++;
    res.writeHead(500).end();
  });
  t.after(originA.close);
  t.after(originB.close);

  const home = await tmpHome();
  const service = await readyService(home, {
    A_TOKEN: 'origin-a-token',
    A_ROTATED: 'origin-a-rotated',
    B_TOKEN: 'origin-b-token'
  });

  await service.addMcp(mcpOptions('a-primary', originA.url, 'env:A_TOKEN'));
  await service.addMcp(mcpOptions('a-peer', originA.url, 'env:A_ROTATED'));

  await expectCode(
    service.addMcp(mcpOptions('b-conflict', originB.url, 'env:A_TOKEN')),
    'MCP_CREDENTIAL_REUSE_FORBIDDEN'
  );

  await service.addMcp(mcpOptions('b-primary', originB.url, 'env:B_TOKEN'));
  await expectCode(service.reauth('b-primary', 'env:A_TOKEN'), 'MCP_CREDENTIAL_REUSE_FORBIDDEN');
  assert.equal((await service.getConnection('b-primary')).credentialHandle, 'env:B_TOKEN');

  const rotated = await service.reauth('a-primary', 'env:A_ROTATED');
  assert.equal(rotated.credentialHandle, 'env:A_ROTATED');

  await service.addMcp(mcpOptions('a-missing', originA.url, 'env:MISSING_SHARED'));
  await service.store.mutateRegistry((registry) => {
    registry.connections['b-primary'].credentialHandle = 'env:MISSING_SHARED';
  });

  await expectCode(service.verify('b-primary'), 'MCP_CREDENTIAL_REUSE_FORBIDDEN');
  assert.equal(originBRequests, 0);
});
