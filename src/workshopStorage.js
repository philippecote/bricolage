import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { assertSafeId, randomId } from './utils.js';

export const APP_STATES = ['draft', 'building', 'ready', 'failed', 'archived'];

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().min(1).max(64),
  description: z.string().max(240).default(''),
  icon: z.string().max(8).default('✦'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#635bff'),
  status: z.enum(APP_STATES).default('draft'),
  prompt: z.string().max(10_000).default(''),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  window: z.object({ width: z.number().min(360).max(1600), height: z.number().min(300).max(1200) }).default({ width: 920, height: 680 }),
  actions: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).default([]),
  threadId: z.string().nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
  model: z.enum(['luna-high', 'luna-max', 'sol-medium']).default('luna-high'),
  error: z.string().nullable().default(null),
});

function appDir(appId) {
  assertSafeId(appId, 'appId');
  return path.join(config.appsDir, appId);
}

function manifestPath(appId) {
  return path.join(appDir(appId), 'manifest.json');
}

export async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomId()}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

export function slugify(value) {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'new-app';
  return `${base}-${randomId().slice(0, 5)}`;
}

export function titleFromPrompt(prompt) {
  const cleaned = prompt.replace(/^(please\s+)?(make|build|create)\s+(me\s+)?(an?\s+)?/i, '').trim();
  return cleaned.split(/\s+/).slice(0, 4).join(' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 48) || 'New App';
}

export async function ensureWorkshopStorage() {
  await Promise.all([fs.mkdir(config.appsDir, { recursive: true }), fs.mkdir(config.workshopDir, { recursive: true })]);
}

export async function listApps({ includeArchived = false } = {}) {
  await ensureWorkshopStorage();
  const entries = await fs.readdir(config.appsDir, { withFileTypes: true });
  const apps = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const app = await readManifest(entry.name);
      if (includeArchived || !app.archived) apps.push(app);
    } catch {
      // Ignore incomplete workspaces until their manifest is valid.
    }
  }
  return apps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readManifest(appId) {
  const raw = JSON.parse(await fs.readFile(manifestPath(appId), 'utf8'));
  return manifestSchema.parse(raw);
}

