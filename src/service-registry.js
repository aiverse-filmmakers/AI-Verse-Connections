import { DEFAULT_LIMITS, MCP_PROTOCOL_VERSION } from './constants.js';
import { fail } from './errors.js';
import { effectiveLimits } from './policy.js';
import { nowIso, sha256 } from './util.js';

export function baseConnection({ id, provider, systemId, workspaceIds = [], credentialHandle = 'none', authorization = { type: 'none' }, config, limits = {} }) {
  if (!id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) fail('INVALID_CONNECTION_ID', 'Connection id must use letters, numbers, dot, underscore or dash');
  if (!systemId) fail('SYSTEM_ID_REQUIRED', 'Connection requires explicit system scope');
  return {
    schemaVersion: 1,
    id, provider, systemId,
    workspaceIds: [...new Set(workspaceIds)],
    enabled: true,
    credentialHandle,
    authorization,
    config,
    limits: { ...DEFAULT_LIMITS, ...limits },
    status: { configured: true, liveVerified: false, healthy: false, authorized: false, approved: false, lastVerifiedAt: null, lastError: null },
    capabilities: {},
    createdAt: nowIso(), updatedAt: nowIso()
  };
}


export async function addGeneric(opts) {
  const connection = this.baseConnection({ ...opts, provider: 'generic-api' });
  const adapter = this.adapters['generic-api'];
  adapter.validateConfig(connection);
  const capability = `generic.${connection.id}.request`;
  connection.capabilities[capability] = {
    capability, sourceKind: 'generic-api', sourceName: 'request', admitted: false, reviewRequired: false,
    risk: opts.risk || 'write', fingerprint: sha256(connection.config), metadataTrusted: true
  };
  await this.store.mutateRegistry((r) => {
    if (r.connections[connection.id]) fail('CONNECTION_EXISTS', `Connection ${connection.id} already exists`);
    r.connections[connection.id] = connection;
  });
  return connection;
}


export async function addMcp(opts) {
  const connection = this.baseConnection({ ...opts, provider: 'mcp' });
  this.adapters.mcp.validateConfig(connection);
  const origin = new URL(connection.config.url).origin;
  if (connection.authorization?.type === 'bearer') {
    const resource = connection.authorization.resource || connection.config.url;
    if (new URL(resource).origin !== origin) fail('MCP_RESOURCE_ORIGIN_MISMATCH', 'MCP bearer authorization resource must match the registered server origin');
    connection.authorization.resource = resource;
  }
  connection.mcp = { protocolVersion: MCP_PROTOCOL_VERSION, origin, serverIdentity: null, toolsFingerprint: null, resourcesFingerprint: null, resources: [] };
  await this.store.mutateRegistry((r) => {
    if (r.connections[connection.id]) fail('CONNECTION_EXISTS', `Connection ${connection.id} already exists`);
    if (connection.credentialHandle && connection.credentialHandle !== 'none') {
      const reused = Object.values(r.connections).find((c) => c.provider === 'mcp' && c.credentialHandle === connection.credentialHandle && c.mcp?.origin && c.mcp.origin !== origin);
      if (reused) fail('MCP_CREDENTIAL_REUSE_FORBIDDEN', 'The same MCP bearer credential handle cannot be reused across different server origins');
    }
    r.connections[connection.id] = connection;
  });
  return connection;
}


export async function getConnection(id) {
  const registry = await this.store.getRegistry();
  const c = registry.connections[id];
  if (!c) fail('CONNECTION_NOT_FOUND', `Connection ${id} not found`);
  return c;
}


export async function listConnections() {
  const registry = await this.store.getRegistry();
  return Object.values(registry.connections).map((c) => ({
    id: c.id, provider: c.provider, systemId: c.systemId, workspaceIds: c.workspaceIds,
    enabled: c.enabled, status: c.status, capabilities: Object.values(c.capabilities || {}).map(({ capability, sourceKind, sourceName, admitted, reviewRequired, risk }) => ({ capability, sourceKind, sourceName, admitted, reviewRequired, risk }))
  }));
}


export async function verify(id) {
  const initial = await this.getConnection(id);
  const adapter = this.adapters[initial.provider];
  if (!adapter) fail('PROVIDER_UNSUPPORTED', `Provider ${initial.provider} is unsupported`);
  let result;
  try { result = await adapter.verify(initial, effectiveLimits(initial)); }
  catch (err) {
    await this.store.mutateRegistry((r) => {
      const c = r.connections[id];
      if (c) c.status = { ...c.status, liveVerified: false, healthy: false, authorized: false, lastVerifiedAt: nowIso(), lastError: err.code || err.message };
    });
    throw err;
  }
  return this.store.mutateRegistry((r) => {
    const c = r.connections[id];
    c.status = { ...c.status, liveVerified: true, healthy: !!result.healthy, authorized: !!result.authorized, lastVerifiedAt: nowIso(), lastError: null };
    if (c.provider === 'mcp') {
      const previous = c.capabilities || {};
      const next = {};
      let permissionReviewRequired = false;
      for (const tool of result.tools) {
        const capability = previous[Object.keys(previous).find((k) => previous[k].sourceKind === 'mcp-tool' && previous[k].sourceName === tool.name)];
        const changed = capability && capability.fingerprint !== tool.fingerprint;
        const capName = capability?.capability || `mcp.${c.id}.tool.${tool.name}`;
        next[capName] = {
          capability: capName,
          sourceKind: 'mcp-tool', sourceName: tool.name,
          admitted: changed ? false : !!capability?.admitted,
          reviewRequired: changed || !!capability?.reviewRequired,
          risk: capability?.risk || 'write',
          fingerprint: tool.fingerprint,
          metadataTrusted: false,
          metadata: { description: tool.description, title: tool.title, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations, securitySignals: tool.securitySignals }
        };
        if (!capability || changed) permissionReviewRequired = true;
      }
      if (Object.values(previous).some((oldCap) => oldCap.sourceKind === 'mcp-tool' && !result.tools.some((t) => t.name === oldCap.sourceName))) permissionReviewRequired = true;
      c.capabilities = next;
      c.mcp = {
        ...c.mcp,
        protocolVersion: result.protocolVersion,
        origin: result.origin,
        serverIdentity: result.serverIdentity,
        instructions: result.instructions,
        instructionSignals: result.instructionSignals,
        toolsFingerprint: result.toolsFingerprint,
        resourcesFingerprint: result.resourcesFingerprint,
        resources: result.resources,
        lastCatalogVerifiedAt: nowIso()
      };
      if (permissionReviewRequired) c.status.approved = false;
    }
    c.updatedAt = nowIso();
    return structuredClone(c);
  });
}
