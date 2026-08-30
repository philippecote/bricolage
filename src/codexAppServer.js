import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

export class CodexAppServer extends EventEmitter {
  constructor({ bin = config.codexBin, spawnFn = spawn } = {}) {
    super();
    this.bin = bin;
    this.spawnFn = spawnFn;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.lastError = null;
  }

  async start() {
    if (this.ready) return;
    if (this.process) return this.initializing;
    this.initializing = new Promise((resolve, reject) => {
      const proc = this.spawnFn(this.bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = proc;
      proc.once('error', (error) => { this.lastError = error.message; this.process = null; reject(error); });
      proc.stderr.on('data', (chunk) => { this.lastError = String(chunk).trim() || this.lastError; });
      readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
      proc.once('exit', (code) => { this.ready = false; this.process = null; this.rejectAll(new Error(`Codex App Server exited (${code}).`)); });
      this.request('initialize', { clientInfo: { name: 'workshop', title: 'Workshop', version: '1.0.0' } })
        .then(() => { this.notify('initialized', {}); this.ready = true; resolve(); }, reject);
    });
    return this.initializing;
  }

  send(message) {
    if (!this.process?.stdin.writable) throw new Error('Codex App Server is not running.');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ method, id, params });
    return promise;
  }

  notify(method, params) { this.send({ method, params }); }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && (message.result || message.error) && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  rejectAll(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }

  async diagnostic() {
    try {
      await this.start();
      const auth = await this.request('account/read', { refreshToken: false });
      const authenticated = Boolean(auth?.account) || auth?.requiresOpenaiAuth === false;
      return { available: true, authenticated, accountType: auth?.account?.type || null, error: authenticated ? null : 'Codex is installed but not signed in.' };
    }
    catch (error) { return { available: false, authenticated: false, error: error.message }; }
  }

  async startThread(cwd, settings = {}) {
    await this.start();
    const result = await this.request('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', model: settings.model || null });
    return result.thread.id;
  }

  async resumeThread(threadId) { await this.start(); await this.request('thread/resume', { threadId }); return threadId; }
  async startTurn(threadId, prompt, settings = {}) {
    await this.start();
    return this.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], model: settings.model || null, effort: settings.effort || null });
  }
  async interrupt(threadId, turnId) { return this.request('turn/interrupt', { threadId, turnId }); }
  respond(id, result) { this.send({ id, result }); }
}
