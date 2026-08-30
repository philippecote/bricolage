import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

class MockLlmService {
  constructor() {
    this.generateHtmlCalls = 0;
    this.generateActionCodeCalls = 0;
    this.repairActionCodeCalls = 0;
  }

  async generateHtml({ appId }) {
    this.generateHtmlCalls += 1;
    return `<!doctype html><html><body><h1>${appId}</h1></body></html>`;
  }

  async generateActionCode({ action }) {
    this.generateActionCodeCalls += 1;
    return [
      'export async function handler(input, ctx) {',
      `  console.log('action:${action}');`,
      '  return { ok: true, input, requestId: ctx.requestId };',
      '}',
    ].join('\n');
  }

  async repairActionCode() {
    this.repairActionCodeCalls += 1;
    return 'export async function handler() { return { repaired: true }; }';
  }
}

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

describe('DOM terminal MVP API', () => {
  let llm;
  let app;

  beforeEach(async () => {
    llm = new MockLlmService();
    app = createApp({ llmService: llm });
    await app.ready();

    await removeIfExists(path.join(config.specsDir, 'testapp.md'));
    await removeIfExists(path.join(config.actionsDir, 'testapp'));
  });

  afterEach(async () => {
    await removeIfExists(path.join(config.specsDir, 'testapp.md'));
    await removeIfExists(path.join(config.actionsDir, 'testapp'));
  });

  it('returns health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('saves and loads specs', async () => {
    const markdown = '# Test App\n\n- item';

    const save = await request(app)
      .post('/spec/testapp')
      .send({ content: markdown })
      .set('content-type', 'application/json');

    expect(save.status).toBe(200);
    expect(save.body.status).toBe('saved');

    const load = await request(app).get('/spec/testapp');
    expect(load.status).toBe(200);
    expect(load.text).toBe(markdown);
  });

  it('renders HTML with LLM service', async () => {
    await request(app)
      .post('/spec/testapp')
      .send({ content: '# Render App' })
      .set('content-type', 'application/json');

    const response = await request(app)
      .post('/render/testapp')
      .send({})
      .set('content-type', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body.html).toContain('<!doctype html>');
    expect(llm.generateHtmlCalls).toBe(1);
  });

  it('generates action code on first call and reuses cache on second call', async () => {
    await request(app)
      .post('/spec/testapp')
      .send({ content: '# Action App\n\nAction: echo' })
      .set('content-type', 'application/json');

    const first = await request(app)
      .post('/action/testapp/echo')
      .send({ payload: { message: 'first' } })
      .set('content-type', 'application/json');

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ok');
    expect(first.body.meta.cacheStatus).toBe('generated');
    expect(first.body.output.input).toEqual({ message: 'first' });

    const actionPath = path.join(config.actionsDir, 'testapp', 'echo.js');
    const persistedCode = await fs.readFile(actionPath, 'utf8');
    expect(persistedCode).toContain('export async function handler');

    const second = await request(app)
      .post('/action/testapp/echo')
      .send({ payload: { message: 'second' } })
      .set('content-type', 'application/json');

    expect(second.status).toBe(200);
    expect(second.body.status).toBe('ok');
    expect(second.body.meta.cacheStatus).toBe('hit');
    expect(second.body.output.input).toEqual({ message: 'second' });
    expect(llm.generateActionCodeCalls).toBe(1);
    expect(llm.repairActionCodeCalls).toBe(0);
  });
});
