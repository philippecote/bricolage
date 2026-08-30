import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { assertSafeId } from './utils.js';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureStorage() {
  await Promise.all([ensureDir(config.specsDir), ensureDir(config.actionsDir)]);
}

export function getSpecPath(appId) {
  assertSafeId(appId, 'appId');
  return path.join(config.specsDir, `${appId}.md`);
}

export function getActionDir(appId) {
  assertSafeId(appId, 'appId');
  return path.join(config.actionsDir, appId);
}

export function getActionPath(appId, action) {
  assertSafeId(appId, 'appId');
  assertSafeId(action, 'action');
  return path.join(getActionDir(appId), `${action}.js`);
}

export async function readSpec(appId) {
  const specPath = getSpecPath(appId);
  return fs.readFile(specPath, 'utf8');
}

export async function writeSpec(appId, content) {
  const specPath = getSpecPath(appId);
  await ensureDir(path.dirname(specPath));
  await fs.writeFile(specPath, content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

export async function readActionCode(appId, action) {
  const actionPath = getActionPath(appId, action);
  return fs.readFile(actionPath, 'utf8');
}

export async function hasActionCode(appId, action) {
  try {
    await fs.access(getActionPath(appId, action));
    return true;
  } catch {
    return false;
  }
}

export async function writeActionCode(appId, action, code) {
  const actionPath = getActionPath(appId, action);
  await ensureDir(path.dirname(actionPath));
  await fs.writeFile(actionPath, code, 'utf8');
  return actionPath;
}
