# Workshop

**A local-first desktop where you and an agent make small apps together — and then use them.**

You describe something you want. A coding agent shapes it with you, builds it into its own workspace, and it becomes an app on your desktop: an icon, a window, its own saved data, its own version history. You keep it. You change it by asking. The agent is the manufacturing process, not the interface.

```
┌─ Workshop ────────────────────────── ◐ 1 working · 2 agents ready ─┐
│                                                                    │
│  What should we make?                          [Tea Steep Timer]   │
│  ┌──────────────────────────────────────┐      [Fair Share]        │
│  │ a timer for steeping tea             │      [Shelf Scout]       │
│  │  Luna High · Luna Max · Opus 5 High   ↑│     [Kitchen Convert]   │
│  └──────────────────────────────────────┘                          │
│   TOGETHER                                                         │
│   Looked at Tea Steep Timer                                        │
│   It remembers your green-tea choice and a custom herbal setting.  │
│                                                                    │
│            ✦ ─ ◈ ─ ⌘ ─ ⚙                                          │
└────────────────────────────────────────────────────────────────────┘
```

## Why this and not a chatbot

A chatbot with generative UI puts the model on the critical path of **every** interaction — slow, metered, different every time, gone when you scroll.

Workshop puts it there **once**. A tea timer costs one build. After that it opens in milliseconds, works offline, costs nothing, and behaves identically every time. It's a crystallized intention with a filename and an undo history.

See [VISION.md](VISION.md) for where that idea goes.

## Requirements

- **Node.js 20+**
- At least one coding agent, signed in:
  - [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex && codex login`
  - [Claude Code](https://claude.com/claude-code) — `npm install -g @anthropic-ai/claude-code && claude auth login`
- An **OpenAI API key** for `ctx.llm` and the desktop agent (`OPENAI_API_KEY` in `.env`)

## Run

```bash
npm install && npm run build && npm start
```

Then open **http://localhost:4000**. For frontend development, `npm run dev` serves Vite on :4173 with the API proxied.

## The loop

1. **Say what you want.** The desktop agent reads your library first, so it can tell you when something you already have covers it.
2. **It asks what it needs to.** The coding agent — not Workshop — decides the questions, and they're specific to your request. It skips them when the request is already clear.
3. **It builds, and you watch.** The preview reloads as files land; the feed shows the agent's own narration and the commands it runs.
4. **You change it by asking.** Edits reuse the app's thread, snapshot a version, and can be rolled back.

## Model presets

| Preset | Agent | Model | Notes |
|---|---|---|---|
| **Luna High** *(default)* | Codex | `gpt-5.6-luna` | Cheapest and quickest; the everyday choice |
| Luna Max | Codex | `gpt-5.6-luna` | Same model, thinking as hard as it can |
| Sol Medium | Codex | `gpt-5.6-sol` | Flagship, balanced |
| Opus 5 High | Claude Code | `claude-opus-5` | Built by a different agent entirely |

The desktop agent and `ctx.llm` run `gpt-5.6-luna` at low effort — ~1.7s bare, ~5s with web search.

## What apps can do

Apps are dependency-free HTML in a sandboxed, opaque-origin iframe. They reach the host through a small bridge, and server-side actions get a context object:

```js
export async function handler(input, ctx) {
  const { output, sources } = await ctx.llm.ask({
    prompt: `Extract shopping items from: ${input.text}`,
    schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
    search: false,
  });
  await ctx.storage.set('items', output.items);
  return { items: output.items, sources };
}
```

- `ctx.llm.ask()` — the model, with web search and structured output
- `ctx.storage` — the app's own durable JSON
- `ctx.fetch` — public HTTPS only, SSRF-guarded
- `ctx.mcp('<id>').call()` — connected outside services, scoped to what you granted

## Connections

Settings → Connections offers a small catalog built on two checkable rules: every npm entry sits under an **org scope only its vendor can publish to**, and every version is **pinned**. The **Docker MCP Gateway** leads it, because each server then runs in its own container rather than as a process holding Workshop's environment.

Apps declare what they need; you grant it; ungranted calls fail by name.

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it actually works — processes, data, build lifecycle, sandboxing |
| [VISION.md](VISION.md) | The thesis, and what's next |
| [SECURITY.md](SECURITY.md) | Threat model, and the boundaries that are **not** real yet |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Working on it |

## Status

Working software, not a finished product. It builds real apps that do real things. Before you point it at anything sensitive, read [SECURITY.md](SECURITY.md) — particularly the part about the action sandbox not being a true boundary.

## License

ISC — see [LICENSE](LICENSE).
