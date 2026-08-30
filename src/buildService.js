import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { randomId } from './utils.js';
import { atomicWrite, createRevision, createWorkspace, getAppDir, readManifest, validateWorkspace, writeManifest } from './workshopStorage.js';

const BUILD_STATES = ['discovering', 'awaiting_input', 'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'];
// Each preset names the agent that runs it. Codex and Claude Code speak the same
// notification vocabulary, so nothing below this map knows which one is working.
const MODEL_PRESETS = {
  'luna-high': { label: 'Luna · High', agent: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
  'luna-max': { label: 'Luna · Max', agent: 'codex', model: 'gpt-5.6-luna', effort: 'max' },
  'sol-medium': { label: 'Sol · Medium', agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
  'opus-5-high': { label: 'Opus 5 · High', agent: 'claude', model: 'claude-opus-5', effort: 'high' },
};
export const MODEL_KEYS = Object.keys(MODEL_PRESETS);
export const DEFAULT_MODEL = 'luna-high';
export const CATEGORIES = ['utilities', 'productivity', 'creativity', 'games', 'information', 'data', 'wellbeing', 'other'];

export class BuildService extends EventEmitter {
  constructor({ codex, claude = null, agents = null, mcp = null }) {
    super();
    this.mcp = mcp;
    this.agents = agents || { ...(codex ? { codex } : {}), ...(claude ? { claude } : {}) };
    this.codex = this.agents.codex;
    this.builds = new Map();
    this.approvals = new Map();
    this.watchers = new Map();
    this.initializing = this.hydrate();
    // Thread ids are minted per agent and never collide, so one handler can
    // route notifications from every backend by thread alone.
    for (const agent of Object.values(this.agents)) agent?.on?.('notification', (message) => this.onCodexNotification(message));
  }

  agentFor(model) {
    const preset = requirePreset(model);
    const agent = this.agents[preset.agent];
    if (!agent) throw new Error(`${preset.label} needs the ${preset.agent} agent, which is not available.`);
    return agent;
  }

  async ready() { await this.initializing; }
  listActive() { return [...this.builds.values()].filter((build) => !['completed', 'failed', 'cancelled'].includes(build.status)).map(publicBuild); }
  get(buildId) { return this.builds.get(buildId); }
  latestForApp(appId) { return [...this.builds.values()].filter((build) => build.appId === appId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null; }

  async create(prompt, model = DEFAULT_MODEL) {
    await this.ready();
    const preset = requirePreset(model);
    const app = await createWorkspace(prompt, model);
    const build = this.newBuild(app.id, prompt, null, model, 'create');
    build.stage = 'discovery';
    build.status = 'discovering';
    this.push(build, 'discovering', 'Reading your idea and thinking about what to ask');
    // Discovery is a real Codex turn, so it must not block the create response.
    queueMicrotask(() => this.runDiscovery(build).catch((error) => this.fail(build, error)));
    return { app, build: publicBuild(build), preset };
  }

  // No model means "keep using whatever this app was built with". Defaulting to
  // the global preset here silently reset an app's remembered choice on any edit
  // that did not happen to name one.
  async edit(appId, prompt, model = null) {
    await this.ready();
    const app = await readManifest(appId);
    const chosen = model || app.model || DEFAULT_MODEL;
    requirePreset(chosen);
    await writeManifest(appId, { status: 'building', error: null, model: chosen });
    const build = this.newBuild(appId, prompt, app.threadId, chosen, 'edit', app.threadAgent);
    build.stage = 'build';
    build.plan = makePlan(true);
    this.push(build, 'planning', 'Making a thoughtful little plan', { plan: build.plan });
    queueMicrotask(() => this.run(build).catch((error) => this.fail(build, error)));
    return publicBuild(build);
  }

  async answer(buildId, answers) {
    await this.ready();
    const build = this.builds.get(buildId);
    if (!build || build.status !== 'awaiting_input') throw new Error('This build is not waiting for answers.');
    build.answers = answers;
    build.stage = 'build';
    build.status = 'queued';
    this.push(build, 'planning', 'Here’s the plan', { plan: build.plan || makePlan(false), answers });
    queueMicrotask(() => this.run(build).catch((error) => this.fail(build, error)));
    return publicBuild(build);
  }

  newBuild(appId, prompt, threadId = null, model = DEFAULT_MODEL, kind = 'edit', threadAgent = null) {
    const now = new Date().toISOString();
    // Threads created before Workshop recorded an owner were all Codex threads.
    const build = { id: randomId(), appId, prompt, threadId, threadAgent: threadId ? threadAgent || 'codex' : null, turnId: null, status: 'queued', stage: 'build', kind, model, ownerPid: process.pid, createdAt: now, updatedAt: now, events: [], answers: null, plan: null, agentText: '' };
    this.builds.set(build.id, build);
    this.push(build, 'queued', 'Added to your workbench');
    return build;
  }

  // Discovery asks the Codex agent — not Workshop — what it still needs to know.
  async runDiscovery(build) {
    const preset = requirePreset(build.model);
    const agent = this.agentFor(build.model);
    const threadId = await agent.startThread(getAppDir(build.appId), preset);
    build.threadId = threadId;
    build.threadAgent = preset.agent;
    build.agentText = '';
    await writeManifest(build.appId, { threadId, threadAgent: preset.agent });
    // Shaping is a thinking turn, so the agent gets read-only tools for it.
    const result = await agent.startTurn(threadId, discoveryPrompt(build), preset, { readOnly: true });
    build.turnId = result?.turn?.id || null;
    await this.persist(build);
  }

  async completeDiscovery(build, turn) {
    const brief = parseDiscovery(agentTextFrom(turn) || build.agentText);
    if (brief?.name || brief?.summary || brief?.category) {
      await writeManifest(build.appId, {
        ...(brief.name ? { name: brief.name.slice(0, 64) } : {}),
        ...(brief.summary ? { description: brief.summary.slice(0, 240) } : {}),
        ...(brief.category ? { category: brief.category } : {}),
      }).catch(() => {});
    }
    build.plan = brief?.plan?.length ? brief.plan.slice(0, 6) : makePlan(false);
    build.brief = brief?.summary || null;
    const questions = brief?.questions || [];
    if (!questions.length) {
      // The agent decided the request already determines the product.
      build.stage = 'build';
      build.status = 'queued';
      this.push(build, 'planning', 'Clear enough to start — here’s the plan', { plan: build.plan });
      queueMicrotask(() => this.run(build).catch((error) => this.fail(build, error)));
      return;
    }
    build.status = 'awaiting_input';
    this.push(build, 'questions', questions.length === 1 ? 'One question before I start' : `${questions.length} questions before I start`, { questions, plan: build.plan });
  }

  async run(build) {
    build.status = 'running';
    build.agentText = '';
    this.push(build, 'planning', build.kind === 'create' ? 'Shaping the experience' : 'Understanding your change');
    const preset = requirePreset(build.model);
    const agent = this.agentFor(build.model);
    let threadId = build.threadId;
    // A thread belongs to the agent that minted it: Codex ULIDs mean nothing to
    // `claude --resume`, and vice versa. Switching agents starts a fresh thread —
    // the workspace files, not the transcript, are what carry the app's state.
    build.resumed = Boolean(threadId) && build.threadAgent === preset.agent;
    if (build.resumed) await agent.resumeThread(threadId);
    else {
      threadId = await agent.startThread(getAppDir(build.appId), preset);
      build.threadId = threadId;
      build.threadAgent = preset.agent;
      await writeManifest(build.appId, { threadId, threadAgent: preset.agent });
    }
    this.push(build, 'editing', 'Crafting the app');
    this.watchPreview(build);
    const result = await agent.startTurn(threadId, buildPrompt(build, await this.connectionBrief()), preset);
    build.turnId = result?.turn?.id || null;
    await this.persist(build);
  }

  // What the agent may reach outside the desktop, with real tool names so it
  // writes calls that exist instead of inventing them. Best effort: a connection
  // that will not start must not hold up a build.
  async connectionBrief() {
    if (!this.mcp?.describe) return '';
    const listed = await this.mcp.list().catch(() => []);
    const ids = listed.filter((item) => item.enabled).map((item) => item.id);
    if (!ids.length) return '';
    const described = await Promise.race([
      this.mcp.describe(ids).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve([]), 8000)),
    ]);
    const usable = described.filter((entry) => entry.tools?.length);
    if (!usable.length) return '';
    const lines = usable.map((entry) => `- ${entry.id} (${entry.label}):\n${entry.tools.map((tool) => `    ${tool.name}(${signature(tool)})${tool.description ? ` — ${tool.description.split('\n')[0].slice(0, 100)}` : ''}`).join('\n')}`);
    return `\n\nConnections this Workshop can reach from an action, as ctx.mcp('<id>').call('<tool>', args):\n${lines.join('\n')}\nUse one only if the app genuinely needs it, list every one you use in manifest.connections, and never invent an id or tool that is not above.`;
  }

  // Agents report writes inconsistently — Codex emits a fileChange item for a
  // plain write but nothing at all when it patches through the shell. The file
  // system is the one signal that is true for every agent, so watch that.
  watchPreview(build) {
    const dir = path.join(getAppDir(build.appId), 'runtime');
    let timer = null;
    let watcher = null;
    try {
      watcher = fsSync.watch(dir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => { this.offerPreview(build).catch(() => {}); }, 700);
      });
    } catch { return; }
    this.watchers.get(build.id)?.();
    this.watchers.set(build.id, () => { clearTimeout(timer); watcher.close(); });
  }

  // Agents truncate index.html before rewriting it — a real create was observed
  // sitting at 0 bytes mid-build. Reloading then would flash an empty window,
  // which is worse than the placeholder it replaced.
  async offerPreview(build) {
    if (build.status !== 'running') return;
    const html = await fs.readFile(path.join(getAppDir(build.appId), 'runtime', 'index.html'), 'utf8').catch(() => '');
    if (html.length < 200 || !/<\/html>/i.test(html)) return;
    // A signal, not an event: the preview reloads without adding noise to the
    // activity feed or the persisted build record.
    this.emit(`build:${build.id}`, { id: randomId(), buildId: build.id, appId: build.appId, phase: 'preview', message: '', preview: true, at: new Date().toISOString() });
  }

  stopWatchingPreview(buildId) {
    this.watchers.get(buildId)?.();
    this.watchers.delete(buildId);
  }

  async onCodexNotification(message) {
    const params = message.params || {};
    const threadId = params.threadId || params.thread?.id || params.turn?.threadId;
    const build = [...this.builds.values()].find((item) => item.threadId === threadId && ['running', 'discovering'].includes(item.status));
    if (!build) return;
    if (message.method.includes('requestApproval')) {
      build.status = 'awaiting_approval';
      const approval = { id: randomId(), requestId: message.id, buildId: build.id, summary: approvalSummary(params), createdAt: new Date().toISOString() };
      this.approvals.set(approval.id, approval);
      this.push(build, 'approval', approval.summary, { approval });
      return;
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text) build.agentText = params.item.text;
    // Discovery is a thinking turn; its file/command chatter is not user-facing progress.
    if (build.status === 'discovering') {
      if (message.method === 'turn/completed') {
        const status = params.turn?.status;
        if (status && status !== 'completed') return this.fail(build, turnError(build, params.turn));
        try { await this.completeDiscovery(build, params.turn); }
        catch (error) { await this.fail(build, error); }
      }
      return;
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const completed = message.method === 'item/completed';
      const label = itemLabel(params.item, completed);
      if (label) this.push(build, phaseForItem(params.item, completed), label);
    }
    if (message.method === 'turn/completed') {
      const status = params.turn?.status;
      this.stopWatchingPreview(build.id);
      if (status && status !== 'completed') return this.fail(build, turnError(build, params.turn));
      try {
        this.push(build, 'checking', 'Checking every important path');
        await validateWorkspace(build.appId);
        this.push(build, 'previewing', 'Polishing the live preview');
        const app = await createRevision(build.appId);
        build.status = 'completed'; build.updatedAt = new Date().toISOString();
        this.push(build, 'complete', 'Ready to play with', { app });
      } catch (error) { await this.fail(build, error); }
    }
  }

  push(build, phase, message, extra = {}) {
    const previous = build.events.at(-1);
    if (previous && previous.phase === phase && previous.message === message && !Object.keys(extra).length) return;
    const event = { id: randomId(), buildId: build.id, appId: build.appId, phase, message, at: new Date().toISOString(), ...extra };
    build.events.push(event); build.updatedAt = event.at;
    this.emit(`build:${build.id}`, event);
    this.persist(build).catch(() => {});
  }

  async persist(build) {
    await fs.mkdir(this.buildDir(), { recursive: true });
    await atomicWrite(path.join(this.buildDir(), `${build.id}.json`), `${JSON.stringify(build, null, 2)}\n`);
  }

  buildDir() { return path.join(config.workshopDir, 'builds'); }

  async hydrate() {
    await fs.mkdir(this.buildDir(), { recursive: true });
    const entries = await fs.readdir(this.buildDir()).catch(() => []);
    for (const name of entries.filter((entry) => entry.endsWith('.json'))) {
      try {
        const file = path.join(this.buildDir(), name);
        const build = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!BUILD_STATES.includes(build.status)) continue;
        // Test runs and interrupted local sessions can leave a build record after
        // its app workspace is gone. Never hydrate those as active streams.
        try { await readManifest(build.appId); }
        catch {
          await fs.unlink(file).catch(() => {});
          console.log(JSON.stringify({ trace: 'build:hydrate:orphan-skipped', buildId: build.id, appId: build.appId }));
          continue;
        }
        if (build.ownerPid === process.pid && ['discovering', 'queued', 'running', 'awaiting_approval'].includes(build.status)) continue;
        if (['discovering', 'queued', 'running', 'awaiting_approval'].includes(build.status)) {
          build.status = 'failed';
          build.events.push({ id: randomId(), buildId: build.id, appId: build.appId, phase: 'failed', message: 'Build paused when Workshop restarted. Try again when you’re ready.', at: new Date().toISOString() });
          await writeManifest(build.appId, { status: 'failed', error: 'Build paused when Workshop restarted.' }).catch(() => {});
          await this.persist(build);
        }
        this.builds.set(build.id, build);
      } catch { /* Ignore incomplete build records. */ }
    }
  }

  async fail(build, error) {
    this.stopWatchingPreview(build.id);
    build.status = 'failed'; build.updatedAt = new Date().toISOString();
    try { await writeManifest(build.appId, { status: 'failed', error: error.message }); } catch { /* workspace may be gone */ }
    this.push(build, 'failed', error.message);
  }

  async cancel(buildId) {
    await this.ready();
    const build = this.builds.get(buildId);
    if (!build || !BUILD_STATES.includes(build.status)) throw new Error('Build not found.');
    if (build.threadId && build.turnId) await this.agentFor(build.model).interrupt(build.threadId, build.turnId);
    this.stopWatchingPreview(buildId);
    build.status = 'cancelled'; this.push(build, 'cancelled', 'Stopped for now');
    await writeManifest(build.appId, { status: 'draft' });
    return publicBuild(build);
  }

  approve(approvalId, accepted) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error('Approval not found.');
    const build = this.builds.get(approval.buildId);
    if (build) this.agentFor(build.model).respond(approval.requestId, { decision: accepted ? 'accept' : 'decline' });
    this.approvals.delete(approvalId);
    if (build) { build.status = accepted ? 'running' : 'failed'; this.push(build, accepted ? 'editing' : 'failed', accepted ? 'All set—continuing' : 'Permission declined'); }
  }
}

