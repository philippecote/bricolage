import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { OpenAiLlmService } from './llmService.js';
import { CodexAppServer } from './codexAppServer.js';
import { BuildService, DEFAULT_MODEL, MODEL_KEYS, publicBuild } from './buildService.js';
import { executeAction } from './sandbox.js';
import { safeFetch } from './network.js';
import { ensureStorage, hasActionCode, readActionCode, readSpec, writeActionCode, writeSpec } from './storage.js';
import {
  atomicWrite, createRevision, duplicateApp, ensureAgentContract, ensureWorkshopStorage, getAppActionPath, getAppDataPath,
  getRuntimePath, listApps, listRevisions, readManifest, rollbackApp, updateApp, validateWorkspace, writeManifest,
} from './workshopStorage.js';
import { assertSafeId, randomId, sha256 } from './utils.js';

const modelSchema = z.enum(MODEL_KEYS).default(DEFAULT_MODEL);
const createAppSchema = z.object({ prompt: z.string().trim().min(3).max(10_000), model: modelSchema });
const messageSchema = z.object({ prompt: z.string().trim().min(1).max(10_000), model: modelSchema });
const answerSchema = z.object({ answers: z.record(z.string(), z.string().trim().min(1).max(120)) });
const actionSchema = z.object({ payload: z.unknown().optional() });
const patchAppSchema = z.object({ name: z.string().trim().min(1).max(64).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), model: modelSchema.optional() });

function normalizeError(error) { return error instanceof Error ? error : new Error(String(error)); }
function parse(schema, body) { const result = schema.safeParse(body); if (!result.success) { const error = new Error(result.error.issues[0]?.message || 'Invalid request.'); error.statusCode = 400; throw error; } return result.data; }
function errorPayload(req, error, reason = 'request_failed') { return { status: 'error', error: normalizeError(error).message, reason, requestId: req.requestId }; }
function escapeHtml(value) { return String(value).replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]); }
function sendFormPayload(res, status, payload) { res.status(status).type('html').send(`<pre>${escapeHtml(JSON.stringify(payload))}</pre>`); }
function optionalLlm() { if (!config.openaiApiKey) return null; try { return new OpenAiLlmService(); } catch { return null; } }

