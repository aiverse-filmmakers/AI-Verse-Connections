import crypto from 'node:crypto';
import { fail } from './errors.js';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256(value) {
  const input = typeof value === 'string' ? value : stableStringify(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export function normalizeOrigin(input) {
  let url;
  try { url = new URL(input); } catch { fail('INVALID_URL', `Invalid URL: ${input}`); }
  if (!['https:', 'http:'].includes(url.protocol)) fail('UNSUPPORTED_SCHEME', 'Only http/https URLs are supported');
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.origin;
}

export function normalizeBaseUrl(input) {
  let url;
  try { url = new URL(input); } catch { fail('INVALID_URL', `Invalid URL: ${input}`); }
  if (!['https:', 'http:'].includes(url.protocol)) fail('UNSUPPORTED_SCHEME', 'Only http/https URLs are supported');
  if (url.username || url.password) fail('URL_CREDENTIALS_FORBIDDEN', 'Credentials must not be embedded in connection URLs');
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length <= 8 ? '[REDACTED]' : `${value.slice(0, 2)}…[REDACTED]`;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /secret|token|password|authorization|api[-_]?key|credential/i.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

export function byteLengthJson(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

export function detectInstructionLikeContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const patterns = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /system\s+prompt/i,
    /developer\s+message/i,
    /reveal\s+(the\s+)?secret/i,
    /send\s+.*credentials?/i,
    /<\/?system>/i,
    /do\s+not\s+tell\s+the\s+user/i
  ];
  const hits = patterns.filter((r) => r.test(text)).map((r) => r.source);
  return { suspicious: hits.length > 0, patterns: hits };
}

export { isPrivateIp, assertNetworkTargetAllowed } from './network-target.js';

export function cleanHeaderName(name) {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) fail('INVALID_HEADER_NAME', `Invalid header name: ${name}`);
  return name;
}

export function sanitizeMetadataText(value, max = 4000) {
  if (value == null) return undefined;
  const text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return text.slice(0, max);
}
