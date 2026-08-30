# Architecture

Bricolage is one Node process that serves a React desktop, orchestrates coding agents over stdio, and executes app code. There is no database and no cloud component. Everything it knows lives in files you can read.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Browser                                                              │
│  ┌────────────────────────┐   ┌───────────────────────────────────┐  │
│  │ Desktop (React)        │   │ App runtime (sandboxed iframe)    │  │
│  │ windows · dock · rail  │◄──┤ opaque origin, strict CSP         │  │
│  │ conversation           │   │ window.Workshop bridge            │  │
│  └───────────┬────────────┘   └────────────────┬──────────────────┘  │
└──────────────┼─────────────────────────────────┼─────────────────────┘
   HTTP + SSE  │                     postMessage │ (relayed by desktop)
┌──────────────▼─────────────────────────────────▼─────────────────────┐
│ Express server (src/app.js)                                          │
│                                                                      │
│  BuildService ──── CodexAppServer ──stdio──► codex app-server        │
│   builds/edits └── ClaudeAgent    ──spawn─► claude --print           │
│                                                                      │
│  DesktopAgent ──── tool loop ──► desktopTools ──► apps, actions      │
│  McpHost      ──── stdio ──────► MCP servers (incl. Docker gateway)  │
│  sandbox.js   ──spawn─► action runner (--permission, no fs/net)      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ plain files
                        apps/ · .workshop/
```

## Modules

| File | Responsibility |
|---|---|
| `app.js` | HTTP surface, wiring, action execution context |
| `buildService.js` | Build lifecycle: shaping → questions → build → validate → revision |
| `codexAppServer.js` | Codex app-server client (one long-lived process, JSON-RPC over stdio) |
| `claudeAgent.js` | Claude Code client (one process per turn, `--resume` for continuity) |
| `desktopAgent.js` | The conversational partner — an agentic loop over `desktopTools` |
| `desktopTools.js` | What the partner can see and do, split into reads and acts |
| `mcpHost.js` | MCP client and connection registry |
| `connectionCatalog.js` | The curated server list and its provenance rules |
| `llmService.js` | `AppLlmService` — `ask()` for apps, `raw()` for the tool loop |
| `sandbox.js` / `actionRunner.js` | Runs generated action code in a confined child process |
| `taint.js` | Blocks the private-data + untrusted-content + act combination |
| `network.js` | `safeFetch` — public-HTTPS-only egress |
| `workshopStorage.js` | Manifests, revisions, workspace layout, the agent contract |

## Two agents, one vocabulary

`BuildService` never learns which agent is working. Both backends emit the same notifications — `item/started`, `item/completed`, `turn/completed` — so everything downstream is agent-agnostic. Their shapes differ underneath:

|  | Codex | Claude Code |
|---|---|---|
| Process | One app-server holding every thread | One per turn |
| Continuity | `thread/resume` | `--resume <session-id>` |
| Isolation | OS-level `workspace-write` sandbox | `--allowed-tools` is the boundary |
| Approvals | Requests routed to the UI | None — print mode has no round-trip |

**Threads are agent-owned.** A Codex ULID means nothing to `claude --resume`, so the manifest records `threadAgent` alongside `threadId`. Switching agents on an app starts a fresh thread and tells the incoming agent it hasn't seen the app before — the workspace files, not the transcript, carry state.

## Build lifecycle

```
create ──► discovering ──► awaiting_input ──► queued ──► running ──► completed
              │                   ▲                         │
              │  (no questions)   │                         └─► failed / cancelled
              └───────────────────┴──► queued
```

**Shaping is a real agent turn**, not a hardcoded form. The agent gets read-only tools and must reply with a fenced JSON brief — name, summary, questions, plan. Questions are specific to the request ("How should friends split the bill?" not "Pick a personality"), capped at three, and an empty array skips straight to building. Parsing tolerates fences, surrounding prose, and bare objects; an unparseable reply falls back to a generated plan.

Answers go back into the **same thread**, so the build keeps the shaping context.

On `turn/completed` the workspace is validated (complete HTML document, size cap, every declared action exports `handler`) and snapshotted as a new revision. Failure marks the app failed rather than shipping a broken version.

### Streaming preview

During a build turn the server watches `apps/<id>/runtime/` and signals the frontend to reload the iframe. It keys off the **filesystem**, not agent notifications, because agents report writes inconsistently — Codex emits a `fileChange` item for a plain write and nothing at all when it patches through the shell.

A reload is only offered for a complete document. Agents truncate `index.html` before rewriting it; a sampled build sat at **0 bytes at +176s**, and reloading then would flash an empty window.

These are signals, not events: emitted to the SSE stream, never added to the build record, so the activity feed stays clean.

## App workspaces

Every app is a directory. Nothing about an app lives anywhere else.

```
apps/<appId>/
  manifest.json         name, icon, accent, status, actions, connections,
                        threadId + threadAgent, revision, model
  runtime/index.html    the whole app — inline CSS and JS, no dependencies
  actions/<name>.js     server-side handlers
  data.json             the app's durable storage
  AGENTS.md CLAUDE.md   the contract, in the file each agent loads
  .codex/skills/  .claude/skills/    the builder skill, for each agent
  .workshop/revisions/<n>/           full snapshots, restorable
