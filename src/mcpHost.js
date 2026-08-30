import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { atomicWrite } from './workshopStorage.js';

export const connectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, 'Connection ids are lowercase words, digits, dashes.'),
  label: z.string().min(1).max(64),
  transport: z.literal('stdio').default('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

const PROTOCOL_VERSION = '2025-06-18';

// A value of $NAME reads from Workshop's own environment, so a token can live in
// .env instead of connections.json. Anything else is used literally.
function resolveEnv(env = {}) {
  const resolved = {};
  for (const [key, value] of Object.entries(env)) {
    const reference = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(value));
    resolved[key] = reference ? (process.env[reference[1]] ?? '') : String(value);
  }
  return resolved;
}

/**
 * A minimal MCP client over stdio. Workshop is the host: it owns the process and
 * whatever credential the server needs, and hands apps a scoped caller instead of
 * the connection itself — the same posture ctx.llm takes with the API key.
 */
class McpConnection {
  constructor(definition) {
    this.definition = definition;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.ready = null;
    this.lastError = null;
  }

  get id() { return this.definition.id; }

  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const { command, args } = this.definition;
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...resolveEnv(this.definition.env) } });
      this.process = child;
      child.once('error', (error) => { this.lastError = error.message; this.process = null; this.ready = null; this.rejectAll(error); });
      child.stderr.on('data', (chunk) => { this.lastError = String(chunk).trim().slice(0, 400) || this.lastError; });
      // The server's own stderr says why far better than an exit code does:
      // "Docker Desktop is not running" beats "exited (1)".
      child.once('exit', (code) => {
        this.process = null;
        this.ready = null;
        const detail = (this.lastError || '').split('\n').filter(Boolean).at(-1);
        this.rejectAll(new Error(detail ? `${this.definition.label}: ${detail}` : `${this.definition.label} exited (${code}).`));
      });
      readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));

      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'workshop', version: '1.0.0' },
      }, config.mcpStartTimeoutMs);
      this.notify('notifications/initialized', {});
      const listed = await this.request('tools/list', {}, config.mcpStartTimeoutMs);
      // annotations.readOnlyHint is what lets the taint guard tell a lookup from a write.
      this.tools = (listed?.tools || []).map((tool) => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || {}, annotations: tool.annotations || null }));
    })();
    try { await this.ready; } catch (error) { this.ready = null; throw error; }
    return this.ready;
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id == null || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'MCP request failed.'));
    else pending.resolve(message.result);
  }

  request(method, params, timeoutMs = config.mcpTimeoutMs) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error(`${this.definition.label} is not running.`));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${this.definition.label} did not respond in time.`));
      }, timeoutMs);
    });
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method, params) {
    if (!this.process?.stdin.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  rejectAll(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }

  async call(toolName, args) {
    await this.start();
    if (!this.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`${this.definition.label} has no tool named "${toolName}". Available: ${this.tools.map((tool) => tool.name).join(', ') || 'none'}.`);
    }
    const result = await this.request('tools/call', { name: toolName, arguments: args ?? {} });
    // MCP returns display content plus an optional structured payload. Apps want
    // the structure; the text is the fallback so an action always gets something.
    const text = (result?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (result?.isError) throw new Error(text || `${toolName} failed.`);
    return { output: result?.structuredContent ?? null, text, raw: result?.content || [] };
  }

  stop() { this.process?.kill(); this.process = null; this.ready = null; }
}

export class McpHost {
  constructor({ file = path.join(config.workshopDir, 'connections.json') } = {}) {
    this.file = file;
    this.connections = new Map();
    this.loaded = null;
  }

  async load() {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      const raw = await fs.readFile(this.file, 'utf8').catch(() => '[]');
      let parsed = [];
      try { parsed = JSON.parse(raw); } catch { parsed = []; }
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        const result = connectionSchema.safeParse(entry);
        if (result.success) this.connections.set(result.data.id, new McpConnection(result.data));
      }
    })();
    return this.loaded;
  }

  async list() {
    await this.load();
    return [...this.connections.values()].map((connection) => ({
      id: connection.id,
      label: connection.definition.label,
      enabled: connection.definition.enabled,
      command: connection.definition.command,
      connected: Boolean(connection.process),
      tools: connection.tools.map((tool) => tool.name),
      // Names only. A secret Workshop holds is never read back out over the API.
      secrets: Object.entries(connection.definition.env || {}).map(([key, value]) => {
        const reference = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(value));
        return { key, from: reference ? `$${reference[1]}` : 'stored', missing: reference ? !process.env[reference[1]] : false };
      }),
      error: connection.lastError,
    }));
  }

  async save() {
    const definitions = [...this.connections.values()].map((connection) => connection.definition);
    await atomicWrite(this.file, `${JSON.stringify(definitions, null, 2)}\n`);
  }

  async add(definition) {
    await this.load();
    const parsed = connectionSchema.parse(definition);
    this.connections.get(parsed.id)?.stop();
    this.connections.set(parsed.id, new McpConnection(parsed));
    await this.save();
    return parsed;
  }

  async remove(id) {
    await this.load();
    this.connections.get(id)?.stop();
    this.connections.delete(id);
    await this.save();
  }

  // The Docker gateway is long-lived and lists its tools once at startup, so
  // enabling or disabling a server behind it means restarting the connection.
  async restart(id) {
    await this.load();
    const connection = this.connections.get(id);
    if (!connection) return null;
    connection.stop();
    connection.tools = [];
    return connection;
  }

  async get(id) {
    await this.load();
    const connection = this.connections.get(id);
    if (!connection) throw new Error(`No connection named "${id}". Add it in Workshop settings first.`);
    if (!connection.definition.enabled) throw new Error(`The ${connection.definition.label} connection is turned off.`);
    return connection;
  }

  // Tool schemas for the build agent, so it writes calls against what a server
  // actually exposes instead of guessing at names.
  async describe(ids = []) {
    await this.load();
    const described = [];
    for (const id of ids) {
      const connection = this.connections.get(id);
      if (!connection?.definition.enabled) continue;
      try {
        await connection.start();
        described.push({ id, label: connection.definition.label, tools: connection.tools });
      } catch (error) {
        described.push({ id, label: connection.definition.label, tools: [], error: error.message });
      }
    }
    return described;
  }

  stopAll() { for (const connection of this.connections.values()) connection.stop(); }
}

/**
 * An app reaches only the connections its manifest declares and the user granted.
 * Everything else throws by name, so a generated action fails loudly rather than
 * silently reaching somewhere it should not.
 */
export function createActionMcp(host, { appId, granted = [] }) {
  let calls = 0;
  return (id) => {
    if (!granted.includes(id)) {
      throw new Error(`${appId} is not connected to "${id}". Grant it in Workshop settings, and list it in manifest.connections.`);
    }
    return {
      async call(toolName, args) {
        if (calls >= config.mcpMaxCallsPerAction) throw new Error(`An action may make at most ${config.mcpMaxCallsPerAction} connection calls.`);
        calls += 1;
        const connection = await host.get(id);
        const started = Date.now();
        const result = await connection.call(toolName, args);
        console.log(JSON.stringify({ trace: 'action:mcp', appId, connection: id, tool: toolName, call: calls, durationMs: Date.now() - started }));
        return result;
      },
      async tools() {
        const connection = await host.get(id);
        await connection.start();
        return connection.tools.map((tool) => ({ name: tool.name, description: tool.description }));
      },
    };
  };
}
