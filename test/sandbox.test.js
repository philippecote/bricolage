import { describe, expect, it } from 'vitest';
import { executeAction } from '../src/sandbox.js';
import { createTaintGuard } from '../src/taint.js';
import { assertPublicHttps } from '../src/network.js';

const run = (body, host = {}, timeoutMs = 15_000) =>
  executeAction({ code: `export async function handler(input, ctx) { ${body} }`, input: {}, ctx: { appId: 'x', action: 'y', requestId: 'r', nowIso: '' }, host, timeoutMs });

describe('action sandbox', () => {
  it('runs an ordinary action and returns its output and logs', async () => {
    const result = await executeAction({
      code: 'export async function handler(input, ctx) { console.log("hi", input.a); return { doubled: input.a * 2, app: ctx.appId }; }',
      input: { a: 21 }, ctx: { appId: 'demo', action: 'y', requestId: 'r', nowIso: '' }, host: {}, timeoutMs: 15_000,
    });
    expect(result.output).toEqual({ doubled: 42, app: 'demo' });
    expect(result.logs).toEqual(['hi 21']);
  });

  // The process is the boundary, not the vm context: reaching the host realm is
  // expected and must simply be worthless.
  it('lets code reach the host realm and still denies every capability', async () => {
    const realm = await run("const p = Function('return process')(); return { process: typeof p, require: typeof p.mainModule.require };");
    expect(realm.output).toEqual({ process: 'object', require: 'function' });

    const attempts = {
      'read a file': "const r = Function('return process')().mainModule.require; return r('node:fs').readFileSync('/etc/passwd','utf8');",
      'read the home directory': "const r = Function('return process')().mainModule.require; return r('node:fs').readdirSync(process.env.HOME || '/');",
      'spawn a process': "const r = Function('return process')().mainModule.require; return r('node:child_process').execSync('id').toString();",
      'open a socket': "const r = Function('return process')().mainModule.require; return typeof r('node:net').connect;",
      'resolve dns': "const r = Function('return process')().mainModule.require; return typeof r('node:dns').lookup;",
      'load a native addon': "return Function('return process')().dlopen({ exports: {} }, '/tmp/x.node');",
    };
    for (const [what, code] of Object.entries(attempts)) {
      await expect(run(code), `${what} must be denied`).rejects.toThrow();
    }
  });

  it('hands the action no ambient network or secrets', async () => {
    const result = await run('return { fetch: typeof fetch, envKeys: Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/i.test(k)) };');
    expect(result.output.fetch).toBe('undefined');
    expect(result.output.envKeys).toEqual([]);
  });

  it('grants only the capabilities the host provides', async () => {
    const host = { 'storage.get': async () => ({ items: [1, 2] }) };
    const ok = await run("return await ctx.storage.get('items');", host);
    expect(ok.output).toEqual({ items: [1, 2] });
    await expect(run("return await ctx.mcp('anything').call('t', {});", host)).rejects.toThrow(/cannot use mcp\.call/i);
  });

  it('kills an action that will not finish', async () => {
    await expect(run('while (true) {}', {}, 1200)).rejects.toThrow(/timed out/i);
  });

  it('surfaces a host refusal to the action as a normal error', async () => {
    const host = { fetch: async () => { throw new Error('Private network destinations are blocked.'); } };
    const result = await run("try { await ctx.fetch('https://x'); return 'allowed'; } catch (e) { return e.message; }", host);
    expect(result.output).toMatch(/Private network/);
  });
});

