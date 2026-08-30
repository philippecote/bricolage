import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'actionRunner.js');

/**
 * Runs a generated action in a child process that cannot read a file, spawn a
 * process, or open a socket. See actionRunner.js for how that is enforced.
 *
 * The previous implementation used `node:vm` with a regex denylist inside this
 * process, which Node's own documentation says is not a security mechanism: an
 * escape landed you in the server's realm with everything it could reach. The
 * boundary is now the process, so a `vm` escape inside the child buys nothing.
 */
export async function executeAction({ code, input, ctx, timeoutMs = config.actionTimeoutMs, host = {} }) {
  const child = spawn(process.execPath, [
    '--permission',
    // The runner is the only file this process may read. Nothing else — not the
    // app workspace, not node_modules, not the user's home directory.
    `--allow-fs-read=${RUNNER}`,
    `--max-old-space-size=${config.actionMemoryMb}`,
    '--no-warnings',
    RUNNER,
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '', NODE_ENV: process.env.NODE_ENV || '' } });

  let settle;
  const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let done = false;
  let stderr = '';

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    child.kill('SIGKILL');
    settle.reject(new Error(`Action timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  const finish = (fn, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    child.kill('SIGKILL');
    fn(value);
  };

  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  child.on('error', (error) => finish(settle.reject, new Error(`Action runner could not start: ${error.message}`)));
  child.on('close', () => finish(settle.reject, new Error(stderr.trim() || 'The action stopped without returning anything.')));

  readline.createInterface({ input: child.stdout }).on('line', async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }

    if (message.t === 'done') return finish(settle.resolve, { output: message.output, logs: message.logs || [] });
    if (message.t === 'fail') return finish(settle.reject, new Error(message.message || 'The action failed.'));
    if (message.t !== 'call') return;

    // The child has no capabilities of its own; every one is granted here, after
    // the same checks that would apply to any other caller.
    try {
      const handler = host[message.method];
      if (!handler) throw new Error(`Actions cannot use ${message.method}.`);
      const value = await handler(message.args || {});
      if (!done) child.stdin.write(`${JSON.stringify({ t: 'reply', id: message.id, ok: true, value })}\n`);
    } catch (error) {
      if (!done) child.stdin.write(`${JSON.stringify({ t: 'reply', id: message.id, ok: false, error: error?.message || String(error) })}\n`);
    }
  });

  child.stdin.write(`${JSON.stringify({ t: 'run', code, input, meta: ctx })}\n`);
  return finished;
}
