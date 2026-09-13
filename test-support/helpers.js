import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConnectionsService, ConnectionsError } from '../src/index.js';

export async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aiverse-connections-'));
}

export async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function readBody(req) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;
  return body;
}

export async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => err instanceof ConnectionsError && err.code === code);
}

export async function readyService(home, env = {}) {
  const service = new ConnectionsService({ home, env });
  await service.install();
  await service.setup({ systemId: 'sys-a' });
  return service;
}

export async function approveGeneric(service, id = 'api', opts = {}) {
  const c = await service.addGeneric({
    id,
    systemId: 'sys-a',
    workspaceIds: opts.workspaceIds || ['ws-a'],
    credentialHandle: opts.credentialHandle || 'none',
    authorization: opts.authorization || { type: 'none' },
    config: {
      baseUrl: opts.baseUrl,
      allowedMethods: opts.allowedMethods || ['POST'],
      allowedPathPrefixes: opts.allowedPathPrefixes || ['/v1'],
      healthPath: opts.healthPath || '/health',
      healthMethod: 'HEAD'
    },
    limits: { allowPrivateNetwork: true, ...(opts.limits || {}) },
    risk: opts.risk || 'write'
  });
  await service.verify(id);
  const cap = Object.keys(c.capabilities)[0];
  await service.admitCapability(id, { sourceName: 'request', capability: cap, risk: opts.risk || 'write' });
  await service.approveConnection(id);
  return cap;
}