export function publicBuild(build) { return { id: build.id, appId: build.appId, status: build.status, kind: build.kind, stage: build.stage, model: build.model, createdAt: build.createdAt, updatedAt: build.updatedAt, events: build.events, questions: build.events.find((event) => event.questions)?.questions || null, plan: build.plan }; }
function requirePreset(key) { const preset = MODEL_PRESETS[key]; if (!preset) throw new Error('Unknown Workshop model preset.'); return preset; }
function phaseForItem(item = {}, completed = false) { const type = item.type || ''; if (/command|test/i.test(type)) return 'checking'; if (/file|edit|message|reasoning/i.test(type)) return 'editing'; return completed ? 'checking' : 'editing'; }
// Returns null for anything not worth announcing, so the feed carries substance
// instead of a canned phrase per model token.
function itemLabel(item = {}, completed = false) {
  const type = item.type || '';
  const [file] = itemPaths(item);

  // The agent narrating its own work is the most informative thing in the
  // stream, and it was being collected and then discarded.
  if (/message/i.test(type)) {
    const text = firstSentence(item.text);
    return completed && text ? text : null;
  }
  if (/command|test/i.test(type)) {
    const command = shorten(Array.isArray(item.command) ? item.command.join(' ') : item.command);
    if (command) return `${completed ? 'Ran' : 'Running'} ${command}`;
    return completed ? 'Local check passed' : 'Running a local check';
  }
  if (/file|edit/i.test(type)) return file ? `${completed ? 'Finished' : 'Editing'} ${path.basename(file)}` : (completed ? 'Interface detail finished' : 'Shaping an interface detail');
  if (/reasoning/i.test(type)) return completed ? null : 'Thinking it through';
  return completed ? null : 'Working on it';
}

