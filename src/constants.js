export const VERSION = '0.1.0-beta.1';
export const COMPONENT_ID = 'ai-verse-connections';
export const STATE_SCHEMA_VERSION = 1;
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const CLIENT_INFO = { name: 'ai-verse-connections', version: VERSION };
export const TRUST_LABEL = 'untrusted_external';
export const DEFAULT_LIMITS = Object.freeze({
  maxCallsPerMinute: 30,
  maxCallsPerDay: 1000,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  allowPrivateNetwork: false
});
