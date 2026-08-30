import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * The Docker MCP Catalog, as a store.
 *
 * Docker Desktop already curates ~270 servers, each published as an image pinned
 * by digest and each declaring the secrets it needs. Rather than reproduce any of
 * that, Bricolage drives `docker mcp` and reads its catalog.
 *
 * Installing a server means enabling it in Docker Desktop; the gateway connection
 * then exposes its tools like any other. Secrets go to Docker Desktop's own store
 * via `docker mcp secret set` — Bricolage never holds them, and never reads them
 * back.
 */
export class DockerCatalog {
  constructor({ bin = config.dockerBin, spawnFn = spawn } = {}) {
    this.bin = bin;
    this.spawnFn = spawnFn;
    this.cache = null;
    this.cachedAt = 0;
  }

  run(args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.once('error', (error) => reject(new Error(`Docker is not available: ${error.message}`)));
      child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(cleanError(err) || `docker ${args[1] || ''} failed (${code}).`))));
      if (input) child.stdin.write(input);
      child.stdin.end();
    });
  }

  async available() {
    try { await this.run(['mcp', 'catalog', 'ls']); return { available: true, error: null }; }
    catch (error) { return { available: false, error: error.message }; }
  }

  async catalog() {
    if (this.cache && Date.now() - this.cachedAt < config.dockerCatalogTtlMs) return this.cache;
    const raw = await this.run(['mcp', 'catalog', 'show', 'docker-mcp', '--format', 'json']);
    const parsed = JSON.parse(raw);
    const registry = parsed.registry || parsed;

    this.cache = Object.entries(registry).map(([name, entry]) => ({
      name,
      title: entry.title || name,
      description: entry.description || '',
      category: entry.metadata?.category || 'other',
      icon: typeof entry.icon === 'string' && entry.icon.startsWith('https://') ? entry.icon : null,
      // Pinned by digest by Docker, which is the provenance story for this list.
      image: entry.image || '',
      source: entry.source || entry.upstream || '',
      tools: (entry.tools || []).map((tool) => tool.name).filter(Boolean),
      // What the person will be asked for, in the server's own words.
      secrets: (entry.secrets || []).map((secret) => ({
        name: secret.name,
        env: secret.env || secret.name,
        description: secret.description || '',
        example: secret.example || '',
      })),
      pulls: entry.metadata?.pulls || 0,
      stars: entry.metadata?.githubStars || entry.metadata?.stars || 0,
    })).sort((a, b) => b.pulls - a.pulls);

    this.cachedAt = Date.now();
    return this.cache;
  }

  async enabled() {
    const out = await this.run(['mcp', 'server', 'ls']).catch(() => '');
    if (/no server is enabled/i.test(out)) return [];
    return out.split(/[\n,]/).map((line) => line.trim()).filter((line) => line && !/^(NAME|no server)/i.test(line));
  }

  async enable(name) { await this.run(['mcp', 'server', 'enable', name]); }
  async disable(name) { await this.run(['mcp', 'server', 'disable', name]); }

  // The value goes straight to Docker Desktop's secret store and is never kept here.
  async setSecret(name, value) { await this.run(['mcp', 'secret', 'set', `${name}=${value}`]); }
  async secretNames() {
    const out = await this.run(['mcp', 'secret', 'ls']).catch(() => '');
    return out.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((line) => line && !/^NAME/i.test(line));
  }
}

function cleanError(text) {
  const line = String(text || '').split('\n').map((part) => part.trim()).filter(Boolean).at(-1) || '';
  return line.replace(/^Error:\s*/i, '');
}
