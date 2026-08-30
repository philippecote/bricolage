import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { config } from './config.js';

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateIp(normalized.slice(7));
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
    normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

export async function assertPublicHttps(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Apps may only request public HTTPS URLs.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') throw new Error('Local and metadata hosts are blocked.');
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error('Private network destinations are blocked.');
  return { url, address: addresses[0] };
}

/**
 * Fetches a public HTTPS URL on behalf of an app.
 *
 * The connection is pinned to the address that was actually validated. The
 * previous version resolved the hostname, checked it, and then handed the
 * hostname to fetch — which resolved it a second time. A DNS record that changed
 * between those two lookups pointed the request at a private address after the
 * check had passed. Passing our own `lookup` closes that window: the socket can
 * only go where we already approved, while the URL, SNI and Host header stay
 * correct for the site.
 */
export async function safeFetch(value, options = {}, redirects = 0) {
  if (redirects > 4) throw new Error('Too many redirects.');
  const { url, address } = await assertPublicHttps(value);

  const response = await request(url, address, options);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect response is missing a location.');
    return safeFetch(new URL(location, url).href, options, redirects + 1);
  }
  return response;
}

function request(url, address, options) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    const req = https.request(url, {
      method: options.method || 'GET',
      headers: normalizeHeaders(options.headers),
      // Pinned: whatever the resolver says now, this socket goes where we checked.
      // net.connect asks with `all: true` internally and then expects an array.
      lookup: (_hostname, opts, callback) => (opts?.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family)),
      timeout: 12_000,
    }, (res) => {
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > config.maxNetworkResponseBytes) {
        res.destroy();
        reject(new Error('Network response is too large.'));
        return;
      }
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.maxNetworkResponseBytes) {
          res.destroy();
          reject(new Error('Network response is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: toHeaders(res.headers),
      })));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(new Error('Network request timed out.')); });
    req.on('error', reject);
    if (options.body != null) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers);
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function toHeaders(raw) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    // set-cookie arrives as an array; the rest are strings.
    for (const item of Array.isArray(value) ? value : [value]) {
      try { headers.append(key, String(item)); } catch { /* skip a header Headers refuses */ }
    }
  }
  return headers;
}
