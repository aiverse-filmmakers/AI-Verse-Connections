import { boundedFetch } from '../http.js';
import { fail } from '../errors.js';
import { cleanHeaderName, detectInstructionLikeContent, normalizeBaseUrl, normalizeOrigin } from '../util.js';
import { assertGenericTargetPathAllowed, assertNormalizedPathAllowed, canonicalizeAllowedPathPrefixes, canonicalizeGenericRequestTarget } from '../path-policy.js';

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'proxy-authenticate', 'upgrade']);

export class GenericApiAdapter {
  constructor(credentials) { this.credentials = credentials; this.network = undefined; }

  validateConfig(connection) {
    const baseUrl = normalizeBaseUrl(connection.config.baseUrl);
    const origin = normalizeOrigin(baseUrl);
    const methods = (connection.config.allowedMethods || ['GET']).map((m) => String(m).toUpperCase());
    const rawPrefixes = connection.config.allowedPathPrefixes || ['/'];
    if (!methods.length || !rawPrefixes.length) fail('GENERIC_POLICY_REQUIRED', 'Generic API connections require allowed methods and path prefixes');
    const prefixes = canonicalizeAllowedPathPrefixes(rawPrefixes);
    const healthCheck = connection.config.healthCheck;
    if (healthCheck !== undefined && healthCheck !== 'kie-credit') {
      fail('GENERIC_HEALTH_CHECK_UNSUPPORTED', 'Unsupported generic API response check');
    }
    if (healthCheck === 'kie-credit' &&
        (connection.config.healthPath !== '/api/v1/chat/credit' ||
         String(connection.config.healthMethod || 'HEAD').toUpperCase() !== 'GET')) {
      fail('GENERIC_HEALTH_CHECK_CONFIG_INVALID', 'KIE credit verification requires the documented GET credit endpoint');
    }
    return { baseUrl, origin, methods, prefixes };
  }

  async authHeaders(connection) {
    const auth = connection.authorization || { type: 'none' };
    if (auth.type === 'none') return {};
    const secret = await this.credentials.resolve(connection.credentialHandle);
    if (auth.type === 'bearer') return { Authorization: `Bearer ${secret}` };
    if (auth.type === 'key') return { Authorization: `Key ${secret}` };
    if (auth.type === 'header') return { [cleanHeaderName(auth.headerName)]: secret };
    fail('AUTH_TYPE_UNSUPPORTED', `Unsupported generic API auth type: ${auth.type}`);
  }

  buildRequest(connection, input) {
    const { baseUrl, origin, methods, prefixes } = this.validateConfig(connection);
    const method = String(input.method || 'GET').toUpperCase();
    if (!methods.includes(method)) fail('METHOD_NOT_ALLOWED', `Method ${method} is not permitted by this connection`);
    const path = String(input.path || '/');
    const target = canonicalizeGenericRequestTarget(path, baseUrl, origin);
    assertNormalizedPathAllowed(target.pathname, prefixes);
    const headers = {};
    for (const [k, v] of Object.entries(input.headers || {})) {
      const name = cleanHeaderName(k);
      if (HOP_BY_HOP.has(name.toLowerCase()) || /authorization|cookie|x-api-key/i.test(name)) fail('CALLER_CREDENTIAL_HEADER_FORBIDDEN', `Caller cannot inject sensitive transport header ${name}`);
      headers[name] = String(v);
    }
    let body;
    if (input.body !== undefined) {
      body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    }
    return { method, target: target.toString(), origin, headers, body };
  }

  async verify(connection, limits) {
    const { baseUrl, origin } = this.validateConfig(connection);
    const authHeaders = await this.authHeaders(connection);
    const healthPath = connection.config.healthPath || '/';
    const healthMethod = String(connection.config.healthMethod || 'HEAD').toUpperCase();
    if (!['HEAD', 'GET'].includes(healthMethod)) fail('INVALID_HEALTH_METHOD', 'Generic API health method must be HEAD or GET');
    const target = new URL(healthPath, `${baseUrl}/`);
    if (target.origin !== origin) fail('ORIGIN_MISMATCH', 'Health probe must remain on the registered origin');
    const { response, buffer } = await boundedFetch(target.toString(), { method: healthMethod, headers: { ...authHeaders, Accept: 'application/json, text/plain;q=0.9, */*;q=0.1' } }, limits, origin, this.network);
    if (response.status === 401 || response.status === 403) fail('GENERIC_NOT_AUTHORIZED', `Generic API health probe rejected authorization with ${response.status}`);
    if (!response.ok) fail('GENERIC_HEALTH_FAILED', `Generic API health probe returned HTTP ${response.status}`);
    if (connection.config.healthCheck === 'kie-credit') {
      let body;
      try { body = JSON.parse(buffer.toString('utf8')); }
      catch { fail('GENERIC_HEALTH_FAILED', 'KIE credit check did not return valid JSON'); }
      // KIE reports some API errors as HTTP 200; a successful HTTP response is not proof of authorization.
      if (body?.code === 401 || body?.code === 403) {
        fail('GENERIC_NOT_AUTHORIZED', 'KIE credit check rejected the key');
      }
      if (body?.code !== 200 || typeof body.data !== 'number' ||
          !Number.isFinite(body.data) || body.data < 0) {
        fail('GENERIC_HEALTH_FAILED', 'KIE credit check did not confirm account access');
      }
      // Zero credits still proves key access, not funding or generation readiness.
    }
    return { authorized: true, healthy: true, details: { mode: 'live-network-probe', status: response.status, method: healthMethod, path: healthPath } };
  }

  async execute(connection, input, limits) {
    const req = this.buildRequest(connection, input);
    const authHeaders = await this.authHeaders(connection);
    const { prefixes } = this.validateConfig(connection);
    assertGenericTargetPathAllowed(req.target, req.origin, prefixes);
    const { response, buffer } = await boundedFetch(req.target, {
      method: req.method,
      headers: { ...req.headers, ...authHeaders, Accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      body: req.body
    }, limits, req.origin, this.network);
    const type = response.headers.get('content-type') || '';
    let data = buffer.toString('utf8');
    if (type.includes('application/json')) {
      try { data = JSON.parse(data || 'null'); } catch { /* keep text */ }
    }
    const signals = detectInstructionLikeContent(data);
    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries([...response.headers].filter(([k]) => !/set-cookie|authorization/i.test(k))),
      data,
      securitySignals: signals
    };
  }
}