```

> **On the name.** The project was called Workshop before it was Bricolage. Internal
> identifiers keep the old name on purpose — `window.Workshop`, `.workshop/`,
> `WORKSHOP_DATA_DIR`, the `workshop-app-builder` skill. Renaming them would break the
> bridge every existing app calls and orphan build records and connections on disk.
> New apps can use `window.Bricolage`, which is the same object.

`.workshop/` at the root holds build records and `connections.json`. `WORKSHOP_DATA_DIR` relocates all mutable state — the test suite uses it so a test run can never hydrate and fail the dev server's in-flight builds.

## The runtime sandbox

Apps are served into an iframe with `sandbox="allow-scripts allow-forms allow-popups"` — deliberately **without** `allow-same-origin`, giving an opaque origin — under:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: https:; font-src data:; connect-src 'none';
base-uri 'none'; form-action 'none'
```

`connect-src 'none'` means an app cannot make network requests at all. Everything goes through the injected bridge:

```js
window.Workshop.callAction(name, payload)
window.Workshop.storage.get(key) / .set(key, value)
window.Workshop.notify(message) / .setTitle(title) / .openLink(httpsUrl)
```

Every call is a postMessage round-trip with a **15-second timeout** — without one, a lost reply left the promise pending forever and the app stuck in its loading state. The bridge also forwards `pointerdown`, because events inside an iframe never reach the parent document and the window manager needs to know you clicked.

## Actions

Action code runs server-side in `node:vm` with an injected, frozen context:

| | |
|---|---|
| `ctx.llm.ask({prompt, schema, instructions, search})` | → `{ output, sources, usage }`. Schemas are normalized to the strict subset structured outputs requires. Capped per invocation. |
| `ctx.storage.get/set` | The app's own `data.json` |
| `ctx.fetch` | `safeFetch`: HTTPS only, private-IP and metadata-host blocked, redirect and size limits |
| `ctx.mcp('<id>').call(tool, args)` | Only connections in `manifest.connections` |

Action code runs in a **child process** started with `--permission` and read access to nothing but the runner file, with the network modules removed from its loader and `fetch` deleted. It holds no capabilities of its own — each `ctx` call above is a round trip to the parent, where the checks live. Reaching the host realm from inside is expected and worthless; see [SECURITY.md](SECURITY.md) for the table of attempts and results.

An action that reads untrusted content loses write access to connections for the rest of that run, enforced against each tool's MCP `readOnlyHint`.

## Connections (MCP)

Bricolage is an MCP host. Servers are stdio child processes; it speaks `initialize` → `tools/list` → `tools/call`. First contact gets a longer timeout than a tool call, since a cold `npx` server may download a package.

Secrets are per-connection env values. A value of `$NAME` is a **reference** to Bricolage's own environment, so a token can stay in `.env`; literals are stored in `connections.json`. The API returns key names and where they resolve from — **never values**.

The catalog's rules are enforced by tests: org-scoped packages only, pinned versions only.

## The desktop agent

An agentic loop on the fast model, distinct from the coding agents:

- **Reads run freely** — `list_apps`, `describe_app`, `read_app_data`. Grounding is what separates a partner from a chatbot.
- **Acts stop and propose** — `build_app`, `edit_app`, `run_app_action`, `open_app`. Each carries a required `why`, because a button with no words is not a proposal. On approval the act runs and its outcome is fed back as the tool result, so the conversation reacts to what actually happened.
- Building delegates to `BuildService` and returns immediately, streaming into the activity rail like any other build.
- Conversations are **in-memory** and do not survive a restart.

## HTTP surface

| Method | Path | |
|---|---|---|
| GET | `/api/system/status` | Agent diagnostics, connections, active builds |
| GET/POST | `/api/apps` | List / create |
| GET/PATCH | `/api/apps/:id` | Detail (app, revisions, latest build) / update |
| POST | `/api/apps/:id/messages` | Edit |
| POST | `/api/apps/:id/actions/:action` | Run an action |
| POST | `/api/apps/:id/storage/{get,set}` | Bridge storage |
| POST | `/api/apps/:id/revisions/:n/restore` | Roll back |
| GET | `/api/builds/:id/events` | **SSE** build stream |
| POST | `/api/builds/:id/{answers,cancel}` | Shaping answers / stop |
| POST | `/api/desktop/message` | Talk to the partner |
| GET/POST/DELETE | `/api/connections*` | Connections and catalog |
| GET | `/runtime/:appId` | The app itself, bridge injected |

`/spec/*`, `/render/*` and `/action/*` are **legacy** from the project's earlier incarnation, still covered by `test/app.test.js`. They are unused by the desktop and are a reasonable first cleanup.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `4000` | |
| `OPENAI_API_KEY` | — | Required for `ctx.llm` and the desktop agent |
| `WORKSHOP_LLM_MODEL` | `gpt-5.6-luna` | |
| `WORKSHOP_LLM_EFFORT` | `low` | |
| `CODEX_BIN` / `CLAUDE_BIN` | `codex` / `claude` | |
| `WORKSHOP_DATA_DIR` | repo root | Relocates `apps/`, `.workshop/`, `specs/`, `actions/` |
| `API_TOKEN` | — | If set, bearer auth on API routes |

## Testing

```bash
npm test
```

Tests run against `.workshop-test/`, serially — the two files share one data tree, and starter migration isn't safe to run twice at once against an empty one.
