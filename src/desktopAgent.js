import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { ACT_TOOLS, DESKTOP_TOOLS, createDesktopTools } from './desktopTools.js';

const SYSTEM = `You are the person's partner on their Workshop desktop — a place where they and you make small personal apps together, and then use them.

You are not a one-shot builder. Most turns are conversation: understanding what they are actually trying to do, looking at what they already have, reading what is in it, and thinking with them. Build something only when software is genuinely the answer.

How to work:
- Look before you speak. Call list_apps to see the library, describe_app and read_app_data to see what is really in an app. Never guess at what they have or what is in it.
- Ground what you say in what you found. "Your grocery list has 14 items, 9 of them bought" is worth more than a paragraph of encouragement.
- Prefer changing an app that already does the job over building a new one. A different primary workflow is a different app; a missing feature is not.
- You may run an app's own actions to work with their data or drive it for them.
- When they are exploring rather than asking, help them think. It is fine for a turn to end with a question, an observation, or nothing to do.
- Answer first. If they asked something, say the answer in words; never offer to do something in place of answering. An act is what you add after the answer, not instead of it.

How to speak:
- Plain, warm, and short. Three or four sentences is usually plenty; a wall of text is a failure even when every line is true.
- Prose over lists. Use a list only when the items are genuinely parallel and there are more than two, and never to pad an answer.
- No build jargon, and never restate their words back to them.
- Say what you did, not what you are about to do.
- One thing at a time. If several things are worth doing, say so and let them pick.`;

/**
 * A conversation with hands, not a router.
 *
 * The loop runs on the small fast model with tools, so talking stays quick;
 * building delegates to the real coding agent and returns immediately, showing
 * up in the activity rail like any other build. Reads happen freely — grounding
 * is what makes a partner — while anything that spends money, changes an app, or
 * runs app code comes back as a proposal the person confirms.
 */
export class DesktopAgent {
  constructor({ llm, runAction, autoApprove = false }) {
    this.llm = llm;
    this.tools = createDesktopTools({ runAction });
    this.autoApprove = autoApprove;
    this.conversations = new Map();
  }

  conversation(id) {
    const key = id && this.conversations.has(id) ? id : randomUUID();
    if (!this.conversations.has(key)) this.conversations.set(key, { id: key, input: [], updatedAt: Date.now() });
    const conversation = this.conversations.get(key);
    conversation.updatedAt = Date.now();
    // A desktop session is not a forum; old threads are not worth holding.
    if (this.conversations.size > 40) {
      const oldest = [...this.conversations.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest && oldest.id !== key) this.conversations.delete(oldest.id);
    }
    return conversation;
  }

  async send({ conversationId, message, approved = null }) {
    if (!this.llm) throw new Error('Workshop has no model configured. Add OPENAI_API_KEY to .env and restart.');
    const conversation = this.conversation(conversationId);

    if (approved) {
      // Resuming a proposal: the person said yes, so answer the call that was
      // waiting on them and let the model carry on from there.
      conversation.input.push({ type: 'function_call_output', call_id: approved.callId, output: JSON.stringify(approved.result) });
    }
    if (message) conversation.input.push({ role: 'user', content: message });

    return this.run(conversation);
  }

  async run(conversation) {
    const performed = [];
    for (let step = 0; step < config.desktopMaxSteps; step += 1) {
      const response = await this.llm.raw({
        instructions: SYSTEM,
        input: conversation.input,
        tools: DESKTOP_TOOLS,
        search: true,
      });

      const calls = (response.output || []).filter((item) => item.type === 'function_call');
      conversation.input.push(...(response.output || []));

      if (!calls.length) {
        return { conversationId: conversation.id, reply: text(response), performed, pending: null };
      }

      for (const call of calls) {
        let args = {};
        try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { /* handled below */ }

        // Anything that writes, spends, or runs app code stops here and asks.
        if (ACT_TOOLS.includes(call.name) && !this.autoApprove) {
          // The model often puts its reasoning in the call's `why` instead of in
          // prose, which would leave the proposal on screen unexplained.
          return {
            conversationId: conversation.id,
            reply: text(response) || String(args.why || '').trim(),
            performed,
            pending: { callId: call.call_id, tool: call.name, args },
          };
        }

        const result = await this.invoke(call.name, args);
        performed.push({ tool: call.name, args });
        conversation.input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
    }
    return { conversationId: conversation.id, reply: 'That turned into more steps than I expected — ask me again more narrowly?', performed, pending: null };
  }

  async invoke(name, args) {
    const handler = this.tools[name];
    if (!handler) return { error: `No tool named ${name}.` };
    try { return await handler(args); }
    catch (error) { return { error: error.message }; }
  }
}

function text(response) {
  const parts = [];
  for (const item of response?.output || []) {
    for (const part of item.content || []) if (part.type === 'output_text' && part.text) parts.push(part.text);
  }
  return parts.join('\n').trim();
}

export function optionalDesktopAgent(llm, runAction) {
  if (!llm || !config.openaiApiKey) return null;
  return new DesktopAgent({ llm, runAction });
}
