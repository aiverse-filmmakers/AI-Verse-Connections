import dns from 'node:dns/promises';
import net from 'node:net';
import { ConnectionsError, fail } from './errors.js';

const IPV6_RESERVED = new net.BlockList();
IPV6_RESERVED.addSubnet('::', 128, 'ipv6');
IPV6_RESERVED.addSubnet('::1', 128, 'ipv6');
IPV6_RESERVED.addSubnet('100::', 64, 'ipv6');
IPV6_RESERVED.addSubnet('2001:db8::', 32, 'ipv6');
IPV6_RESERVED.addSubnet('fc00::', 7, 'ipv6');
IPV6_RESERVED.addSubnet('fe80::', 10, 'ipv6');
IPV6_RESERVED.addSubnet('ff00::', 8, 'ipv6');

function ipv4Number(ip) {
  return ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function inIpv4Subnet(ip, base, prefix) {
  const value = ipv4Number(ip);
  const network = ipv4Number(base);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function isPrivateIpv4(ip) {
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ].some(([base, prefix]) => inIpv4Subnet(ip, base, prefix));
}

function normalizeIpLiteral(value) {
  let address = String(value || '').trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : address.toLowerCase();
}

export function normalizeNetworkHostname(value) {
  let hostname = String(value || '').trim().toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (!hostname) fail('INVALID_NETWORK_HOST', 'External connection hostname is empty');
  return hostname;
}

export function isPrivateIp(value) {
  const ip = normalizeIpLiteral(value);
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return IPV6_RESERVED.check(ip, 'ipv6');
  return false;
}

function validateResolvedAddress(entry) {
  const address = normalizeIpLiteral(entry?.address);
  const family = net.isIP(address);
  if (!family) fail('DNS_INVALID_ADDRESS', `DNS returned a non-IP address: ${entry?.address}`);
  if (entry?.family && Number(entry.family) !== family) {
    fail('DNS_INVALID_ADDRESS', `DNS family mismatch for ${address}`);
  }
  return { address, family };
}

export async function resolveNetworkTarget(urlString, { allowPrivateNetwork = false } = {}, lookup = dns.lookup) {
  let url;
  try { url = new URL(urlString); }
  catch { fail('INVALID_URL', `Invalid URL: ${urlString}`); }

  if (!['https:', 'http:'].includes(url.protocol)) fail('UNSUPPORTED_SCHEME', 'Only http/https URLs are supported');
  if (url.protocol !== 'https:' && !allowPrivateNetwork) {
    fail('HTTPS_REQUIRED', 'External connections require HTTPS unless private-network access was explicitly enabled');
  }

  const hostname = normalizeNetworkHostname(url.hostname);
  if (!allowPrivateNetwork && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    fail('PRIVATE_NETWORK_FORBIDDEN', 'Local/private network targets are disabled by default');
  }

  const literalFamily = net.isIP(hostname);
  let resolved;
  if (literalFamily) {
    resolved = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      resolved = await lookup(hostname, { all: true, verbatim: true });
    } catch (err) {
      fail('DNS_LOOKUP_FAILED', `DNS lookup failed for ${hostname}`, { cause: err?.message });
    }
  }

  if (!Array.isArray(resolved) || resolved.length === 0) {
    fail('DNS_LOOKUP_EMPTY', `DNS returned no addresses for ${hostname}`);
  }

  const addresses = [];
  const seen = new Set();
  for (const entry of resolved) {
    const validated = validateResolvedAddress(entry);
    const key = `${validated.family}:${validated.address}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push(validated);
    }
  }

  if (!allowPrivateNetwork) {
    const forbidden = addresses.find(({ address }) => isPrivateIp(address));
    if (forbidden) {
      fail('PRIVATE_NETWORK_FORBIDDEN', `DNS for ${hostname} resolved to a private/reserved address: ${forbidden.address}`);
    }
  }

  return {
    origin: url.origin,
    hostname,
    addresses,
    pinned: addresses[0]
  };
}

export async function assertNetworkTargetAllowed(urlString, limits = {}, lookup = dns.lookup) {
  return resolveNetworkTarget(urlString, limits, lookup);
}

export function normalizeRemoteAddress(value) {
  return normalizeIpLiteral(value);
}

export function assertRemoteAddressApproved(remoteAddress, approvedAddresses) {
  const normalized = normalizeRemoteAddress(remoteAddress);
  const approved = approvedAddresses.some(({ address }) => normalizeRemoteAddress(address) === normalized);
  if (!normalized || !net.isIP(normalized) || !approved) {
    throw new ConnectionsError(
      'REMOTE_ADDRESS_MISMATCH',
      `Connected remote address ${remoteAddress || '(unknown)'} is outside the DNS-approved address set`,
      { remoteAddress: remoteAddress || null, approvedAddresses: approvedAddresses.map(({ address }) => address) }
    );
  }
  return normalized;
}

export function createPinnedLookup(expectedHostname, pinned) {
  const expected = normalizeNetworkHostname(expectedHostname);
  const selected = validateResolvedAddress(pinned);

  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    let actual;
    try { actual = normalizeNetworkHostname(hostname); }
    catch (err) { callback(err); return; }

    if (actual !== expected) {
      callback(new ConnectionsError('DNS_PIN_HOST_MISMATCH', `Pinned resolver was asked to resolve unexpected hostname ${hostname}`));
      return;
    }

    if (options?.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  };
}