export async function writeManifest(appId, patch) {
  let current = null;
  try { current = await readManifest(appId); } catch { /* new app */ }
  const next = manifestSchema.parse({ ...current, ...patch, id: appId, updatedAt: new Date().toISOString() });
  await atomicWrite(manifestPath(appId), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function createWorkspace(prompt, model = 'luna-high') {
  const name = titleFromPrompt(prompt);
  const id = slugify(name);
  const now = new Date().toISOString();
  const accentChoices = ['#6d5dfc', '#007aff', '#e45d3f', '#008f75', '#b14bc9'];
  const manifest = await writeManifest(id, {
    id, name, description: 'Taking shape in Workshop', icon: ['✦', '◉', '◆', '✺'][Math.floor(Math.random() * 4)],
    accent: accentChoices[Math.floor(Math.random() * accentChoices.length)], status: 'building', prompt,
    pinned: false, archived: false, createdAt: now, updatedAt: now, actions: [], threadId: null, revision: 0, model, error: null,
  });
  await Promise.all([
    fs.mkdir(path.join(appDir(id), 'runtime'), { recursive: true }),
    fs.mkdir(path.join(appDir(id), 'actions'), { recursive: true }),
    fs.mkdir(path.join(appDir(id), '.workshop', 'revisions'), { recursive: true }),
    atomicWrite(path.join(appDir(id), 'data.json'), '{}\n'),
    atomicWrite(path.join(appDir(id), 'AGENTS.md'), AGENT_CONTRACT),
    installBuilderSkill(id),
    atomicWrite(path.join(appDir(id), 'runtime', 'index.html'), provisionalHtml(name, manifest.accent)),
  ]);
  return manifest;
}

export async function updateApp(appId, patch) {
  const allowed = {};
  for (const key of ['name', 'pinned', 'archived', 'model']) if (key in patch) allowed[key] = patch[key];
  if ('archived' in allowed) allowed.status = allowed.archived ? 'archived' : 'ready';
  return writeManifest(appId, allowed);
}

export async function duplicateApp(appId) {
  const source = await readManifest(appId);
  const copy = await createWorkspace(`Duplicate ${source.name}`, source.model);
  await fs.cp(path.join(appDir(appId), 'runtime'), path.join(appDir(copy.id), 'runtime'), { recursive: true, force: true });
  await fs.cp(path.join(appDir(appId), 'actions'), path.join(appDir(copy.id), 'actions'), { recursive: true, force: true });
  return writeManifest(copy.id, { name: `${source.name} Copy`, description: source.description, icon: source.icon, accent: source.accent, status: 'ready', actions: source.actions });
}

export async function validateWorkspace(appId) {
  const manifest = await readManifest(appId);
  const runtimePath = path.join(appDir(appId), 'runtime', 'index.html');
  const stat = await fs.stat(runtimePath);
  if (stat.size > config.maxRuntimeAssetBytes) throw new Error('Runtime index.html is too large.');
  const html = await fs.readFile(runtimePath, 'utf8');
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) throw new Error('Runtime must be a complete HTML document.');
  for (const action of manifest.actions) {
    const source = await fs.readFile(path.join(appDir(appId), 'actions', `${action}.js`), 'utf8');
    if (!/handler\s*\(/.test(source)) throw new Error(`Action ${action} must export handler(input, ctx).`);
  }
  return manifest;
}

export async function createRevision(appId) {
  const manifest = await readManifest(appId);
  const revision = manifest.revision + 1;
  const target = path.join(appDir(appId), '.workshop', 'revisions', String(revision));
  await fs.mkdir(target, { recursive: true });
  await Promise.all([
    fs.cp(path.join(appDir(appId), 'runtime'), path.join(target, 'runtime'), { recursive: true, force: true }),
    fs.cp(path.join(appDir(appId), 'actions'), path.join(target, 'actions'), { recursive: true, force: true }),
  ]);
  await atomicWrite(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return writeManifest(appId, { revision, status: 'ready', error: null });
}

export async function listRevisions(appId) {
  const dir = path.join(appDir(appId), '.workshop', 'revisions');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => Number(e.name)).sort((a, b) => b - a);
  } catch { return []; }
}

export async function rollbackApp(appId, revision) {
  const source = path.join(appDir(appId), '.workshop', 'revisions', String(revision));
  await fs.access(source);
  await fs.cp(path.join(source, 'runtime'), path.join(appDir(appId), 'runtime'), { recursive: true, force: true });
  await fs.cp(path.join(source, 'actions'), path.join(appDir(appId), 'actions'), { recursive: true, force: true });
  const snapshot = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  return writeManifest(appId, { ...snapshot, revision, status: 'ready', archived: false, error: null });
}

export function getAppDir(appId) { return appDir(appId); }
export function getRuntimePath(appId, relative = 'index.html') {
  assertSafeId(appId, 'appId');
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) throw new Error('Invalid runtime asset path.');
  return path.join(appDir(appId), 'runtime', relative);
}
export function getAppActionPath(appId, action) { assertSafeId(action, 'action'); return path.join(appDir(appId), 'actions', `${action}.js`); }
export function getAppDataPath(appId) { return path.join(appDir(appId), 'data.json'); }
export async function ensureAgentContract(appId) {
  await Promise.all([atomicWrite(path.join(appDir(appId), 'AGENTS.md'), AGENT_CONTRACT), installBuilderSkill(appId)]);
}

async function installBuilderSkill(appId) {
  const source = path.join(config.rootDir, 'skills', 'workshop-app-builder', 'SKILL.md');
  const target = path.join(appDir(appId), '.codex', 'skills', 'workshop-app-builder', 'SKILL.md');
  await atomicWrite(target, await fs.readFile(source, 'utf8'));
}

const AGENT_CONTRACT = `# Workshop app contract

Build a polished, dependency-free mini-app. You may only edit files in this workspace.

Load and follow the workshop-app-builder skill in .codex/skills/workshop-app-builder/SKILL.md. A new app begins with a shaping turn that returns the skill's JSON brief and writes nothing; the build request that follows carries the person's answers.

- Write the complete app to runtime/index.html with inline CSS and JavaScript.
- Update manifest.json without changing id, createdAt, threadId, revision, or status.
- Use window.Workshop.callAction(name, payload), notify(message), setTitle(title), and storage.get/set.
- For server work, add actions/<name>.js exporting async function handler(input, ctx), then list the action in manifest.actions.
- ctx.fetch(url, options) reaches public HTTPS APIs; ctx.storage.get/set provide durable JSON state.
- Never install dependencies, run a dev server, embed secrets, or access files outside this workspace.
- Design for a 900x650 window, include loading/error/empty states, and use semantic accessible HTML.
`;

function provisionalHtml(name, accent) {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f1;color:#252525;font:15px -apple-system,BlinkMacSystemFont,sans-serif}.mark{width:54px;height:54px;border-radius:16px;background:${accent};display:grid;place-items:center;color:white;font-size:24px;box-shadow:0 14px 32px #0002}.wrap{text-align:center;animation:in .5s ease both}h1{font-size:20px;margin:18px 0 6px}p{color:#777;margin:0}@keyframes in{from{opacity:0;transform:translateY(8px)}}</style></head><body><main class="wrap"><div class="mark">✦</div><h1>${escapeHtml(name)}</h1><p>Workshop is shaping this app…</p></main></body></html>`;
}

function escapeHtml(value) { return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