export function createApp({ llmService = optionalLlm(), codex = new CodexAppServer(), buildService = null } = {}) {
  const builds = buildService || new BuildService({ codex });
  const app = express();
  app.disable('x-powered-by');
  // Trace before body parsing so a stalled/blocked request is visible.
  // Query values are intentionally omitted because create requests carry the prompt.
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/apps') || req.path === '/workshop/build') {
      console.log(JSON.stringify({ trace: 'request:start', method: req.method, path: req.path, queryKeys: Object.keys(req.query || {}), contentLength: req.header('content-length') || null, contentType: req.header('content-type') || null, at: Date.now() }));
    }
    next();
  });
  app.use(express.json({ limit: config.maxPayloadBytes }));
  app.use(express.urlencoded({ extended: false, limit: config.maxPayloadBytes }));
  app.use((req, res, next) => {
    req.requestId = req.header('x-request-id') || randomId(); req.startedAt = Date.now();
    res.setHeader('x-request-id', req.requestId);
    res.on('finish', () => console.log(JSON.stringify({ trace: 'request:finish', requestId: req.requestId, method: req.method, path: req.path, statusCode: res.statusCode, durationMs: Date.now() - req.startedAt })));
    next();
  });
  app.use((req, res, next) => {
    if (!config.apiToken || (!req.path.startsWith('/api/') && !req.path.startsWith('/spec/') && !req.path.startsWith('/render/') && !req.path.startsWith('/action/'))) return next();
    const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/, '');
    if ((bearer || req.header('x-api-token')) !== config.apiToken) return res.status(401).json(errorPayload(req, new Error('Unauthorized'), 'unauthorized'));
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/system/status', async (_req, res) => {
    await builds.ready?.();
    const diagnostic = await Promise.race([codex.diagnostic(), new Promise((resolve) => setTimeout(() => resolve({ available: false, authenticated: false, error: 'Codex diagnostic timed out.' }), 2500))]);
    res.json({ name: 'Workshop', version: '1.0.0', codex: diagnostic, activeBuilds: builds.listActive() });
  });
  app.get('/api/apps', async (req, res, next) => { try { res.json({ apps: await listApps({ includeArchived: req.query.archived === 'true' }) }); } catch (e) { next(e); } });
  // Neutral browser compatibility alias. Some embedded browsers block requests
  // whose URL advertises a mutating action; this keeps the normal POST contract
  // intact while giving the local UI a browser-native fallback.
  app.post('/workshop/build', async (req, res, next) => {
    try {
      const input = parse(createAppSchema, req.body);
      console.log(JSON.stringify({ trace: 'create:route', transport: 'FORM-POST', promptChars: input.prompt.length, model: input.model }));
      console.log(JSON.stringify({ trace: 'create:build:start', transport: 'FORM-POST' }));
      const result = await builds.create(input.prompt, input.model);
      console.log(JSON.stringify({ trace: 'create:build:done', transport: 'FORM-POST', appId: result.app.id, buildId: result.build.id }));
      // This endpoint is used by the browser-native fallback. Returning an
      // HTML <pre> keeps the payload readable inside an iframe across Chromium
      // JSON viewers; the normal JSON API remains available at /api/apps.
      sendFormPayload(res, 201, { appId: result.app.id, buildId: result.build.id, app: result.app, build: result.build });
    } catch (e) { next(e); }
  });
  app.get('/api/apps/create', async (req, res, next) => {
    try {
      const encodedPrompt = req.header('x-workshop-prompt');
      const prompt = typeof req.query.prompt === 'string' ? req.query.prompt : encodedPrompt ? decodeURIComponent(encodedPrompt) : '';
      const model = typeof req.query.model === 'string' ? req.query.model : req.header('x-workshop-model') || undefined;
      const input = parse(createAppSchema, { prompt, model });
      console.log(JSON.stringify({ trace: 'create:route', transport: 'GET', promptChars: input.prompt.length, model: input.model }));
      console.log(JSON.stringify({ trace: 'create:build:start', transport: 'GET' }));
      const result = await builds.create(input.prompt, input.model);
      console.log(JSON.stringify({ trace: 'create:build:done', transport: 'GET', appId: result.app.id, buildId: result.build.id }));
      res.status(201).json({ appId: result.app.id, buildId: result.build.id, app: result.app, build: result.build });
    } catch (e) { next(e); }
  });
  app.get('/api/apps/:appId', async (req, res, next) => { try { const appData = await readManifest(req.params.appId); const latest = builds.latestForApp(req.params.appId); res.json({ app: appData, revisions: await listRevisions(req.params.appId), latestBuild: latest ? publicBuild(latest) : null }); } catch (e) { e.statusCode = e.code === 'ENOENT' ? 404 : 400; next(e); } });
  app.post('/api/apps', async (req, res, next) => {
    try {
      const { prompt, model } = parse(createAppSchema, { ...req.query, ...req.body });
      console.log(JSON.stringify({ trace: 'create:route', transport: 'POST', promptChars: prompt.length, model }));
      console.log(JSON.stringify({ trace: 'create:build:start', transport: 'POST' }));
      const result = await builds.create(prompt, model);
      console.log(JSON.stringify({ trace: 'create:build:done', transport: 'POST', appId: result.app.id, buildId: result.build.id }));
      res.status(202).json({ appId: result.app.id, buildId: result.build.id, app: result.app, build: result.build });
    } catch (e) { next(e); }
  });
  app.patch('/api/apps/:appId', async (req, res, next) => { try { res.json({ app: await updateApp(req.params.appId, parse(patchAppSchema, req.body)) }); } catch (e) { next(e); } });
  app.post('/api/apps/:appId/duplicate', async (req, res, next) => { try { res.status(201).json({ app: await duplicateApp(req.params.appId) }); } catch (e) { next(e); } });
  app.post('/api/apps/:appId/messages', async (req, res, next) => { try { const { prompt, model } = parse(messageSchema, req.body); const build = await builds.edit(req.params.appId, prompt, model); res.status(202).json({ buildId: build.id, build }); } catch (e) { next(e); } });
  app.post('/api/apps/:appId/revisions/:revision/restore', async (req, res, next) => { try { res.json({ app: await rollbackApp(req.params.appId, Number(req.params.revision)) }); } catch (e) { next(e); } });

  app.get('/api/builds/:buildId/events', (req, res) => {
    const build = builds.get(req.params.buildId);
    if (!build) return res.status(404).json(errorPayload(req, new Error('Build not found.'), 'not_found'));
    res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-cache'); res.setHeader('connection', 'keep-alive'); res.flushHeaders?.();
    const send = (event) => res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    build.events.forEach(send);
    const listener = (event) => send(event); builds.on(`build:${build.id}`, listener);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => { clearInterval(heartbeat); builds.off(`build:${build.id}`, listener); });
  });
  app.post('/api/builds/:buildId/cancel', async (req, res, next) => { try { res.json({ build: await builds.cancel(req.params.buildId) }); } catch (e) { next(e); } });
  app.post('/api/builds/:buildId/answers', async (req, res, next) => { try { const { answers } = parse(answerSchema, req.body); res.json({ build: await builds.answer(req.params.buildId, answers) }); } catch (e) { next(e); } });
  app.post('/api/approvals/:approvalId', (req, res, next) => { try { builds.approve(req.params.approvalId, req.body?.accepted === true); res.json({ status: 'ok' }); } catch (e) { next(e); } });

  app.get('/runtime/:appId', async (req, res, next) => {
    try {
      const html = await fs.readFile(getRuntimePath(req.params.appId), 'utf8');
      const bridge = `<script>${runtimeBridge(req.params.appId)}</script>`;
      const output = html.includes('</head>') ? html.replace('</head>', `${bridge}</head>`) : bridge + html;
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'");
      res.type('html').send(output);
    } catch (e) { e.statusCode = e.code === 'ENOENT' ? 404 : 400; next(e); }
  });
  app.get('/runtime/:appId/*asset', async (req, res, next) => { try { const asset = Array.isArray(req.params.asset) ? req.params.asset.join('/') : req.params.asset; res.sendFile(getRuntimePath(req.params.appId, asset)); } catch (e) { next(e); } });
  app.post('/api/apps/:appId/actions/:action', async (req, res, next) => {
    try {
      assertSafeId(req.params.appId, 'appId'); assertSafeId(req.params.action, 'action');
      const { payload } = parse(actionSchema, req.body || {});
      const code = await fs.readFile(getAppActionPath(req.params.appId, req.params.action), 'utf8');
      const storage = createAppStorage(req.params.appId);
      const started = Date.now();
      const result = await executeAction({ code, input: payload ?? {}, ctx: { appId: req.params.appId, action: req.params.action, requestId: req.requestId, nowIso: new Date().toISOString(), fetch: safeFetch, storage }, fetchFn: safeFetch, timeoutMs: config.actionTimeoutMs });
      res.json({ status: 'ok', output: result.output, logs: result.logs, codeHash: sha256(code), meta: { durationMs: Date.now() - started } });
    } catch (e) { e.statusCode ||= 502; next(e); }
  });
  app.post('/api/apps/:appId/storage/get', async (req, res, next) => {
    try { const result = await createAppStorage(req.params.appId).get(req.body?.key ?? null); res.json(result); } catch (e) { next(e); }
  });
  app.post('/api/apps/:appId/storage/set', async (req, res, next) => {
    try { const result = await createAppStorage(req.params.appId).set(req.body?.key, req.body?.value); res.json(result); } catch (e) { next(e); }
  });

  // Legacy compatibility during migration.
  app.get('/spec/:appId', async (req, res, next) => { try { res.type('text/markdown').send(await readSpec(req.params.appId)); } catch (e) { e.statusCode = 404; next(e); } });
  app.post('/spec/:appId', async (req, res, next) => { try { const content = z.string().parse(req.body?.content); res.json({ status: 'saved', bytes: await writeSpec(req.params.appId, content) }); } catch (e) { e.statusCode = 400; next(e); } });
  app.post('/render/:appId', async (req, res, next) => { try { if (!llmService) throw new Error('Legacy OpenAI rendering is not configured.'); res.json({ html: await llmService.generateHtml({ appId: req.params.appId, spec: await readSpec(req.params.appId) }) }); } catch (e) { e.statusCode ||= 502; next(e); } });
  app.post('/action/:appId/:action', async (req, res, next) => {
    try {
      const spec = await readSpec(req.params.appId); let code; let cacheStatus = 'hit';
      if (await hasActionCode(req.params.appId, req.params.action)) code = await readActionCode(req.params.appId, req.params.action);
      else { if (!llmService) throw new Error('Legacy action generation is not configured.'); code = await llmService.generateActionCode({ appId: req.params.appId, action: req.params.action, spec, payload: req.body?.payload }); await writeActionCode(req.params.appId, req.params.action, code); cacheStatus = 'generated'; }
      const result = await executeAction({ code, input: req.body?.payload || {}, ctx: { appId: req.params.appId, action: req.params.action, requestId: req.requestId }, timeoutMs: config.actionTimeoutMs });
      res.json({ status: 'ok', output: result.output, logs: result.logs, codeHash: sha256(code), meta: { cacheStatus, repairAttempts: 0, durationMs: Date.now() - req.startedAt } });
    } catch (e) { e.statusCode ||= 502; next(e); }
  });

  app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html') res.setHeader('cache-control', 'no-store');
    next();
  });
  app.use(express.static(config.publicDir));
  app.get(/.*/, (_req, res) => { res.setHeader('cache-control', 'no-store'); res.sendFile(path.join(config.publicDir, 'index.html')); });
  app.use((error, req, res, _next) => {
    const status = error.statusCode || 500;
    const payload = errorPayload(req, error, status === 404 ? 'not_found' : 'request_failed');
    if (req.method === 'POST' && req.path === '/workshop/build') return sendFormPayload(res, status, payload);
    res.status(status).json(payload);
  });
  app.ready = async () => {
    await Promise.all([ensureStorage(), ensureWorkshopStorage(), builds.ready?.()]);
    await migrateStarters();
    const existingApps = await listApps({ includeArchived: true });
    await Promise.all(existingApps.map((item) => ensureAgentContract(item.id)));
  };
  return app;
}

