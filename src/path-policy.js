import { fail } from './errors.js';

const POLICY_BASE = 'https://aiverse.invalid';

function rawPathname(value) {
  const raw = String(value);
  const query = raw.indexOf('?');
  const hash = raw.indexOf('#');
  const end = [query, hash].filter((x) => x >= 0).reduce((a, b) => Math.min(a, b), raw.length);
  return raw.slice(0, end);
}

function assertNoPathConfusion(pathname, { subject = 'Generic API path' } = {}) {
  if (!pathname.startsWith('/')) fail('INVALID_PATH', `${subject} must begin with /`);

  let probe = pathname;
  for (let depth = 0; depth < 4; depth++) {
    if (probe.includes('\\')) {
      fail('PATH_CONFUSION_FORBIDDEN', `${subject} contains a backslash path separator`);
    }
    if (/%(?:2f|5c)/i.test(probe)) {
      fail('PATH_CONFUSION_FORBIDDEN', `${subject} contains an encoded path separator`);
    }

    const segments = probe.split('/');
    let changed = false;
    const decoded = segments.map((segment) => {
      let value;
      try { value = decodeURIComponent(segment); }
      catch { fail('INVALID_PATH', `${subject} contains malformed percent encoding`); }

      if (value === '.' || value === '..') {
        fail('PATH_CONFUSION_FORBIDDEN', `${subject} contains a dot-segment traversal form`);
      }
      if (value.includes('/') || value.includes('\\')) {
        fail('PATH_CONFUSION_FORBIDDEN', `${subject} contains an encoded path separator`);
      }
      if (value !== segment) changed = true;
      return value;
    });

    if (!changed) return;
    probe = decoded.join('/');
  }

  fail('PATH_CONFUSION_FORBIDDEN', `${subject} contains excessively nested percent encoding`);
}

export function canonicalizeAllowedPathPrefix(prefix) {
  const raw = String(prefix);
  if (raw.includes('?') || raw.includes('#')) {
    fail('INVALID_PATH_PREFIX', 'Generic API allowed path prefixes must contain a pathname only');
  }
  assertNoPathConfusion(raw, { subject: 'Generic API allowed path prefix' });

  const target = new URL(raw, POLICY_BASE);
  if (target.origin !== POLICY_BASE) {
    fail('INVALID_PATH_PREFIX', 'Generic API allowed path prefix must remain a pathname');
  }
  return target.pathname;
}

export function canonicalizeAllowedPathPrefixes(prefixes) {
  return [...new Set(prefixes.map(canonicalizeAllowedPathPrefix))];
}

export function canonicalizeGenericRequestTarget(path, baseUrl, origin) {
  const raw = String(path || '/');
  const pathname = rawPathname(raw);
  assertNoPathConfusion(pathname);

  const target = new URL(raw, `${baseUrl}/`);
  if (target.origin !== origin) {
    fail('ORIGIN_MISMATCH', 'Generic API request must remain on the registered origin');
  }
  return target;
}

export function assertNormalizedPathAllowed(pathname, prefixes) {
  const admitted = prefixes.some((prefix) =>
    pathname === prefix ||
    pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
  );
  if (!admitted) {
    fail('PATH_NOT_ALLOWED', `Normalized path ${pathname} is outside admitted prefixes`);
  }
}

export function assertGenericTargetPathAllowed(targetValue, origin, prefixes) {
  const target = new URL(targetValue);
  if (target.origin !== origin) {
    fail('ORIGIN_MISMATCH', 'Generic API request must remain on the registered origin');
  }
  assertNoPathConfusion(target.pathname);
  assertNormalizedPathAllowed(target.pathname, prefixes);
  return target;
}
