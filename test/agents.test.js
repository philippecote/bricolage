import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildService } from '../src/buildService.js';
import { ClaudeAgent } from '../src/claudeAgent.js';
import { config } from '../src/config.js';
import { writeManifest } from '../src/workshopStorage.js';

// A stand-in for a spawned `claude` process: push stream-json lines, then close.
function fakeSpawn(script) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(async () => {
      for (const line of script) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      await new Promise((resolve) => setTimeout(resolve, 5));
      child.emit('close', 0);
    });
    return child;
  };
}

const collect = (agent, ms = 40) => new Promise((resolve) => {
  const seen = [];
  agent.on('notification', (message) => seen.push(message));
  setTimeout(() => resolve(seen), ms);
});

describe('ClaudeAgent', () => {
  it('normalizes stream-json into the notifications BuildService already understands', async () => {
    const agent = new ClaudeAgent({ spawnFn: fakeSpawn([
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/app/runtime/index.html' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node --check x.js' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Built the app.' },
    ]) });
    const thread = await agent.startThread('/app');
    const events = collect(agent);
    await agent.startTurn(thread, 'build it', { model: 'claude-opus-5', effort: 'high' });
    const seen = await events;

    expect(seen.map((m) => m.method)).toEqual(['item/started', 'item/completed', 'item/started', 'item/completed', 'turn/completed']);
    // Item types must match what phaseForItem/itemLabel key off, or the studio
    // shows the wrong phase for a Claude build.
    expect(seen[0].params.item).toEqual({ type: 'fileChange', name: 'Write', path: '/app/runtime/index.html' });
    expect(seen[2].params.item.type).toBe('command');
    expect(seen[4].params.turn).toMatchObject({ status: 'completed', items: [{ type: 'agentMessage', text: 'Built the app.' }] });
  });

  it('reports a failed turn rather than hanging', async () => {
    const agent = new ClaudeAgent({ spawnFn: fakeSpawn([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'ran out of turns' }]) });
    const thread = await agent.startThread('/app');
    const events = collect(agent);
    await agent.startTurn(thread, 'build it', {});
    const [completed] = await events;
    // The message carries the subtype too, so a bare "error_during_execution"
    // is never all a person sees.
    expect(completed.params.turn.status).toBe('failed');
    expect(completed.params.turn.error).toContain('ran out of turns');
    expect(completed.params.turn.error).toContain('error_during_execution');
  });

  it('creates a session on the first turn and resumes it after', async () => {
    const calls = [];
    const agent = new ClaudeAgent({ spawnFn: (bin, args) => { calls.push(args); return fakeSpawn([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }])(); } });
    const thread = await agent.startThread('/app');
    await agent.startTurn(thread, 'first', { model: 'claude-opus-5', effort: 'high' }, { readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await agent.startTurn(thread, 'second', { model: 'claude-opus-5', effort: 'high' });

    expect(calls[0]).toContain('--session-id');
    expect(calls[1]).toContain('--resume');
    // Shaping is a thinking turn: no write tools offered.
    expect(calls[0][calls[0].indexOf('--allowed-tools') + 1]).toBe('Read,Glob,Grep');
    expect(calls[1][calls[1].indexOf('--allowed-tools') + 1]).toContain('Write');
    expect(calls[1]).toEqual(expect.arrayContaining(['--model', 'claude-opus-5', '--effort', 'high']));
  });
});

describe('agent registry', () => {
  const stub = (name) => Object.assign(new EventEmitter(), {
    name, threads: 0,
    async diagnostic() { return { available: true, authenticated: true, error: null }; },
    async startThread() { this.threads += 1; return `${name}-thread`; },
    async resumeThread(id) { return id; },
    async startTurn() { return { turn: { id: `${name}-turn` } }; },
    async interrupt() {}, respond() {},
  });

  it('routes each preset to the agent that backs it', async () => {
    const codex = stub('codex'); const claude = stub('claude');
    const builds = new BuildService({ codex, claude });
    await builds.ready();
    expect(builds.agentFor('luna-high')).toBe(codex);
    expect(builds.agentFor('luna-max')).toBe(codex);
    expect(builds.agentFor('sol-medium')).toBe(codex);
    expect(builds.agentFor('opus-5-high')).toBe(claude);
  });

  it('explains itself when a preset asks for an agent that is not wired up', async () => {
    const builds = new BuildService({ codex: stub('codex') });
    await builds.ready();
    expect(() => builds.agentFor('opus-5-high')).toThrow(/claude agent, which is not available/);
  });
});