function createAppStorage(appId) {
  return {
    async get(key = null) { const data = JSON.parse(await fs.readFile(getAppDataPath(appId), 'utf8')); return key == null ? data : data[key]; },
    async set(key, value) { if (typeof key !== 'string' || key.length > 128) throw new Error('Invalid storage key.'); const file = getAppDataPath(appId); const data = JSON.parse(await fs.readFile(file, 'utf8')); data[key] = value; await atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`); return value; },
  };
}

function runtimeBridge(appId) {
  return `(function(){let n=0;const p=new Map();window.Workshop={callAction:(name,payload)=>call('action',{name,payload}),notify:(message)=>call('notify',{message}),setTitle:(title)=>call('title',{title}),openLink:(url)=>call('link',{url}),storage:{get:(key)=>call('storage.get',{key}),set:(key,value)=>call('storage.set',{key,value})}};function call(type,payload){const id=++n;parent.postMessage({source:'workshop-app',appId:${JSON.stringify(appId)},id,type,payload},'*');return new Promise((resolve,reject)=>p.set(id,{resolve,reject}))}addEventListener('message',e=>{const m=e.data;if(!m||m.source!=='workshop-host'||!p.has(m.id))return;const q=p.get(m.id);p.delete(m.id);m.error?q.reject(new Error(m.error)):q.resolve(m.result)})})();`;
}

async function migrateStarters() {
  const now = new Date().toISOString();
  try { await readManifest('sec'); }
  catch {
    const actionSource = await fs.readFile(path.join(config.rootDir, 'actions', 'sec', 'search_filings.js'), 'utf8').catch(() => 'export async function handler(input){ return { ticker: input.ticker || "AAPL", filings: [] }; }');
    const dir = path.join(config.appsDir, 'sec');
    await fs.mkdir(path.join(dir, 'runtime'), { recursive: true }); await fs.mkdir(path.join(dir, 'actions'), { recursive: true }); await fs.mkdir(path.join(dir, '.workshop', 'revisions'), { recursive: true });
    await atomicWrite(path.join(dir, 'actions', 'search_filings.js'), actionSource); await atomicWrite(path.join(dir, 'data.json'), '{}\n');
    await writeManifest('sec', { id: 'sec', name: 'Filing Desk', description: 'Recent SEC filings by ticker', icon: '⌁', accent: '#18796f', status: 'ready', prompt: 'Explore recent SEC filings', pinned: true, archived: false, createdAt: now, updatedAt: now, actions: ['search_filings'], threadId: null, revision: 0, error: null });
    await atomicWrite(path.join(dir, 'runtime', 'index.html'), SEC_RUNTIME);
    await validateWorkspace('sec'); await createRevision('sec');
  }
  await ensureAgentContract('sec');
  try { await readManifest('tic-tac-toe'); }
  catch {
    const dir = path.join(config.appsDir, 'tic-tac-toe');
    await fs.mkdir(path.join(dir, 'runtime'), { recursive: true }); await fs.mkdir(path.join(dir, 'actions'), { recursive: true }); await fs.mkdir(path.join(dir, '.workshop', 'revisions'), { recursive: true });
    await atomicWrite(path.join(dir, 'data.json'), '{}\n');
    await writeManifest('tic-tac-toe', { id: 'tic-tac-toe', name: 'Tic-Tac-Toe', description: 'Draft game idea', icon: '×', accent: '#de684a', status: 'draft', prompt: 'A tic tac toe game', pinned: false, archived: false, createdAt: now, updatedAt: now, actions: [], threadId: null, revision: 0, error: null });
    await atomicWrite(path.join(dir, 'runtime', 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><style>body{display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f1ec;font:15px -apple-system;color:#39322f}.draft{text-align:center}.mark{font-size:52px;color:#de684a}h1{margin:8px 0}p{color:#817671}</style></head><body><main class="draft"><div class="mark">× ○</div><h1>Tic-Tac-Toe</h1><p>A draft waiting for your direction.</p></main></body></html>');
  }
  await ensureAgentContract('tic-tac-toe');
}

const SEC_RUNTIME = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#f6f7f4;color:#18201e;font:15px -apple-system,BlinkMacSystemFont,sans-serif}.shell{max-width:780px;margin:auto;padding:54px 32px}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #d9deda;padding-bottom:24px}h1{font-size:32px;letter-spacing:-1.2px;margin:0}header p{color:#6c7471;margin:7px 0 0}.badge{font-size:12px;color:#18796f;background:#dff0eb;padding:7px 10px;border-radius:999px}form{display:flex;gap:10px;margin:34px 0}input{flex:1;border:1px solid #cdd4d0;border-radius:12px;padding:13px 15px;background:white;font:inherit;outline:none}input:focus{border-color:#18796f;box-shadow:0 0 0 3px #18796f20}button{border:0;border-radius:12px;padding:0 18px;color:white;background:#18796f;font-weight:600;cursor:pointer}.empty{padding:70px 0;text-align:center;color:#7a827f}.row{display:grid;grid-template-columns:80px 1fr auto;padding:15px 2px;border-bottom:1px solid #e0e3df}.form{font-weight:650}.date,.accession{color:#727a77}.error{color:#a3352b}</style></head><body><main class="shell"><header><div><h1>Filing Desk</h1><p>Search recent company filings from the SEC.</p></div><span class="badge">Public data</span></header><form id="search"><input id="ticker" aria-label="Ticker" placeholder="Ticker, e.g. AAPL" maxlength="10"><button>Search</button></form><section id="results" class="empty">Enter a ticker to begin.</section></main><script>const form=document.querySelector('#search'),results=document.querySelector('#results');form.addEventListener('submit',async e=>{e.preventDefault();const ticker=document.querySelector('#ticker').value.trim();if(!ticker)return;results.className='empty';results.textContent='Finding filings…';try{const r=await Workshop.callAction('search_filings',{ticker});const filings=r.output?.filings||r.filings||[];if(!filings.length){results.textContent='No recent filings found.';return}results.className='';results.innerHTML=filings.slice(0,30).map(f=>\`<div class="row"><span class="form">\${f.form}</span><span class="accession">\${f.accession}</span><time class="date">\${f.filedAt}</time></div>\`).join('')}catch(err){results.className='empty error';results.textContent=err.message}})</script></body></html>`;
