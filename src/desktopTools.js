import fs from 'node:fs/promises';
import { getAppDataPath, listApps, readManifest } from './workshopStorage.js';

/**
 * The desktop agent's hands.
 *
 * Reads run freely — knowing your library and your data is what separates a
 * partner from a chatbot. Anything that spends money, changes an app, or runs
 * app code is proposed instead: it returns a pending act the person confirms.
 */
export const READ_TOOLS = ['list_apps', 'read_app_data', 'describe_app'];
export const ACT_TOOLS = ['build_app', 'edit_app', 'run_app_action', 'open_app'];

export const DESKTOP_TOOLS = [
  {
    type: 'function', name: 'list_apps', strict: true,
    description: 'List every app on this desktop with what it does, whether it is working, and what it can reach. Call this before assuming anything about the library.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function', name: 'describe_app', strict: true,
    description: 'Full detail for one app: its description, actions it exposes, connections it holds, and version count.',
    parameters: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'], additionalProperties: false },
  },
  {
    type: 'function', name: 'read_app_data', strict: true,
    description: "Read an app's saved data so you can reason about what is actually in it. Read-only.",
    parameters: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'], additionalProperties: false },
  },
  {
    type: 'function', name: 'open_app', strict: true,
    description: "Put an app in front of the person on their desktop. This shows it to them and tells you nothing — you cannot see an app, so never open one in order to look at it yourself.",
    parameters: { type: 'object', properties: { appId: { type: 'string' }, why: { type: 'string', description: 'One sentence for the person, since they see this as a button and nothing else.' } }, required: ['appId', 'why'], additionalProperties: false },
  },
  {
    type: 'function', name: 'run_app_action', strict: true,
    description: "Run one of an app's own actions, the way the app would. Use this to work with their data or drive an app for them.",
    parameters: {
      type: 'object',
      properties: { appId: { type: 'string' }, action: { type: 'string' }, payloadJson: { type: 'string', description: 'JSON object as a string, or "{}"' }, why: { type: 'string', description: 'One sentence for the person, since they see this as a button and nothing else.' } },
      required: ['appId', 'action', 'payloadJson', 'why'], additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'build_app', strict: true,
    description: 'Build a new app. Expensive and slow, so only when the person wants software rather than an answer.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' }, why: { type: 'string' } }, required: ['prompt', 'why'], additionalProperties: false },
  },
  {
    type: 'function', name: 'edit_app', strict: true,
    description: 'Change an existing app. Prefer this over build_app when an app already does this job.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, prompt: { type: 'string' }, why: { type: 'string' } }, required: ['appId', 'prompt', 'why'], additionalProperties: false },
  },
];

export function createDesktopTools({ runAction }) {
  return {
    async list_apps() {
      const apps = await listApps();
      return apps.map((app) => ({ id: app.id, name: app.name, does: app.description, status: app.status, actions: app.actions, connections: app.connections || [], version: app.revision }));
    },

    async describe_app({ appId }) {
      const app = await readManifest(appId);
      return { id: app.id, name: app.name, does: app.description, askedFor: app.prompt, status: app.status, actions: app.actions, connections: app.connections || [], version: app.revision, builtWith: app.model };
    },

    async read_app_data({ appId }) {
      await readManifest(appId);
      const raw = await fs.readFile(getAppDataPath(appId), 'utf8').catch(() => '{}');
      // A large store would swamp the conversation; the shape is what matters.
      const text = raw.length > 6000 ? `${raw.slice(0, 6000)}\n… truncated, ${raw.length} bytes total` : raw;
      return { appId, data: text };
    },

    async run_app_action({ appId, action, payloadJson }) {
      let payload = {};
      try { payload = payloadJson ? JSON.parse(payloadJson) : {}; }
      catch { throw new Error('payloadJson must be a JSON object encoded as a string.'); }
      return runAction(appId, action, payload);
    },
  };
}