describe('switching agents on an existing app', () => {
  const agent = (name) => Object.assign(new EventEmitter(), {
    name, resumed: [], started: 0, prompts: [],
    async diagnostic() { return { available: true, authenticated: true, error: null }; },
    async startThread() { this.started += 1; return `${name}-thread-${this.started}`; },
    async resumeThread(id) { this.resumed.push(id); return id; },
    async startTurn(threadId, prompt) { this.prompts.push(prompt); return { turn: { id: `${name}-turn` } }; },
    async interrupt() {}, respond() {},
  });

  const APP = 'agent-switch-fixture';

  async function service() {
    const now = new Date().toISOString();
    // run() writes the new thread owner back to the manifest, so it must exist.
    await writeManifest(APP, { id: APP, name: 'Fixture', createdAt: now, updatedAt: now, prompt: 'x' });
    const codex = agent('codex'); const claude = agent('claude');
    const builds = new BuildService({ codex, claude });
    await builds.ready();
    builds.push = () => {};
    builds.persist = async () => {};
    return { codex, claude, builds };
  }

  afterEach(async () => { await fs.rm(path.join(config.appsDir, APP), { recursive: true, force: true }); });

  it('starts a fresh thread rather than resuming another agent\'s id', async () => {
    const { codex, claude, builds } = await service();
    const build = { appId: APP, model: 'opus-5-high', kind: 'edit', threadId: 'codex-thread-1', threadAgent: 'codex', events: [], prompt: 'tweak it' };
    await builds.run(build);

    expect(claude.resumed).toEqual([]);
    expect(claude.started).toBe(1);
    expect(build.threadAgent).toBe('claude');
    const saved = JSON.parse(await fs.readFile(path.join(config.appsDir, APP, 'manifest.json'), 'utf8'));
    expect(saved.threadAgent).toBe('claude');
    expect(build.threadId).toBe('claude-thread-1');
    expect(codex.prompts).toHaveLength(0);
    // A cold agent has the files but not the transcript, so say so.
    expect(claude.prompts[0]).toContain('You have not seen this app earlier');
  });

  it('resumes when the same agent still owns the thread', async () => {
    const { codex, builds } = await service();
    const build = { appId: APP, model: 'luna-high', kind: 'edit', threadId: 'codex-thread-1', threadAgent: 'codex', events: [], prompt: 'tweak it' };
    await builds.run(build);

    expect(codex.resumed).toEqual(['codex-thread-1']);
    expect(codex.started).toBe(0);
    expect(codex.prompts[0]).not.toContain('You have not seen this app earlier');
  });

  it('treats a thread recorded before agents were tracked as Codex-owned', async () => {
    const { builds } = await service();
    const build = builds.newBuild(APP, 'tweak', 'legacy-thread', 'luna-high', 'edit', null);
    expect(build.threadAgent).toBe('codex');
  });
});

describe('streaming preview', () => {
  it('only offers a reload once the runtime file is a complete document', async () => {
    const { BuildService: Service } = await import('../src/buildService.js');
    const { writeManifest, getAppDir } = await import('../src/workshopStorage.js');
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const id = 'preview-fixture';
    const now = new Date().toISOString();
    await writeManifest(id, { id, name: 'Preview', createdAt: now, updatedAt: now, prompt: 'x' });
    const runtime = nodePath.join(getAppDir(id), 'runtime');
    await fsp.mkdir(runtime, { recursive: true });

    const builds = new Service({ codex: Object.assign(new EventEmitter(), {}) });
    await builds.ready();
    const build = { id: 'b1', appId: id, status: 'running' };
    const seen = [];
    builds.on('build:b1', (event) => seen.push(event));

    // Mid-write: truncated, then partial, then whole.
    await fsp.writeFile(nodePath.join(runtime, 'index.html'), '');
    await builds.offerPreview(build);
    await fsp.writeFile(nodePath.join(runtime, 'index.html'), `<!doctype html><html><head>${'x'.repeat(300)}`);
    await builds.offerPreview(build);
    expect(seen).toHaveLength(0);

    await fsp.writeFile(nodePath.join(runtime, 'index.html'), `<!doctype html><html><body>${'x'.repeat(300)}</body></html>`);
    await builds.offerPreview(build);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ preview: true, message: '' });

    // A settled build must not keep reloading.
    build.status = 'completed';
    await builds.offerPreview(build);
    expect(seen).toHaveLength(1);

    await fsp.rm(getAppDir(id), { recursive: true, force: true });
  });
});