describe('taint guard', () => {
  const connection = (tools) => ({ async get() { return { start: async () => {}, tools }; } });
  const READ = { name: 'read_text_file', annotations: { readOnlyHint: true } };
  const WRITE = { name: 'write_file', annotations: { readOnlyHint: false } };

  it('allows anything before untrusted content enters the run', async () => {
    const guard = createTaintGuard();
    await expect(guard.assertMayCall(connection([READ, WRITE]), 'notes', 'write_file')).resolves.toBeUndefined();
    expect(guard.constrainLlm({ search: true })).toEqual({ search: true });
  });

  it('permits only read-only tools once something untrusted has been read', async () => {
    const guard = createTaintGuard();
    guard.taint('the web');
    await expect(guard.assertMayCall(connection([READ, WRITE]), 'notes', 'read_text_file')).resolves.toBeUndefined();
    await expect(guard.assertMayCall(connection([READ, WRITE]), 'notes', 'write_file')).rejects.toThrow(/only use read-only tools/);
    // A server that does not annotate its tools gets no benefit of the doubt.
    await expect(guard.assertMayCall(connection([{ name: 'write_file' }]), 'notes', 'write_file')).rejects.toThrow(/not marked read-only/);
    // And a later model call must not be able to go back out and be steered.
    expect(guard.constrainLlm({ search: true })).toEqual({ search: false });
  });

  it('remembers the first source of taint', () => {
    const guard = createTaintGuard();
    guard.taint('the web');
    guard.taint('the notes connection');
    expect(guard.source).toBe('the web');
  });
});

describe('safeFetch guards', () => {
  it('refuses anything that is not a public HTTPS destination', async () => {
    await expect(assertPublicHttps('http://example.com')).rejects.toThrow(/HTTPS/);
    await expect(assertPublicHttps('https://localhost/x')).rejects.toThrow(/Local and metadata/);
    await expect(assertPublicHttps('https://metadata.google.internal/')).rejects.toThrow(/Local and metadata/);
    await expect(assertPublicHttps('https://169.254.169.254/')).rejects.toThrow(/Private network/);
    await expect(assertPublicHttps('https://127.0.0.1/')).rejects.toThrow(/Private network/);
    await expect(assertPublicHttps('https://10.0.0.1/')).rejects.toThrow(/Private network/);
  });

  it('returns the address it validated, so the socket can be pinned to it', async () => {
    const { address } = await assertPublicHttps('https://example.com');
    expect(address.address).toMatch(/^[\d.]+$|:/);
    expect([4, 6]).toContain(address.family);
  });
});

describe('model selection', () => {
  it('keeps an app\'s model when a request does not name one', async () => {
    const { z } = await import('zod');
    const { MODEL_KEYS, DEFAULT_MODEL } = await import('../src/buildService.js');

    // Zod applies .default() before .optional(), so this still yields the
    // default for a missing key — which reset an app's model on every edit,
    // rename, pin and archive.
    const trap = z.object({ model: z.enum(MODEL_KEYS).default(DEFAULT_MODEL).optional() });
    expect(trap.parse({}).model).toBe(DEFAULT_MODEL);

    const correct = z.object({ model: z.enum(MODEL_KEYS).optional() });
    expect(correct.parse({})).toEqual({});
    expect(correct.parse({ model: 'opus-5-high' }).model).toBe('opus-5-high');
  });

  it('edits fall back to the app\'s own model, not the global default', async () => {
    const { BuildService } = await import('../src/buildService.js');
    const { writeManifest, readManifest } = await import('../src/workshopStorage.js');
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const { config } = await import('../src/config.js');
    const { EventEmitter } = await import('node:events');

    const id = 'model-memory-fixture';
    const now = new Date().toISOString();
    await writeManifest(id, { id, name: 'Fixture', createdAt: now, updatedAt: now, prompt: 'x', model: 'opus-5-high' });

    const agent = Object.assign(new EventEmitter(), {
      async startThread() { return 'thread-1'; }, async resumeThread(t) { return t; },
      async startTurn() { return { turn: { id: 't' } }; }, async interrupt() {}, respond() {},
    });
    const builds = new BuildService({ codex: agent, claude: agent });
    await builds.ready();
    builds.push = () => {}; builds.persist = async () => {};

    const kept = await builds.edit(id, 'tweak');
    expect(kept.model).toBe('opus-5-high');
    expect((await readManifest(id)).model).toBe('opus-5-high');

    // A second edit while the first is still running is queued, not started.
    const queued = await builds.edit(id, 'and this too');
    expect(queued.id).toBe(kept.id);

    // Once the turn is finished, an explicit model is honoured.
    builds.get(kept.id).status = 'completed';
    const changed = await builds.edit(id, 'tweak', 'sol-medium');
    expect(changed.model).toBe('sol-medium');

    await fsp.rm(nodePath.join(config.appsDir, id), { recursive: true, force: true });
  });
});
