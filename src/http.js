import { assertNetworkTargetAllowed } from './util.js';
import { fail } from './errors.js';

export async function boundedFetch(urlString, options, limits, expectedOrigin) {
  const url = new URL(urlString);
  if (expectedOrigin && url.origin !== expectedOrigin) fail('ORIGIN_MISMATCH', 'External request attempted to leave the registered connection origin');
  await assertNetworkTargetAllowed(url.toString(), limits);
  const headers = new Headers(options.headers || {});
  const contentLength = headers.get('content-length');
  if (contentLength && Number(contentLength) > limits.maxRequestBytes) fail('REQUEST_TOO_LARGE', 'External request exceeds configured size budget');
  let bodyBytes = 0;
  if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) bodyBytes = Buffer.byteLength(options.body);
  if (bodyBytes > limits.maxRequestBytes) fail('REQUEST_TOO_LARGE', 'External request exceeds configured size budget');

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(limits.timeoutMs)
  });
  if (response.status >= 300 && response.status < 400) fail('REDIRECT_FORBIDDEN', 'External redirects are disabled to prevent origin/credential confusion');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limits.maxResponseBytes) fail('RESPONSE_TOO_LARGE', 'External response exceeds configured size budget');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limits.maxResponseBytes) fail('RESPONSE_TOO_LARGE', 'External response exceeds configured size budget');
  return { response, buffer };
}