describe('build feed labels', () => {
  it('shows the agent\'s own words, real commands, and file names', async () => {
    const { BuildService: Service } = await import('../src/buildService.js');
    const svc = new Service({ codex: new EventEmitter() });
    await svc.ready();
    const build = { id: 'f1', appId: 'x', status: 'running', threadId: 'th', events: [], stage: 'build' };
    svc.builds.set('f1', build);
    svc.persist = async () => {};

    const items = [
      // A login-shell wrapper is not the command the person cares about.
      { type: 'commandExecution', command: '/bin/zsh -lc "node --check runtime/index.html"' },
      // Markdown links to absolute paths are the agent talking to a developer.
      { type: 'agentMessage', text: 'Added the divider in [runtime/index.html](/Users/phil/dev/apps/x/runtime/index.html). It works.' },
      { type: 'fileChange', changes: [{ path: '/abs/apps/x/runtime/index.html' }] },
    ];
    for (const item of items) svc.onCodexNotification({ method: 'item/completed', params: { threadId: 'th', item } });

    expect(build.events.map((event) => [event.phase, event.message])).toEqual([
      ['checking', 'Ran node --check runtime/index.html'],
      ['editing', 'Added the divider in runtime/index.html.'],
      ['editing', 'Finished index.html'],
    ]);
  });

  it('drops empty narration and never repeats itself', async () => {
    const { BuildService: Service } = await import('../src/buildService.js');
    const svc = new Service({ codex: new EventEmitter() });
    await svc.ready();
    const build = { id: 'f2', appId: 'x', status: 'running', threadId: 'th', events: [], stage: 'build' };
    svc.builds.set('f2', build);
    svc.persist = async () => {};

    // An agentMessage arrives empty on start and filled on completion.
    svc.onCodexNotification({ method: 'item/started', params: { threadId: 'th', item: { type: 'agentMessage', text: '' } } });
    expect(build.events).toHaveLength(0);

    svc.onCodexNotification({ method: 'item/completed', params: { threadId: 'th', item: { type: 'agentMessage', text: 'Same thing.' } } });
    svc.onCodexNotification({ method: 'item/completed', params: { threadId: 'th', item: { type: 'agentMessage', text: 'Same thing.' } } });
    expect(build.events.map((event) => event.message)).toEqual(['Same thing.']);
  });
});

describe('connection catalog', () => {
  it('only lists servers under a scope their vendor controls, at pinned versions', async () => {
    const { CONNECTION_CATALOG } = await import('../src/connectionCatalog.js');
    for (const entry of CONNECTION_CATALOG) {
      // The gateway is a first-party docker subcommand, not an npm install.
      if (entry.command === 'docker') { expect(entry.args[0]).toBe('mcp'); continue; }
      const pkg = entry.args.find((arg) => arg.startsWith('@'));
      // An unscoped npm name is claimable by anyone, so it never belongs here.
      expect(pkg, `${entry.id} must install a scoped package`).toBeTruthy();
      expect(pkg.startsWith(`${entry.publisher}/`), `${entry.id} claims ${entry.publisher} but installs ${pkg}`).toBe(true);
      // @latest would let a future compromised release execute on the next add.
      expect(pkg, `${entry.id} must pin a version`).toMatch(/@[\w.-]+$/);
      expect(pkg).not.toContain('@latest');
    }
  });

  it('builds a definition from answers and refuses an incomplete one', async () => {
    const { buildFromCatalog } = await import('../src/connectionCatalog.js');
    const files = buildFromCatalog('files', { values: { directory: '/tmp/notes' } });
    expect(files).toMatchObject({ id: 'files', command: 'npx' });
    expect(files.args.at(-1)).toBe('/tmp/notes');

    const notion = buildFromCatalog('notion', { secrets: { NOTION_TOKEN: '$NOTION_TOKEN' } });
    // A bare $NAME stays a reference, so the token is never copied into config.
    expect(notion.env).toEqual({ NOTION_TOKEN: '$NOTION_TOKEN' });

    expect(() => buildFromCatalog('files', {})).toThrow(/folder to share/i);
    expect(() => buildFromCatalog('notion', {})).toThrow(/token/i);
    expect(() => buildFromCatalog('nope', {})).toThrow(/no catalog entry/i);
  });
});

