import vm from 'node:vm';
import { ensureSerializable } from './utils.js';

const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_LENGTH = 500;
const BANNED_TOKENS = [
  /\brequire\s*\(/,
  /\bprocess\b/,
  /\bchild_process\b/,
  /\bfs\b/,
  /\bimport\s*\(/,
  /\bimport\s+[^('"`]/,
  /\beval\s*\(/,
];

function formatLogParts(parts) {
  return parts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(' ')
    .slice(0, MAX_LOG_LINE_LENGTH);
}

function makeConsole(logs) {
  const push = (...parts) => {
    if (logs.length >= MAX_LOG_LINES) {
      return;
    }
    logs.push(formatLogParts(parts));
  };

  return {
    log: push,
    info: push,
    warn: push,
    error: push,
    debug: push,
  };
}

function timeoutPromise(timeoutMs) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Action timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

function assertNoBannedTokens(code) {
  for (const pattern of BANNED_TOKENS) {
    if (pattern.test(code)) {
      throw new Error(`Action code contains banned token: ${pattern}`);
    }
  }
}

function normalizeModuleExports(code) {
  return code
    .replace(/(^|\n)\s*export\s+async\s+function\s+handler\s*\(/, '$1async function handler(')
    .replace(/(^|\n)\s*export\s+function\s+handler\s*\(/, '$1function handler(')
    .replace(/(^|\n)\s*export\s+const\s+handler\s*=\s*/g, '$1const handler = ')
    .replace(/(^|\n)\s*export\s*\{\s*handler\s*(?:as\s+\w+)?\s*\};?/g, '$1')
    .trim();
}

export async function executeAction({ code, input, ctx, timeoutMs, fetchFn = fetch }) {
  assertNoBannedTokens(code);

  const logs = [];
  const sandbox = {
    console: makeConsole(logs),
    fetch: fetchFn,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    __input: input,
    __ctx: Object.freeze({ ...ctx }),
  };

  const context = vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });

  const normalizedCode = normalizeModuleExports(code);
  const wrappedSource = [
    '"use strict";',
    normalizedCode,
    'if (typeof handler !== "function") { throw new Error("Generated action must define handler(input, ctx)."); }',
    '(async () => await handler(__input, __ctx))()',
  ].join('\n');

  const script = new vm.Script(wrappedSource, { filename: 'generated-action.js' });
  const rawOutput = await Promise.race([
    script.runInContext(context, { timeout: timeoutMs }),
    timeoutPromise(timeoutMs),
  ]);

  return {
    output: ensureSerializable(rawOutput),
    logs,
  };
}
