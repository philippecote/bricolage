# Contributing

## Setup

```bash
npm install
cp .env.example .env      # add your OPENAI_API_KEY
npm run build && npm start
```

`npm run dev` runs Vite on :4173 with the API proxied to :4000, for frontend work without rebuilding.

## Tests

```bash
npm test
```

Tests run against `.workshop-test/` via `WORKSHOP_DATA_DIR`, and serially. Both matter: a test `BuildService` hydrating the dev server's in-flight builds will mark them failed and write that into real manifests, and starter migration is not safe to run twice at once against an empty tree.

The suite covers the build lifecycle, agent notification normalization, cross-agent thread ownership, `ctx.llm`, the desktop agent's tool loop, catalog invariants, and feed labelling. It does not cover the React frontend.

## Working with agents

Verification means running a real build, which costs money and minutes.

- **Use a Luna preset for test builds** (`"model": "luna-high"`). Save `opus-5-high` for when the point of the test *is* cross-agent behaviour.
- A create takes roughly 3–5 minutes; an edit is shorter. Watch `GET /api/builds/:id/events` rather than polling.
- `WORKSHOP_DATA_DIR=/tmp/scratch npm start` gives you a throwaway desktop.

## Shape of the code

Read [ARCHITECTURE.md](ARCHITECTURE.md) first. Two invariants matter more than they look:

**Agents speak one notification vocabulary.** `BuildService` must never learn which agent is behind a build. If you add a backend, normalize to `item/started` / `item/completed` / `turn/completed` and nothing downstream should change.

**Threads belong to the agent that minted them.** A Codex ULID means nothing to `claude --resume`. Anything touching `threadId` must respect `threadAgent`.

## Style

- Match the surrounding code. It favours dense, readable expressions over ceremony.
- Comment the *why*, especially where behaviour looks arbitrary — most odd-looking lines here exist because a real agent did something unexpected, and the comment is the evidence.
- User-facing copy is plain and warm. No build jargon, no exclamation marks, no "Oops!".

## Before a pull request

- `npm test` and `npx tsc --noEmit` pass
- If it touches action execution, connections, or the runtime bridge, say what it does to the boundaries in [SECURITY.md](SECURITY.md) — and update that file if it changes them
- If it changes agent behaviour, verify with a real build and say what you saw
