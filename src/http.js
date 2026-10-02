import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { ConnectionsError, fail } from './errors.js';
import { assertRemoteAddressApproved, createPinnedLookup, resolveNetworkTarget } from './network-target.js';

function responseHeaders(res) {
  const headers = new Headers();
  if (Array.isArray(res.rawHeaders) && res.rawHeaders.length) {
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    }
    return headers;
  }
  for (const [name, value] of Object.entries(res.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }
  return headers;
}

function requestFunctionFor(url, network) {
  if (network?.request) return network.request;
  return url.protocol === 'https:' ? https.request : http.request;
}

function tlsServername(hostname) {
  return net.isIP(hostname) ? undefined : hostname;
}

function requestPinned(url, options, limits, resolution, network = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    const headers = new Headers(options.headers || {});
    const requestImpl = requestFunctionFor(url, network);
    const lookup = createPinnedLookup(resolution.hostname, resolution.pinned);

    const requestOptions = {
      method: options.method || 'GET',
      headers: Object.fromEntries(headers.entries()),
      agent: false,
      lookup
    };
    const servername = tlsServername(resolution.hostname);
    if (url.protocol === 'https:' && servername) requestOptions.servername = servername;

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const req = requestImpl(url, requestOptions, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400) {
        if (typeof res.resume === 'function') res.resume();
        finishReject(new ConnectionsError('REDIRECT_FORBIDDEN', 'External redirects are disabled to prevent origin/credential confusion'));
        return;
      }

      const headersOut = responseHeaders(res);
      const declared = Number(headersOut.get('content-length') || 0);
      if (declared > limits.maxResponseBytes) {
        if (typeof res.destroy === 'function') res.destroy();
        finishReject(new ConnectionsError('RESPONSE_TOO_LARGE', 'External response exceeds configured size budget'));
        return;
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > limits.maxResponseBytes) {
          if (typeof res.destroy === 'function') res.destroy();
          finishReject(new ConnectionsError('RESPONSE_TOO_LARGE', 'External response exceeds configured size budget'));
          return;
        }
        chunks.push(buffer);
      });
      res.once('error', finishReject);
      res.once('end', () => {
        if (settled) return;
        const buffer = Buffer.concat(chunks);
        const noBody = String(options.method || 'GET').toUpperCase() === 'HEAD' || [204, 205, 304].includes(status);
        let response;
        try {
          response = new Response(noBody ? null : buffer, {
            status,
            statusText: res.statusMessage || '',
            headers: headersOut
          });
        } catch (err) {
          finishReject(err);
          return;
        }
        finishResolve({ response, buffer });
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new ConnectionsError('REQUEST_TIMEOUT', 'External request exceeded configured timeout'));
    }, limits.timeoutMs);

    req.once('error', finishReject);

    const send = (socket) => {
      if (sent || settled) return;
      try {
        assertRemoteAddressApproved(socket.remoteAddress, resolution.addresses);
      } catch (err) {
        req.destroy(err);
        return;
      }
      if (url.protocol === 'https:' && socket.authorized === false) {
        req.destroy(new ConnectionsError('TLS_AUTHORIZATION_FAILED', socket.authorizationError || 'TLS peer authorization failed'));
        return;
      }
      sent = true;
      req.end(options.body);
    };

    req.once('socket', (socket) => {
      if (url.protocol === 'https:') {
        socket.once('secureConnect', () => send(socket));
        return;
      }
      if (!socket.connecting && socket.remoteAddress) {
        queueMicrotask(() => send(socket));
      } else {
        socket.once('connect', () => send(socket));
      }
    });
  });
}

export async function boundedFetch(urlString, options, limits, expectedOrigin, network = {}) {
  const url = new URL(urlString);
  if (expectedOrigin && url.origin !== expectedOrigin) {
    fail('ORIGIN_MISMATCH', 'External request attempted to leave the registered connection origin');
  }

  const resolution = await resolveNetworkTarget(url.toString(), limits, network.lookup);

  const headers = new Headers(options.headers || {});
  const contentLength = headers.get('content-length');
  if (contentLength && Number(contentLength) > limits.maxRequestBytes) {
    fail('REQUEST_TOO_LARGE', 'External request exceeds configured size budget');
  }

  let bodyBytes = 0;
  if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) bodyBytes = Buffer.byteLength(options.body);
  if (bodyBytes > limits.maxRequestBytes) {
    fail('REQUEST_TOO_LARGE', 'External request exceeds configured size budget');
  }

  return requestPinned(url, { ...options, headers }, limits, resolution, network);
}
