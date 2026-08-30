import path from 'node:path';
import { randomId } from './utils.js';
import { config } from './config.js';

/**
 * Opening a file is a desktop verb, not something each app reimplements.
 *
 * When an app asks to open a file, the host mints a grant: an opaque id standing
 * for one file, from one connection, for a few minutes. The viewer receives only
 * that id — never a path it could walk, and never a folder. Bytes then arrive
 * over a normal HTTP request rather than through the action bridge, which has a
 * 128KB payload cap and would need base64 on top of it.
 */
export class FileGrants {
  constructor({ ttlMs = config.fileGrantTtlMs } = {}) {
    this.ttlMs = ttlMs;
    this.grants = new Map();
  }

  issue({ connection, filePath, appId }) {
    this.sweep();
    const id = randomId();
    this.grants.set(id, { connection, filePath, appId, expiresAt: Date.now() + this.ttlMs });
    return { id, name: path.basename(filePath), ext: extensionOf(filePath), mime: mimeFor(filePath) };
  }

  get(id) {
    this.sweep();
    const grant = this.grants.get(id);
    if (!grant) throw Object.assign(new Error('That file link has expired. Open it again.'), { statusCode: 404 });
    return grant;
  }

  sweep() {
    const now = Date.now();
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id);
  }
}

export function extensionOf(filePath) {
  return path.extname(String(filePath)).replace(/^\./, '').toLowerCase();
}

const MIME = {
  pdf: 'application/pdf',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  html: 'text/html', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
export function mimeFor(filePath) { return MIME[extensionOf(filePath)] || 'application/octet-stream'; }
export function isTextual(filePath) { return /^text\/|json|xml|yaml/.test(mimeFor(filePath)); }

/**
 * Reads a file through whichever tools the connection actually offers. Servers
 * differ: some expose read_media_file for binary, some only read_file.
 */
export async function readThroughConnection(connection, filePath) {
  await connection.start();
  const names = new Set(connection.tools.map((tool) => tool.name));
  const textual = isTextual(filePath);

  if (!textual && names.has('read_media_file')) {
    const result = await connection.call('read_media_file', { path: filePath });
    const inline = (result.raw || []).find((part) => part.data);
    if (inline?.data) return Buffer.from(inline.data, 'base64');
  }
  for (const tool of textual ? ['read_text_file', 'read_file'] : ['read_file', 'read_text_file']) {
    if (!names.has(tool)) continue;
    const result = await connection.call(tool, { path: filePath });
    if (typeof result.text === 'string' && result.text) return Buffer.from(result.text, 'utf8');
  }
  throw new Error('That connection cannot read files.');
}
