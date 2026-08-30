import dns from 'node:dns/promises';
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
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

export async function assertPublicHttps(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Apps may only request public HTTPS URLs.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') throw new Error('Local and metadata hosts are blocked.');
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error('Private network destinations are blocked.');
  return url;
}

export async function safeFetch(value, options = {}, redirects = 0) {
  if (redirects > 4) throw new Error('Too many redirects.');
  const url = await assertPublicHttps(value);
  const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect response is missing a location.');
    return safeFetch(new URL(location, url).href, options, redirects + 1);
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > config.maxNetworkResponseBytes) throw new Error('Network response is too large.');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > config.maxNetworkResponseBytes) throw new Error('Network response is too large.');
  return new Response(buffer, { status: response.status, statusText: response.statusText, headers: response.headers });
}
