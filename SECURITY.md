# Security

Workshop runs coding agents that write code, then executes that code on your machine. This document is about being straight on which boundaries are real and which are not.

## Trust model

Workshop is **single-user, local-first software**. One person, on their own machine, running agents on their own behalf. It is not multi-tenant, and it has no authorization model beyond the optional `API_TOKEN`.

**Do not expose Workshop to a network you don't control.** It binds locally and expects to stay there.

Within that model, three parties are treated differently:

| Party | Trusted? |
|---|---|
| You | Yes |
| The coding agents (Codex, Claude Code) | Yes — they act as you, on your credentials |
| Everything an app touches — web pages, MCP results, files, other people's text | **No** |

## What is a real boundary

**The app runtime.** Apps get an iframe with `sandbox="allow-scripts allow-forms allow-popups"` — deliberately **without** `allow-same-origin`, so the document has an opaque origin and cannot reach Workshop's cookies, storage, or DOM. The CSP sets `connect-src 'none'`, so an app cannot make network requests at all. Everything it does goes through the bridge, where the host decides.

**Network egress from actions.** `safeFetch` requires HTTPS, resolves the hostname and rejects private, loopback, link-local and multicast addresses, blocks `localhost` and cloud metadata hosts, caps redirects and response size.
*Known weakness:* it validates the resolved address and then fetches by hostname, so a DNS rebind inside that window can slip through. Pinning to the validated address would close it.

**Connection grants.** An app can only reach MCP connections listed in its `manifest.connections`. Anything else fails by name. Verified both ways in the test suite.

**Secrets.** Connection env values are never returned by the API — only key names and where they resolve from. A `$NAME` value stays a reference into Workshop's own environment, so a token can live in `.env` rather than in `connections.json`.

**Catalog provenance.** Every npm entry sits under an org scope only its vendor can publish to, at a pinned version. Tests enforce both, so a future entry cannot quietly weaken it.

## What is **not** a real boundary

### The action sandbox

Generated action code runs in `node:vm` behind a regex denylist for `require`, `process`, `fs`, `import`, `eval`. **This stops accidents, not attacks.** Node's own documentation is explicit that `node:vm` is not a security mechanism, and reaching the host realm from inside a vm context through ordinary object graph traversal is a well-known technique that a denylist of identifiers does not prevent.

This was an acceptable trade when the only code in there was written by your own agent for your own apps. It stops being acceptable when an action pipes untrusted content into a model that can influence what code does next.

**If you change one thing, change this**: run actions in a separate process with an explicit permission model, or a worker with no ambient filesystem or network beyond the injected context. Workshop already spawns child processes for agents, so it is not a new pattern.

### MCP servers

`npx -y some-package` is **remote code execution by design**. An MCP server is an arbitrary process that Workshop spawns, and a bare stdio server inherits Workshop's environment — it can read `~/.ssh`, `~/.aws`, anything you can.

The catalog mitigates this with provenance and pinning. The **Docker MCP Gateway** mitigates it properly, by running each server in its own container; prefer it when Docker Desktop is available.

Anything added through "Add manually" has whatever access you give it. The UI shows the exact command before spawning it. Read it.

### Claude Code builds

Codex runs turns inside an OS-level `workspace-write` sandbox. Claude Code in print mode has no equivalent, so the tool allowlist (`Read,Write,Edit,Glob,Grep,Bash(node:*)`) is the only boundary. It is narrower than Codex's, and it is not enforced by the operating system.

## Prompt injection

The dangerous combination is **private data + untrusted content + the ability to act**. All three are reachable in one action today: `ctx.storage`, `ctx.fetch`/`ctx.llm` web search/`ctx.mcp` results, and a writing connection.

What exists:

- `AppLlmService` prepends instructions stating that search results and quoted material are untrusted data, never instructions.
- The agent contract forbids letting fetched or generated text decide what the app does next, or choose a storage key.
- The contract requires splitting: an action that reads untrusted content returns a *proposal* a person confirms; the write happens in a separate action.

**These are conventions, not enforcement.** Nothing in the runtime prevents a generated action from combining all three. Making that structural — refusing to hand a writing connection to an action that has already ingested untrusted content — is unbuilt and is the right next security change after the sandbox.

## Cost as a safety property

Agent turns cost real money and take minutes. Two guards exist: `ctx.llm` is capped per action invocation and `ctx.mcp` likewise, so a generated loop costs a handful of calls rather than an account. There is **no global budget ceiling**, and nothing stops a person from starting many builds.

## Known gaps

| | |
|---|---|
| Action sandbox is not an isolation boundary | Highest priority |
| Injection defences are conventions, not enforcement | |
| `safeFetch` DNS rebinding window | |
| Claude Code builds have no OS-level sandbox | |
| No global spend ceiling | |
| No auth by default (`API_TOKEN` optional) | Fine locally, not otherwise |
| Literal connection secrets sit in plaintext in `.workshop/connections.json` | Prefer `$NAME` references |
| Remote/OAuth MCP servers unsupported | Only stdio with env auth today |

## Reporting

This is a personal project without a security team. Open an issue for anything non-sensitive. For something you'd rather not post publicly, contact the repository owner directly.
