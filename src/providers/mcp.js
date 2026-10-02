import { MCP_PROTOCOL_VERSION, CLIENT_INFO } from '../constants.js';
import { boundedFetch } from '../http.js';
import { fail } from '../errors.js';
import { detectInstructionLikeContent, normalizeBaseUrl, normalizeOrigin, sanitizeMetadataText, sha256 } from '../util.js';

const META_PROTOCOL = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

function requestMeta() {
  return {
    [META_PROTOCOL]: MCP_PROTOCOL_VERSION,
    [META_CLIENT_INFO]: CLIENT_INFO,
    [META_CLIENT_CAPS]: {}
  };
}

function normalizeTool(tool) {
  if (!tool || typeof tool.name !== 'string' || !tool.name) fail('MCP_INVALID_TOOL', 'MCP server returned a tool without a valid name');
  if (!tool.inputSchema || tool.inputSchema.type !== 'object') fail('MCP_INVALID_TOOL', `MCP tool ${tool.name} must have an object inputSchema`);
  const description = sanitizeMetadataText(tool.description, 8000);
  const descriptor = {
    name: tool.name,
    description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    title: sanitizeMetadataText(tool.title, 500)
  };
  return {
    ...descriptor,
    fingerprint: sha256(descriptor),
    securitySignals: detectInstructionLikeContent(description || '')
  };
}

export class McpAdapter {
  constructor(credentials) { this.credentials = credentials; this.network = undefined; }

  validateConfig(connection) {
    const url = normalizeBaseUrl(connection.config.url);
    const origin = normalizeOrigin(url);
    return { url, origin };
  }

  async authHeaders(connection) {
    const auth = connection.authorization || { type: 'none' };
    if (auth.type === 'none') return {};
    if (auth.type !== 'bearer') fail('MCP_AUTH_TYPE_UNSUPPORTED', 'MCP v1 supports no-auth or bearer-token handles');
    const token = await this.credentials.resolve(connection.credentialHandle);
    return { Authorization: `Bearer ${token}` };
  }

  async rpc(connection, method, params, limits, name) {
    const { url, origin } = this.validateConfig(connection);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
      ...(await this.authHeaders(connection))
    };
    const id = `aiverse-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = JSON.stringify({
      jsonrpc: '2.0', id, method,
      params: { ...(params || {}), _meta: requestMeta() }
    });
    const { response, buffer } = await boundedFetch(url, { method: 'POST', headers, body }, limits, origin, this.network);
    if (response.status === 401 || response.status === 403) fail('MCP_NOT_AUTHORIZED', `MCP server rejected authorization with ${response.status}`);
    if (!response.ok) fail('MCP_HTTP_ERROR', `MCP server returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) fail('MCP_SSE_RESPONSE_UNSUPPORTED', 'Connections v1 expects direct JSON responses for stateless MCP requests');
    let payload;
    try { payload = JSON.parse(buffer.toString('utf8')); }
    catch { fail('MCP_INVALID_JSON', 'MCP server returned invalid JSON'); }
    if (payload.id !== id) fail('MCP_ID_MISMATCH', 'MCP response id did not match request');
    if (payload.error) fail('MCP_RPC_ERROR', payload.error.message || 'MCP RPC error', { rpc: payload.error });
    return { result: payload.result || {}, meta: payload.result?._meta || payload._meta || {} };
  }

  async collectList(connection, method, field, limits) {
    const items = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const { result } = await this.rpc(connection, method, cursor ? { cursor } : {}, limits);
      if (!Array.isArray(result[field])) fail('MCP_INVALID_LIST', `${method} result missing ${field}`);
      items.push(...result[field]);
      cursor = result.nextCursor;
      if (!cursor) return { items, ttlMs: result.ttlMs, cacheScope: result.cacheScope };
    }
    fail('MCP_PAGINATION_LIMIT', `${method} exceeded the 10-page safety limit`);
  }

  async verify(connection, limits) {
    const discover = await this.rpc(connection, 'server/discover', {}, limits);
    const supportedVersions = discover.result.supportedVersions || [];
    if (!supportedVersions.includes(MCP_PROTOCOL_VERSION)) fail('MCP_VERSION_UNSUPPORTED', `Server does not advertise MCP ${MCP_PROTOCOL_VERSION}`);
    const serverInfo = discover.result?._meta?.[META_SERVER_INFO] || discover.meta?.[META_SERVER_INFO] || discover.result.serverInfo || null;
    const toolsResult = await this.collectList(connection, 'tools/list', 'tools', limits);
    const tools = toolsResult.items.map(normalizeTool).sort((a, b) => a.name.localeCompare(b.name));
    const resources = discover.result.capabilities?.resources
      ? (await this.collectList(connection, 'resources/list', 'resources', limits)).items.map((r) => ({
          uri: String(r.uri), name: sanitizeMetadataText(r.name, 500), mimeType: r.mimeType,
          fingerprint: sha256({ uri: r.uri, name: r.name, mimeType: r.mimeType })
        })).sort((a, b) => a.uri.localeCompare(b.uri))
      : [];
    return {
      authorized: true,
      healthy: true,
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverIdentity: serverInfo ? { selfReported: true, value: serverInfo } : { selfReported: true, value: null },
      origin: this.validateConfig(connection).origin,
      instructions: sanitizeMetadataText(discover.result.instructions, 8000),
      instructionSignals: detectInstructionLikeContent(discover.result.instructions || ''),
      tools,
      resources,
      toolsFingerprint: sha256(tools.map(({ fingerprint, name }) => ({ name, fingerprint }))),
      resourcesFingerprint: sha256(resources.map(({ uri, fingerprint }) => ({ uri, fingerprint })))
    };
  }

  async execute(connection, input, limits, capability) {
    if (capability.sourceKind !== 'mcp-tool') fail('CAPABILITY_ADAPTER_MISMATCH', 'Capability is not an MCP tool');
    const { result } = await this.rpc(connection, 'tools/call', { name: capability.sourceName, arguments: input.arguments || {} }, limits, capability.sourceName);
    return { ok: !result.isError, result, securitySignals: detectInstructionLikeContent(result) };
  }
}