function firstSentence(text) {
  const clean = String(text || '')
    // Markdown links to absolute paths are the agent talking to a developer.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)\/[^\s)]{12,}/g, '$1a file')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const stop = clean.search(/[.!?](\s|$)/);
  const sentence = stop > 20 ? clean.slice(0, stop + 1) : clean;
  return sentence.length > 130 ? `${sentence.slice(0, 127)}…` : sentence;
}

function shorten(value) {
  let clean = String(value || '').replace(/\s+/g, ' ').trim();
  const shell = /^\S*\/?(?:ba|z|d)?sh\s+-[a-z]*c\s+(.*)$/.exec(clean);
  if (shell) clean = shell[1].replace(/^["']|["']$/g, '').trim();
  return clean.length > 62 ? `${clean.slice(0, 59)}…` : clean;
}

// Codex reports a file edit as changes[].path while Claude Code reports item.path.
// Reading only the latter cost every Codex build its file names in the activity
// feed, and would have cost the streaming preview its trigger.
function itemPaths(item = {}) {
  const changes = Array.isArray(item.changes) ? item.changes.map((change) => change?.path) : [];
  return [item.path, item.filePath, ...changes].filter((value) => typeof value === 'string' && value);
}
function turnError(build, turn = {}) {
  const label = MODEL_PRESETS[build.model]?.label || 'The agent';
  return new Error(turn.error ? `${label}: ${turn.error}` : `${label} turn ${turn.status}.`);
}
function approvalSummary(params) { return params.reason || params.item?.command || 'Codex needs permission to continue.'; }

function agentTextFrom(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const messages = items.filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim());
  return messages.at(-1)?.text || '';
}

// The agent replies in prose-free JSON, but models still wrap it in fences or
// add a sentence, so accept any embedded object that carries a questions array.
export function parseDiscovery(text = '') {
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    if (!('questions' in parsed) && !('summary' in parsed) && !('plan' in parsed)) continue;
    return {
      name: typeof parsed.name === 'string' ? parsed.name.trim() : null,
      category: CATEGORIES.includes(parsed.category) ? parsed.category : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : null,
      plan: Array.isArray(parsed.plan) ? parsed.plan.filter((step) => typeof step === 'string' && step.trim()).map((step) => step.trim().slice(0, 120)) : [],
      questions: normalizeQuestions(parsed.questions),
    };
  }
  return null;
}

