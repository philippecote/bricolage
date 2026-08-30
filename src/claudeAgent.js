import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Codex runs turns inside an OS-level workspace-write sandbox. Claude Code in
// print mode has no equivalent, so the tool list is the boundary: file tools
// scoped to the workspace cwd, plus node for the syntax check the contract asks
// for. A denied tool does not stall a print-mode run; the agent adapts.
const BUILD_TOOLS = 'Read,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,Bash(node:*)';
const SHAPING_TOOLS = 'Read,Glob,Grep';

/**
 * Speaks the same notification vocabulary as CodexAppServer so BuildService does
 * not care which agent is behind a build. The shapes differ underneath: Codex is
 * one long-lived app-server holding every thread, while Claude Code is a process
 * per turn that rejoins a session with --resume.
 */
export class ClaudeAgent extends EventEmitter {
  constructor({ bin = config.claudeBin, spawnFn = spawn } = {}) {
    super();
    this.bin = bin;
    this.spawnFn = spawnFn;
    this.cwds = new Map();
    this.existing = new Set();
    this.running = new Map();
    this.lastError = null;
  }

  async diagnostic() {
    try {
      const status = JSON.parse(await this.capture(['auth', 'status', '--json']));
      const authenticated = status?.loggedIn === true;
      return { available: true, authenticated, accountType: status?.authMethod || null, error: authenticated ? null : 'Claude Code is installed but not signed in.' };
    } catch (error) {
      return { available: false, authenticated: false, accountType: null, error: error.message };
    }
  }

  async startThread(cwd) {
    const threadId = randomUUID();
    this.cwds.set(threadId, cwd);
    return threadId;
  }

  // A session that already exists on disk must be rejoined with --resume, never
  // re-created with --session-id. BuildService calls this for known threads,
  // which is also how a thread survives a Workshop restart.
  async resumeThread(threadId) {
    this.existing.add(threadId);
    return threadId;
  }

  async startTurn(threadId, prompt, preset = {}, options = {}) {
    const turnId = randomUUID();
    const cwd = this.cwds.get(threadId) || options.cwd || process.cwd();
    const session = this.existing.has(threadId) ? ['--resume', threadId] : ['--session-id', threadId];
    const args = [
      '--print', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--strict-mcp-config',
      '--allowed-tools', options.readOnly ? SHAPING_TOOLS : BUILD_TOOLS,
      ...session,
    ];
    if (preset.model) args.push('--model', preset.model);
    if (preset.effort) args.push('--effort', preset.effort);

    const child = this.spawnFn(this.bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.existing.add(threadId);
    this.running.set(turnId, child);

    const state = { pending: new Map(), text: '', settled: false, stderr: '' };
    const finish = (status, error) => {
      if (state.settled) return;
      state.settled = true;
      this.running.delete(turnId);
      this.emit('notification', {
        method: 'turn/completed',
        params: { threadId, turnId, turn: { id: turnId, status, error: error || null, items: state.text ? [{ type: 'agentMessage', text: state.text }] : [] } },
      });
    };

    child.on('error', (error) => { this.lastError = error.message; finish('failed', `Claude Code could not start: ${error.message}`); });
    child.stderr.on('data', (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-2000); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line, { threadId, turnId, state, finish }));
    child.on('close', (code) => finish('failed', `Claude Code exited (${code}). ${state.stderr.trim()}`.trim()));

    return { turn: { id: turnId } };
  }

  onLine(line, ctx) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const { threadId, turnId, state, finish } = ctx;

    if (message.type === 'assistant') {
      for (const part of message.message?.content || []) {
        if (part.type === 'tool_use') {
          state.pending.set(part.id, part);
          this.emit('notification', { method: 'item/started', params: { threadId, turnId, item: toItem(part) } });
        }
        // Keep the newest assistant prose; the shaping turn's JSON brief is in it.
        if (part.type === 'text' && part.text?.trim()) state.text = part.text;
      }
      return;
    }
    if (message.type === 'user') {
      for (const part of message.message?.content || []) {
        const started = part.type === 'tool_result' && state.pending.get(part.tool_use_id);
        if (!started) continue;
        state.pending.delete(part.tool_use_id);
        this.emit('notification', { method: 'item/completed', params: { threadId, turnId, item: toItem(started) } });
      }
      return;
    }
    if (message.type === 'result') {
      if (typeof message.result === 'string' && message.result.trim()) state.text = message.result;
      const ok = message.subtype === 'success' && message.is_error !== true;
      finish(ok ? 'completed' : 'failed', ok ? null : String(message.result || message.subtype || 'Claude Code turn failed.'));
    }
  }

  async interrupt(_threadId, turnId) {
    const child = this.running.get(turnId);
    if (child) { child.kill('SIGTERM'); this.running.delete(turnId); }
    return { ok: true };
  }

  // Print mode has no interactive approval round-trip; tools are gated up front
  // by --allowed-tools instead, so nothing ever asks.
  respond() {}

  capture(args) {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.once('error', (error) => reject(new Error(`Claude Code is not available: ${error.message}`)));
      child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `Claude Code exited (${code}).`))));
    });
  }
}

function toItem(toolUse) {
  const name = toolUse.name || '';
  const path = toolUse.input?.file_path || toolUse.input?.path || toolUse.input?.notebook_path || null;
  if (name === 'Bash') return { type: 'command', name, command: toolUse.input?.command || null };
  if (/^(Write|Edit|MultiEdit|NotebookEdit|Read)$/.test(name)) return { type: 'fileChange', name, path };
  return { type: 'other', name };
}
