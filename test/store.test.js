import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DockerCatalog } from '../src/dockerCatalog.js';

// Stands in for the `docker` binary: each call resolves by matching its args.
function fakeDocker(responses) {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push(args.join(' '));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const key = Object.keys(responses).find((k) => args.join(' ').startsWith(k));
    queueMicrotask(() => {
      const reply = responses[key];
      if (reply?.fail) { child.stderr.end(reply.fail); child.emit('close', 1); return; }
      child.stdout.end(reply ?? '');
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

const CATALOG = JSON.stringify({
  registry: {
    quiet: { title: 'Quiet', description: 'no keys', image: 'mcp/quiet@sha256:aaa', icon: 'https://example.com/i.png', tools: [{ name: 'a' }], metadata: { category: 'search', pulls: 10 } },
    loud: { title: 'Loud', description: 'needs a key', image: 'mcp/loud@sha256:bbb', icon: 'javascript:alert(1)', tools: [{ name: 'b' }, { name: 'c' }], metadata: { category: 'devops', pulls: 5000 }, secrets: [{ name: 'loud.token', env: 'LOUD_TOKEN', description: 'Make one', example: '<TOKEN>' }] },
  },
});

describe('docker catalog', () => {
  it('normalizes the catalog and orders it by popularity', async () => {
    const { spawnFn } = fakeDocker({ 'mcp catalog show': CATALOG });
    const servers = await new DockerCatalog({ spawnFn }).catalog();

    expect(servers.map((s) => s.name)).toEqual(['loud', 'quiet']);
    expect(servers[0]).toMatchObject({ title: 'Loud', category: 'devops', tools: ['b', 'c'], pulls: 5000 });
    expect(servers[0].secrets).toEqual([{ name: 'loud.token', env: 'LOUD_TOKEN', description: 'Make one', example: '<TOKEN>' }]);
    // Icons are rendered in the desktop, so a non-https one is not passed through.
    expect(servers[0].icon).toBeNull();
    expect(servers[1].icon).toBe('https://example.com/i.png');
  });

  it('caches so browsing does not re-shell out per keystroke', async () => {
    const { spawnFn, calls } = fakeDocker({ 'mcp catalog show': CATALOG });
    const store = new DockerCatalog({ spawnFn });
    await store.catalog();
    await store.catalog();
    expect(calls.filter((c) => c.startsWith('mcp catalog show'))).toHaveLength(1);
  });

  it('reads the enabled list, including when nothing is on', async () => {
    const none = new DockerCatalog({ spawnFn: fakeDocker({ 'mcp server ls': 'No server is enabled' }).spawnFn });
    expect(await none.enabled()).toEqual([]);
    const some = new DockerCatalog({ spawnFn: fakeDocker({ 'mcp server ls': 'duckduckgo, grafana\n' }).spawnFn });
    expect(await some.enabled()).toEqual(['duckduckgo', 'grafana']);
  });

  it('sends secrets to Docker rather than storing them', async () => {
    const { spawnFn, calls } = fakeDocker({ 'mcp secret set': '', 'mcp server enable': '' });
    const store = new DockerCatalog({ spawnFn });
    await store.setSecret('loud.token', 'sekret');
    await store.enable('loud');
    expect(calls).toEqual(['mcp secret set loud.token=sekret', 'mcp server enable loud']);
  });

  it('reports a stopped Docker Desktop in its own words', async () => {
    const { spawnFn } = fakeDocker({ 'mcp catalog ls': { fail: 'Error: Docker Desktop is not running\n' } });
    expect(await new DockerCatalog({ spawnFn }).available()).toEqual({ available: false, error: 'Docker Desktop is not running' });
  });
});

describe('mcp result shape', () => {
  it('treats a text wrapper as no structure at all', async () => {
    const { usefulStructure } = await import('../src/mcpHost.js');

    // Some servers put their own text in structuredContent. That is not
    // structure, and preferring it made apps parse the wrapper instead of the
    // answer — which is exactly how a working file browser showed nothing.
    expect(usefulStructure({ content: 'Allowed:\n/a' })).toBeNull();
    expect(usefulStructure({ text: 'hello' })).toBeNull();

    // Real structure passes through untouched.
    expect(usefulStructure({ entries: [1, 2] })).toEqual({ entries: [1, 2] });
    expect(usefulStructure({ content: 'x', more: 1 })).toEqual({ content: 'x', more: 1 });
    expect(usefulStructure({ content: ['not a string'] })).toEqual({ content: ['not a string'] });

    expect(usefulStructure(null)).toBeNull();
    expect(usefulStructure('a string')).toBeNull();
  });
});

describe('remembered tool descriptions', () => {
  const scratch = async () => {
    const { config } = await import('../src/config.js');
    const nodePath = await import('node:path');
    return nodePath.join(config.workshopDir, `tools-fixture-${Math.random().toString(36).slice(2)}.json`);
  };

  it('answers from disk instead of starting a server a build cannot wait for', async () => {
    const { McpHost } = await import('../src/mcpHost.js');
    const fsp = await import('node:fs/promises');
    const file = await scratch();
    const host = new McpHost({ file });

    // A command that cannot possibly start, so anything returned came from cache.
    await host.add({ id: 'slow', label: 'Slow', command: '/usr/bin/false', args: [] });
    await fsp.writeFile(host.toolsFile, JSON.stringify({ slow: { tools: [{ name: 'list_directory', inputSchema: { properties: { path: {} }, required: ['path'] } }], at: 'x' } }));
    host.toolCache = null;

    const started = Date.now();
    const [described] = await host.describe(['slow']);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(described.remembered).toBe(true);
    expect(described.tools[0].name).toBe('list_directory');
    // Signatures survive the round trip, which is the whole point.
    expect(Object.keys(described.tools[0].inputSchema.properties)).toEqual(['path']);

    host.stopAll();
    await fsp.rm(file, { force: true });
    await fsp.rm(host.toolsFile, { force: true });
  });

  it('forgets a connection\'s tools when it is redefined or removed', async () => {
    const { McpHost } = await import('../src/mcpHost.js');
    const fsp = await import('node:fs/promises');
    const file = await scratch();
    const host = new McpHost({ file });

    await host.add({ id: 'thing', label: 'Thing', command: '/usr/bin/false', args: [] });
    await host.rememberTools([{ id: 'thing', tools: [{ name: 'old_tool' }] }]);
    expect((await host.loadToolCache()).thing.tools[0].name).toBe('old_tool');

    // Pointing the id at a different server must not answer with the old tools.
    await host.add({ id: 'thing', label: 'Thing', command: '/usr/bin/true', args: [] });
    expect((await host.loadToolCache()).thing).toBeUndefined();

    await host.rememberTools([{ id: 'thing', tools: [{ name: 'new_tool' }] }]);
    await host.remove('thing');
    expect((await host.loadToolCache()).thing).toBeUndefined();

    host.stopAll();
    await fsp.rm(file, { force: true });
    await fsp.rm(host.toolsFile, { force: true });
  });
});
