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
    expect(completed.params.turn).toMatchObject({ status: 'failed', error: 'ran out of turns' });
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
