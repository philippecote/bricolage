'use strict';

/**
 * The action sandbox, child side.
 *
 * This file is the entry point of a process spawned with `--permission` and read
 * access to nothing but itself. That is the boundary — not the vm context this
 * used to rely on. Node's own documentation is explicit that `node:vm` is not a
 * security mechanism, so the containment lives at the process level instead:
 *
 *   fs, child_process, worker_threads, native addons  →  denied by --permission
 *   net, http, https, http2, dgram, tls, dns          →  denied below
 *   fetch and friends                                 →  removed below
 *
 * An action therefore cannot read a file, spawn anything, or open a socket even
 * if it escapes every JavaScript-level guard. Everything it is allowed to do
 * goes back to the parent over stdio, where the real checks live.
 */

const vm = require('node:vm');
const Module = require('node:module');
const readline = require('node:readline');

const BLOCKED_MODULES = new Set([
  'net', 'http', 'https', 'http2', 'dgram', 'tls', 'dns', 'dns/promises', 'inspector', 'repl', 'vm', 'module',
].flatMap((name) => [name, `node:${name}`]));

const nativeLoad = Module._load;
Module._load = function blockedLoad(request, ...rest) {
  if (BLOCKED_MODULES.has(request)) throw new Error(`Actions may not use ${request}. Use ctx.fetch for network access.`);
  return nativeLoad.call(this, request, ...rest);
};

for (const name of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'navigator']) delete globalThis[name];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let nextId = 1;

// Every capability an action has is a round trip to the parent, which is where
// the SSRF guard, the storage scoping and the connection grants are enforced.
function callHost(method, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: 'call', id, method, args });
  });
}

const MAX_LOG_LINES = 200;
const MAX_LOG_LINE = 500;

function buildContext(meta) {
  const logs = [];
  const record = (...parts) => {
    if (logs.length >= MAX_LOG_LINES) return;
    logs.push(parts.map((part) => (typeof part === 'string' ? part : safeStringify(part))).join(' ').slice(0, MAX_LOG_LINE));
  };

  const ctx = {
    appId: meta.appId,
    action: meta.action,
    requestId: meta.requestId,
    nowIso: meta.nowIso,
    async fetch(url, options = {}) {
      const reply = await callHost('fetch', { url: String(url), options: plain(options) });
      return new Response(reply.body, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
    },
    storage: {
      get: (key = null) => callHost('storage.get', { key }),
      set: (key, value) => callHost('storage.set', { key, value }),
    },
    llm: { ask: (options = {}) => callHost('llm.ask', plain(options)) },
    mcp: (id) => ({
      call: (tool, args) => callHost('mcp.call', { id: String(id), tool: String(tool), args: plain(args) }),
      tools: () => callHost('mcp.tools', { id: String(id) }),
    }),
  };

  return { ctx: Object.freeze(ctx), logs, console: { log: record, info: record, warn: record, error: record, debug: record } };
}

function plain(value) {
  try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return null; }
}
function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// Generated code is written as an ES module; this file runs as CommonJS.
function normalizeExports(code) {
  return code
    .replace(/(^|\n)\s*export\s+async\s+function\s+handler\s*\(/, '$1async function handler(')
    .replace(/(^|\n)\s*export\s+function\s+handler\s*\(/, '$1function handler(')
    .replace(/(^|\n)\s*export\s+const\s+handler\s*=\s*/g, '$1const handler = ')
    .replace(/(^|\n)\s*export\s*\{\s*handler\s*(?:as\s+\w+)?\s*\};?/g, '$1')
    .trim();
}

async function run({ code, input, meta }) {
  const { ctx, logs, console: sandboxConsole } = buildContext(meta);
  const source = [
    '(function (input, ctx, console) {',
    '"use strict";',
    normalizeExports(code),
    'if (typeof handler !== "function") { throw new Error("Generated action must define handler(input, ctx)."); }',
    'return handler(input, ctx);',
    '})',
  ].join('\n');

  const factory = vm.runInThisContext(source, { filename: 'action.js' });
  const output = await factory(input, ctx, sandboxConsole);
  return { output: plain(output), logs };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.t === 'reply') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(message.error || 'Host call failed.'));
    return;
  }

  if (message.t === 'run') {
    try {
      const result = await run(message);
      send({ t: 'done', ...result });
    } catch (error) {
      send({ t: 'fail', message: error?.message || String(error), logs: [] });
    }
  }
});

process.on('uncaughtException', (error) => send({ t: 'fail', message: error?.message || String(error) }));
process.on('unhandledRejection', (error) => send({ t: 'fail', message: error?.message || String(error) }));
