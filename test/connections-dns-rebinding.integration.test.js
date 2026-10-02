import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_LIMITS } from '../src/constants.js';
import { GenericApiAdapter } from '../src/providers/generic-api.js';
import { McpAdapter } from '../src/providers/mcp.js';
import { boundedFetch } from '../src/http.js';
import { ConnectionsError } from '../src/errors.js';

function expectConnectionCode(promise, code) {
  return assert.rejects(promise, (err) => err instanceof ConnectionsError && err.code === code);
}

function rebindingNetwork() {
  let resolverCalls = 0;
  let requestCalls = 0;
  let sends = 0;
  let pinnedAddress = null;
  let servername = null;
  let outboundHeaders = null;

  const resolver = async () => {
    resolverCalls++;
    if (resolverCalls === 1) return [{ address: '93.184.216.34', family: 4 }];
    return [{ address: '127.0.0.1', family: 4 }];
  };

  const request = (url, options) => {
    requestCalls++;
    servername = options.servername;
    outboundHeaders = options.headers;
    options.lookup(url.hostname, {}, (err, address) => {
      if (err) throw err;
      pinnedAddress = address;
    });

    const req = new EventEmitter();
    req.end = () => { sends++; };
    req.destroy = (err) => queueMicrotask(() => req.emit('error', err));

    queueMicrotask(async () => {
      const rebound = await resolver(url.hostname, { all: true, verbatim: true });
      const socket = new EventEmitter();
      socket.remoteAddress = rebound[0].address;
      socket.connecting = false;
      socket.authorized = true;
      req.emit('socket', socket);
      socket.emit('secureConnect');
    });

    return req;
  };

  return {
    network: { lookup: resolver, request },
    snapshot: () => ({ resolverCalls, requestCalls, sends, pinnedAddress, servername, outboundHeaders })
  };
}

test('WSA-2026-051 Generic API pins the admitted DNS address and sends no bearer credential to a rebound private socket', async () => {
  const attack = rebindingNetwork();
  const credentials = { resolve: async () => 'generic-super-secret' };
  const adapter = new GenericApiAdapter(credentials);
  adapter.network = attack.network;

  const connection = {
    config: {
      baseUrl: 'https://rebind.example',
      allowedMethods: ['POST'],
      allowedPathPrefixes: ['/v1']
    },
    authorization: { type: 'bearer' },
    credentialHandle: 'vault:generic'
  };

  await expectConnectionCode(adapter.execute(connection, {
    method: 'POST',
    path: '/v1/send',
    body: { hello: 'world' }
  }, DEFAULT_LIMITS), 'REMOTE_ADDRESS_MISMATCH');

  const state = attack.snapshot();
  assert.equal(state.resolverCalls, 2, 'test must model public policy lookup followed by private rebound answer');
  assert.equal(state.requestCalls, 1);
  assert.equal(state.pinnedAddress, '93.184.216.34');
  assert.equal(state.servername, 'rebind.example');
  assert.equal(state.outboundHeaders.authorization, 'Bearer generic-super-secret');
  assert.equal(state.sends, 0, 'request bytes, including Authorization, must not be sent to the rebound socket');
});

test('WSA-2026-051 MCP uses the same pinned transport and sends no bearer credential to a rebound private socket', async () => {
  const attack = rebindingNetwork();
  const credentials = { resolve: async () => 'mcp-super-secret' };
  const adapter = new McpAdapter(credentials);
  adapter.network = attack.network;

  const connection = {
    config: { url: 'https://rebind.example/mcp' },
    authorization: { type: 'bearer' },
    credentialHandle: 'vault:mcp'
  };

  await expectConnectionCode(
    adapter.rpc(connection, 'tools/call', { name: 'x', arguments: {} }, DEFAULT_LIMITS, 'x'),
    'REMOTE_ADDRESS_MISMATCH'
  );

  const state = attack.snapshot();
  assert.equal(state.resolverCalls, 2, 'test must model public policy lookup followed by private rebound answer');
  assert.equal(state.requestCalls, 1);
  assert.equal(state.pinnedAddress, '93.184.216.34');
  assert.equal(state.servername, 'rebind.example');
  assert.equal(state.outboundHeaders.authorization, 'Bearer mcp-super-secret');
  assert.equal(state.sends, 0, 'MCP request bytes, including Authorization, must not be sent to the rebound socket');
});

test('WSA-2026-051 rejects mixed public/private IPv4 and IPv6 DNS sets before transport creation', async () => {
  let requestCalls = 0;
  const request = () => {
    requestCalls++;
    throw new Error('transport must not be created for a forbidden DNS set');
  };

  await expectConnectionCode(boundedFetch(
    'https://mixed-v4.example/v1',
    { method: 'GET', headers: {} },
    DEFAULT_LIMITS,
    'https://mixed-v4.example',
    {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ],
      request
    }
  ), 'PRIVATE_NETWORK_FORBIDDEN');

  await expectConnectionCode(boundedFetch(
    'https://mixed-v6.example/v1',
    { method: 'GET', headers: {} },
    DEFAULT_LIMITS,
    'https://mixed-v6.example',
    {
      lookup: async () => [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '::1', family: 6 }
      ],
      request
    }
  ), 'PRIVATE_NETWORK_FORBIDDEN');

  assert.equal(requestCalls, 0);
});

test('WSA-2026-051 normalizes localhost hostname forms before private-network authorization', async () => {
  let lookupCalls = 0;
  const target = 'https://LOCALHOST./v1';
  await expectConnectionCode(boundedFetch(
    target,
    { method: 'GET', headers: {} },
    DEFAULT_LIMITS,
    new URL(target).origin,
    { lookup: async () => { lookupCalls++; return [{ address: '93.184.216.34', family: 4 }]; } }
  ), 'PRIVATE_NETWORK_FORBIDDEN');
  assert.equal(lookupCalls, 0);
});
