import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { toStrictSchema } from '../src/llmService.js';
import { config } from '../src/config.js';

class FakeCodex extends EventEmitter {
  async diagnostic() { return { available: true, authenticated: true, error: null }; }
  async startThread() { return 'thread-llm'; }
  async resumeThread(id) { return id; }
  async startTurn() { return { turn: { id: 'turn-1' } }; }
  async interrupt() {}
  respond() {}
}

class FakeAppLlm {
  constructor() { this.calls = []; }
  async ask(options) {
    this.calls.push(options);
    return { output: options.schema ? { headline: 'Rain later' } : 'Rain later', sources: [{ title: 'Weather', url: 'https://example.com/w' }], usage: { inputTokens: 10, outputTokens: 4 } };
  }
}

async function installApp(id, actionSource) {
  const dir = path.join(config.appsDir, id);
  await fs.mkdir(path.join(dir, 'actions'), { recursive: true });
  await fs.mkdir(path.join(dir, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(dir, 'actions', 'think.js'), actionSource);
  await fs.writeFile(path.join(dir, 'data.json'), '{}\n');
}

describe('ctx.llm', () => {
  let app; let llm; const id = 'llm-fixture';

  beforeEach(async () => {
    llm = new FakeAppLlm();
    app = createApp({ codex: new FakeCodex(), llmService: null, appLlm: llm });
    await app.ready();
  });

  afterEach(async () => { await fs.rm(path.join(config.appsDir, id), { recursive: true, force: true }); });

  it('gives actions a model call that returns output, sources, and usage', async () => {
    await installApp(id, `export async function handler(input, ctx) {
      const result = await ctx.llm.ask({ prompt: 'Weather in ' + input.city, schema: { type: 'object', properties: { headline: { type: 'string' } } } });
      return { headline: result.output.headline, sources: result.sources, spent: result.usage.outputTokens };
    }`);

    const response = await request(app).post(`/api/apps/${id}/actions/think`).send({ payload: { city: 'Montreal' } });
    expect(response.status).toBe(200);
    expect(response.body.output).toEqual({ headline: 'Rain later', sources: [{ title: 'Weather', url: 'https://example.com/w' }], spent: 4 });
    // Search stays on unless the action opts out, so apps can answer about the world.
    expect(llm.calls[0].search).toBeUndefined();
    expect(llm.calls[0].prompt).toBe('Weather in Montreal');
  });

  it('passes search: false through for prompts built from user data', async () => {
    await installApp(id, `export async function handler(input, ctx) {
      await ctx.llm.ask({ prompt: 'Summarize ' + input.text, search: false });
      return { ok: true };
    }`);
    await request(app).post(`/api/apps/${id}/actions/think`).send({ payload: { text: 'my private notes' } });
    expect(llm.calls[0].search).toBe(false);
  });

  it('caps runaway loops at the per-action call limit', async () => {
    await installApp(id, `export async function handler(input, ctx) {
      for (let i = 0; i < 50; i += 1) await ctx.llm.ask({ prompt: 'again' });
      return { ok: true };
    }`);
    const response = await request(app).post(`/api/apps/${id}/actions/think`).send({ payload: {} });
    expect(response.status).toBe(502);
    expect(response.body.error).toContain('at most 8 model calls');
    expect(llm.calls).toHaveLength(config.llmMaxCallsPerAction);
  });

  it('explains itself when no model is configured', async () => {
    const bare = createApp({ codex: new FakeCodex(), llmService: null, appLlm: null });
    await bare.ready();
    await installApp(id, `export async function handler(input, ctx) { return ctx.llm.ask({ prompt: 'hi' }); }`);
    const response = await request(bare).post(`/api/apps/${id}/actions/think`).send({ payload: {} });
    expect(response.body.error).toContain('OPENAI_API_KEY');
  });
});

describe('toStrictSchema', () => {
  it('forbids extra keys and requires every property, at every depth', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' } } } } },
    });
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(['items']);
    expect(strict.properties.items.items.required).toEqual(['name', 'qty']);
    expect(strict.properties.items.items.additionalProperties).toBe(false);
  });

  it('leaves leaf schemas and unions intact', () => {
    expect(toStrictSchema({ type: 'string' })).toEqual({ type: 'string' });
    const union = toStrictSchema({ anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }] });
    expect(union.anyOf[0].required).toEqual(['a']);
    expect(union.anyOf[1]).toEqual({ type: 'null' });
  });
});