describe('desktop agent', () => {

  // A scripted model: each entry is one response the loop will receive.
  // input is passed live and mutated, so snapshot what each call actually saw.
  const scripted = (script) => ({ calls: [], async raw(request) { this.calls.push({ ...request, input: [...request.input] }); return script.shift(); } });
  const say = (text) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
  const callTool = (name, args, callId = 'c1') => ({ output: [{ type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) }] });

  it('reads freely and answers from what it found', async () => {
    const llm = scripted([callTool('list_apps', {}), say('You have one app.')]);
    const agent = new (await import('../src/desktopAgent.js')).DesktopAgent({ llm, runAction: async () => ({}) });
    const result = await agent.send({ message: 'what do I have?' });

    expect(result.performed.map((step) => step.tool)).toEqual(['list_apps']);
    expect(result.reply).toBe('You have one app.');
    expect(result.pending).toBeNull();
    // The tool result must be fed back, or the second turn is answering blind.
    expect(llm.calls[1].input.some((item) => item.type === 'function_call_output')).toBe(true);
  });

  it('stops and proposes anything that writes, spends, or runs app code', async () => {
    for (const [tool, args] of [
      ['build_app', { prompt: 'a timer', why: 'You asked for one.' }],
      ['edit_app', { appId: 'a', prompt: 'louder', why: 'It is quiet.' }],
      ['run_app_action', { appId: 'a', action: 'clear', payloadJson: '{}', why: 'Clears them.' }],
      ['open_app', { appId: 'a', why: 'Here it is.' }],
    ]) {
      const agent = new (await import('../src/desktopAgent.js')).DesktopAgent({ llm: scripted([callTool(tool, args)]), runAction: async () => ({}) });
      const result = await agent.send({ message: 'go' });
      expect(result.pending, `${tool} must be proposed`).toMatchObject({ tool });
      expect(result.performed).toEqual([]);
      // A bare button with no words is not a proposal, so `why` is the fallback.
      expect(result.reply).toBe(args.why);
    }
  });

  it('carries the conversation across turns and resumes an approved act', async () => {
    const llm = scripted([callTool('build_app', { prompt: 'a timer', why: 'You asked.' }), say('Started it.')]);
    const agent = new (await import('../src/desktopAgent.js')).DesktopAgent({ llm, runAction: async () => ({}) });
    const first = await agent.send({ message: 'build me a timer' });
    expect(first.pending.tool).toBe('build_app');

    const second = await agent.send({ conversationId: first.conversationId, approved: { callId: first.pending.callId, result: { started: true } } });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.reply).toBe('Started it.');
    // The whole exchange is still in context, not just the latest message.
    expect(llm.calls[1].input.length).toBeGreaterThan(llm.calls[0].input.length);
  });

  it('gives up rather than looping forever', async () => {
    const llm = scripted(Array.from({ length: 12 }, (_, i) => callTool('list_apps', {}, `c${i}`)));
    const agent = new (await import('../src/desktopAgent.js')).DesktopAgent({ llm, runAction: async () => ({}) });
    const result = await agent.send({ message: 'go' });
    expect(result.performed.length).toBeLessThanOrEqual(6);
    expect(result.reply).toMatch(/more steps than I expected/);
  });
});

describe('recovering a thread that will not resume', () => {
  it('starts a fresh thread once, rather than leaving the app stuck', async () => {
    const { BuildService } = await import('../src/buildService.js');
    const { writeManifest, readManifest } = await import('../src/workshopStorage.js');
    const { config } = await import('../src/config.js');
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');

    const id = 'poisoned-thread-fixture';
    const now = new Date().toISOString();
    await writeManifest(id, { id, name: 'Fixture', createdAt: now, updatedAt: now, prompt: 'x', model: 'luna-high', threadId: 'old-thread', threadAgent: 'codex' });

    let started = 0;
    const agent = Object.assign(new EventEmitter(), {
      async startThread() { started += 1; return `fresh-${started}`; },
      async resumeThread(t) { return t; },
      async startTurn() { return { turn: { id: 't' } }; },
      async interrupt() {}, respond() {},
    });
    const builds = new BuildService({ codex: agent });
    await builds.ready();
    builds.persist = async () => {};

    const build = await builds.edit(id, 'change something');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const live = builds.get(build.id);
    expect(live.resumed).toBe(true);
    expect(started).toBe(0);

    // The resumed turn comes back failed.
    agent.emit('notification', { method: 'turn/completed', params: { threadId: 'old-thread', turn: { id: 't', status: 'failed', error: 'error_during_execution' } } });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(live.retriedFresh).toBe(true);
    expect(started).toBe(1);
    expect(live.threadId).toBe('fresh-1');
    expect(live.status).toBe('running');
    expect((await readManifest(id)).threadId).toBe('fresh-1');

    // A second failure is a real failure, not another retry.
    agent.emit('notification', { method: 'turn/completed', params: { threadId: 'fresh-1', turn: { id: 't', status: 'failed', error: 'error_during_execution' } } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(started).toBe(1);
    expect(live.status).toBe('failed');

    await fsp.rm(nodePath.join(config.appsDir, id), { recursive: true, force: true });
  });
});