function jsonCandidates(text) {
  const candidates = [];
  for (const match of String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1].trim());
  const first = String(text).indexOf('{');
  const last = String(text).lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(String(text).slice(first, last + 1));
  return candidates.filter(Boolean);
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const questions = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : typeof raw.question === 'string' ? raw.question.trim() : '';
    const options = (Array.isArray(raw.options) ? raw.options : []).filter((option) => typeof option === 'string' && option.trim()).map((option) => option.trim().slice(0, 60));
    if (!prompt || options.length < 2) continue;
    const id = slugQuestionId(raw.id, prompt, seen);
    seen.add(id);
    questions.push({ id, prompt: prompt.slice(0, 160), options: [...new Set(options)].slice(0, 4) });
    if (questions.length === 3) break;
  }
  return questions;
}

function slugQuestionId(id, prompt, seen) {
  const base = String(typeof id === 'string' && id.trim() ? id : prompt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'question';
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

// Argument names, so an action does not have to guess between `path` and `directory`.
function signature(tool) {
  const schema = tool.inputSchema || {};
  const properties = Object.keys(schema.properties || {});
  if (!properties.length) return '';
  const required = new Set(schema.required || []);
  return properties.slice(0, 8).map((name) => (required.has(name) ? name : `${name}?`)).join(', ');
}

function makePlan(edit) {
  return edit ? ['Understand the existing app', 'Weave in the requested change', 'Check the main interaction', 'Refresh the preview'] : ['Shape the core experience', 'Craft the interface and behavior', 'Add thoughtful states and details', 'Check the main journey', 'Polish the preview'];
}

function discoveryPrompt(build) {
  return `A person asked Workshop for a new mini-app:

"${build.prompt}"

This turn is for shaping only. Read AGENTS.md and .codex/skills/workshop-app-builder/SKILL.md so you know the runtime contract, then decide what you genuinely still need to know before building. Reading files is fine; do not create, edit, or delete any file, and do not run builds or tests during this turn.

Reply with nothing but a single \`\`\`json fenced block in exactly this shape:

\`\`\`json
{
  "name": "Short app name, at most four words",
  "summary": "One sentence describing the app you intend to build",
  "category": "one of: utilities, productivity, creativity, games, information, data, wellbeing, other",
  "questions": [
    { "id": "kebab-case-id", "prompt": "A short plain-language question", "options": ["Concrete choice", "Concrete choice", "Concrete choice"] }
  ],
  "plan": ["Three to five outcome-oriented steps, one of which verifies the primary journey"]
}
\`\`\`

Rules for questions:
- Ask at most three, and ask only what materially changes the product.
- Use an empty array when the request already determines the product well enough to build.
- Every question must be specific to THIS request. Never ask generic questions about tone, audience, speed, or personality.
- Give each question two to four concrete options, each under 42 characters, that a non-technical person can choose between instantly.
- Never ask about frameworks, storage, file layout, or anything else technical.`;
}

function buildPrompt(build, connections = '') {
  const brief = build.answers && Object.keys(build.answers).length
    ? `\nThe person answered your shaping questions:\n${Object.entries(build.answers).map(([key, value]) => `- ${key}: ${value}`).join('\n')}`
    : '';
  const summary = build.brief ? `\nAgreed summary: ${build.brief}` : '';
  const plan = build.plan ? `\nAgreed plan:\n${build.plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : '';
  const cold = build.kind === 'edit' && !build.resumed
    ? '\n\nYou have not seen this app earlier in this conversation. Read runtime/index.html, manifest.json, and any actions/ files before changing anything, and preserve every behavior the change does not explicitly touch.'
    : '';
  return `Build this Workshop mini-app now: ${build.prompt}${summary}${brief}${plan}${cold}${connections}

Follow the workshop-app-builder skill and AGENTS.md exactly. Shaping is finished; do not ask any more questions. Work autonomously, write a complete polished runtime, update manifest.json and check the JavaScript syntax. Do not just explain what you would do.`;
}
