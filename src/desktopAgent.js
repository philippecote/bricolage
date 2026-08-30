import { config } from './config.js';
import { listApps } from './workshopStorage.js';

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['create', 'edit', 'answer'] },
    reply: { type: 'string' },
    appId: { type: 'string' },
    prompt: { type: 'string' },
    reason: { type: 'string' },
    namedByUser: { type: 'boolean' },
  },
};

const INSTRUCTIONS = `You route what a person types on their Workshop desktop. Workshop builds small personal apps; the person's library is listed below.

Choose exactly one intent:
- "create" — they want something the library does not already cover. Put a clear, self-contained build request in "prompt".
- "edit" — an existing app should change, or an existing app already covers this well enough that extending it beats starting over. Put its id in "appId" and the change in "prompt".
- "answer" — they asked a question about their desktop or library rather than asking for software. Answer it in "reply" and set nothing else.

Rules:
- Choose "edit" only when an existing app already does this job. A different primary workflow is a different app even in the same subject area: a timer is not a task list, a tracker is not a calculator. When in doubt, "create" — a new app is cheap and a mangled one is not.
- "namedByUser" is true only when the person's own words identify the app you picked, by name or by unmistakable description. It is false whenever you inferred the connection yourself.
- Set "reason" only when you are proposing something they did not literally ask for. One short sentence, addressed to them, saying why.
- Always write "reply": one sentence in plain language, no build jargon, never a restatement of their own words.
- Never invent an appId. Use only ids from the library.`;

/**
 * Routing is a cheap, fast model call rather than an agent turn: it decides what
 * should happen, and the expensive agent only starts once that is settled. When
 * the routing agrees with what the person asked for, nothing is shown — it speaks
 * up only when it has something to add.
 */
export class DesktopAgent {
  constructor({ llm }) {
    this.llm = llm;
  }

  async route(prompt) {
    if (!this.llm) throw new Error('Workshop has no model configured. Add OPENAI_API_KEY to .env and restart.');
    const apps = await listApps();
    const library = apps.length
      ? apps.map((app) => `- ${app.id}: ${app.name} — ${app.description || 'no description'}`).join('\n')
      : '(the library is empty)';

    const { output } = await this.llm.ask({
      instructions: INSTRUCTIONS,
      prompt: `Their library:\n${library}\n\nThey typed:\n"${prompt}"`,
      schema: ROUTE_SCHEMA,
      search: false,
    });

    return normalize(output, prompt, new Set(apps.map((app) => app.id)));
  }
}

function normalize(output = {}, original, knownIds) {
  const intent = ['create', 'edit', 'answer'].includes(output.intent) ? output.intent : 'create';
  const appId = typeof output.appId === 'string' && knownIds.has(output.appId) ? output.appId : null;
  const reply = trim(output.reply, 240);
  const reason = trim(output.reason, 240);

  // A model that says "edit" but names no real app has not actually routed.
  if (intent === 'edit' && !appId) return { intent: 'create', prompt: trim(output.prompt, 2000) || original, reply, reason: '', confirm: false };
  if (intent === 'answer') return { intent: 'answer', reply: reply || 'I could not work that one out.', appId: null, prompt: '', reason: '', confirm: true };

  return {
    intent,
    appId,
    prompt: trim(output.prompt, 2000) || original,
    reply,
    reason,
    // Only interrupt when the routing proposes something the person did not ask
    // for. "Build me X" should build X, and an edit to an app they named by name
    // should just run.
    confirm: Boolean(reason) || (intent === 'edit' && output.namedByUser !== true),
  };
}

function trim(value, max) {
  const clean = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function optionalDesktopAgent(llm) {
  if (!llm || !config.openaiApiKey) return null;
  return new DesktopAgent({ llm });
}
