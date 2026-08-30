import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseDiscovery } from '../src/buildService.js';
import { config } from '../src/config.js';

const DISCOVERY_REPLY = `Here you go.

\`\`\`json
{
  "name": "Focus Timer",
  "summary": "A single-session focus timer that logs finished sessions.",
  "questions": [
    { "id": "session-length", "prompt": "How long is one session?", "options": ["25 minutes", "50 minutes", "I choose each time"] },
    { "id": "after-session", "prompt": "What happens when a session ends?", "options": ["Log it and stop", "Start a break"] }
  ],
  "plan": ["Build the timer", "Log finished sessions", "Check a full session end to end"]
}
\`\`\``;

class FakeCodex extends EventEmitter {
  constructor() { super(); this.prompts = []; }
  async diagnostic() { return { available: true, authenticated: true, error: null }; }
  async startThread(_cwd, settings) { this.threadSettings = settings; return `thread-${Date.now()}`; }
  async resumeThread(id) { return id; }
  async startTurn(threadId, prompt, settings) {
    this.turnSettings = settings;
    this.prompts.push(prompt);
    const shaping = prompt.includes('This turn is for shaping only');
    const turn = { id: `turn-${this.prompts.length}`, status: 'completed', items: shaping ? [{ type: 'agentMessage', text: DISCOVERY_REPLY }] : [] };
    setTimeout(() => this.emit('notification', { method: 'turn/completed', params: { threadId, turn } }), 5);
    return { turn: { id: turn.id } };
  }
  async interrupt() {}
  respond() {}
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Workshop API', () => {
  let app;
  let codex;
  const createdIds = [];

  beforeEach(async () => {
    codex = new FakeCodex();
    app = createApp({ codex, llmService: null });
    await app.ready();
  });

  afterEach(async () => {
    // Shaping writes the thread id back to the manifest; let those land before
    // removing the workspace, or the write recreates the directory after rm.
    await settle(80);
    for (const id of createdIds.splice(0)) await fs.rm(path.join(config.appsDir, id), { recursive: true, force: true });
  });

  it('reports Codex readiness and migrated starter apps', async () => {
    const status = await request(app).get('/api/system/status');
    expect(status.status).toBe(200);
    expect(status.body.codex.available).toBe(true);
    // Include archived apps: this asserts migration ran, not what the local
    // workspace happens to have archived.
    const list = await request(app).get('/api/apps').query({ archived: 'true' });
    expect(list.body.apps.some((item) => item.id === 'sec')).toBe(true);
    expect(list.body.apps.some((item) => item.id === 'tic-tac-toe')).toBe(true);
  });

  it('asks the Codex agent for the setup questions before building', async () => {
    const response = await request(app).post('/api/apps').send({ prompt: 'Build a tiny focus timer', model: 'luna-max' });
    expect(response.status).toBe(202);
    createdIds.push(response.body.appId);
    // Create returns immediately; shaping is a real Codex turn running behind it.
    expect(response.body.build.status).toBe('discovering');
    await settle();

    const shaped = await request(app).get(`/api/apps/${response.body.appId}`);
    expect(shaped.body.latestBuild.status).toBe('awaiting_input');
    expect(codex.prompts[0]).toContain('This turn is for shaping only');
    expect(shaped.body.latestBuild.questions).toEqual([
      { id: 'session-length', prompt: 'How long is one session?', options: ['25 minutes', '50 minutes', 'I choose each time'] },
      { id: 'after-session', prompt: 'What happens when a session ends?', options: ['Log it and stop', 'Start a break'] },
    ]);
    // The agent's own naming and plan reach the workspace, not Workshop's guesses.
    expect(shaped.body.app.name).toBe('Focus Timer');
    expect(shaped.body.latestBuild.plan).toContain('Log finished sessions');

    const answered = await request(app).post(`/api/builds/${response.body.buildId}/answers`).send({ answers: { 'session-length': '25 minutes', 'after-session': 'Start a break' } });
    expect(answered.status).toBe(200);
    await settle();

    const detail = await request(app).get(`/api/apps/${response.body.appId}`);
    expect(detail.body.app.status).toBe('ready');
    expect(detail.body.app.model).toBe('luna-max');
    expect(codex.threadSettings).toMatchObject({ model: 'gpt-5.6-luna', effort: 'max' });
    expect(codex.turnSettings).toMatchObject({ model: 'gpt-5.6-luna', effort: 'max' });
    // Shaping and building share one thread, so the build keeps the agent's context.
    expect(codex.prompts).toHaveLength(2);
    expect(codex.prompts[1]).toContain('session-length: 25 minutes');
    expect(detail.body.app.threadId).toMatch(/^thread-/);
    expect(detail.body.revisions).toEqual([1]);
    const skill = await fs.readFile(path.join(config.appsDir, response.body.appId, '.codex', 'skills', 'workshop-app-builder', 'SKILL.md'), 'utf8');
    expect(skill).toContain('The shaping turn');
  });

  it('defaults to the Luna high preset', async () => {
    const response = await request(app).post('/api/apps').send({ prompt: 'Build a tiny reading list' });
    createdIds.push(response.body.appId);
    expect(response.body.app.model).toBe('luna-high');
    await settle();
    expect(codex.threadSettings).toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' });
  });

  it('creates an app without a request body for embedded-browser compatibility', async () => {
    const response = await request(app).get('/api/apps/create').query({ prompt: 'Build a tiny reading list', model: 'sol-medium' });
    expect(response.status).toBe(201);
    createdIds.push(response.body.appId);
    expect(response.body.build.status).toBe('discovering');
  });

  it('persists isolated app storage through the runtime bridge API', async () => {
    const response = await request(app).post('/api/apps').send({ prompt: 'Build a private notes app' });
    const id = response.body.appId; createdIds.push(id);
    await settle();
    const set = await request(app).post(`/api/apps/${id}/storage/set`).send({ key: 'notes', value: ['one'] });
    expect(set.status).toBe(200);
    const get = await request(app).post(`/api/apps/${id}/storage/get`).send({ key: 'notes' });
    expect(get.body).toEqual(['one']);
  });

  it('serves runtimes with the Workshop bridge and opaque-origin CSP', async () => {
    const response = await request(app).get('/runtime/sec');
    expect(response.status).toBe(200);
    expect(response.text).toContain('window.Workshop');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
  });
});

describe('discovery parsing', () => {
  it('accepts a fenced block wrapped in prose and normalizes the questions', () => {
    const parsed = parseDiscovery('Sure!\n```json\n{"name":"Trip Ledger","summary":"Split trip costs.","questions":[{"prompt":"Who settles up?","options":["Everyone","One payer"]},{"id":"cur","prompt":"Currencies?","options":["One","Several","Ask each time","A","B"]}],"plan":["a","b"]}\n```\nHope that helps.');
    expect(parsed.name).toBe('Trip Ledger');
    expect(parsed.questions[0].id).toBe('who-settles-up');
    // Options are capped at four so the deck stays scannable.
    expect(parsed.questions[1].options).toEqual(['One', 'Several', 'Ask each time', 'A']);
  });

  it('accepts a bare object and drops questions without real choices', () => {
    const parsed = parseDiscovery('{"summary":"x","questions":[{"prompt":"Only one?","options":["Yes"]},{"prompt":"Good?","options":["A","B"]}]}');
    expect(parsed.questions).toEqual([{ id: 'good', prompt: 'Good?', options: ['A', 'B'] }]);
  });

  it('returns null when the agent answered with prose only', () => {
    expect(parseDiscovery('I will build you a focus timer.')).toBeNull();
  });
});
