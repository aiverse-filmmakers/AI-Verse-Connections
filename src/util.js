import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
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

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] === 0 || p[0] >= 224;
}

function isPrivateIpv6(ip) {
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
}

export function isPrivateIp(ip) {
  return net.isIPv4(ip) ? isPrivateIpv4(ip) : net.isIPv6(ip) ? isPrivateIpv6(ip) : false;
}

export async function assertNetworkTargetAllowed(urlString, { allowPrivateNetwork = false } = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' && !allowPrivateNetwork) {
    fail('HTTPS_REQUIRED', 'External connections require HTTPS unless private-network access was explicitly enabled');
  }
  const host = url.hostname;
  if (host === 'localhost' && !allowPrivateNetwork) fail('PRIVATE_NETWORK_FORBIDDEN', 'Local/private network targets are disabled by default');
  if (net.isIP(host)) {
    if (isPrivateIp(host) && !allowPrivateNetwork) fail('PRIVATE_NETWORK_FORBIDDEN', `Private/reserved IP target is not allowed: ${host}`);
    return;
  }
  let resolved;
  try { resolved = await dns.lookup(host, { all: true, verbatim: true }); }
  catch (err) { fail('DNS_LOOKUP_FAILED', `DNS lookup failed for ${host}`, { cause: err.message }); }
  if (!allowPrivateNetwork && resolved.some((r) => isPrivateIp(r.address))) {
    fail('PRIVATE_NETWORK_FORBIDDEN', `DNS for ${host} resolved to a private/reserved address`);
  }
}

export function cleanHeaderName(name) {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) fail('INVALID_HEADER_NAME', `Invalid header name: ${name}`);
  return name;
}

export function sanitizeMetadataText(value, max = 4000) {
  if (value == null) return undefined;
  const text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return text.slice(0, max);
}
