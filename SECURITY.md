# Security

Bricolage runs coding agents that write code, then executes that code on your machine. This document is about being straight on which boundaries are real and which are not.

## Trust model

Bricolage is **single-user, local-first software**. One person, on their own machine, running agents on their own behalf. It is not multi-tenant, and it has no authorization model beyond the optional `API_TOKEN`.

**Do not expose Bricolage to a network you don't control.** It binds locally and expects to stay there.

Within that model, three parties are treated differently:

| Party | Trusted? |
|---|---|
| You | Yes |
| The coding agents (Codex, Claude Code) | Yes — they act as you, on your credentials |
| Everything an app touches — web pages, MCP results, files, other people's text | **No** |

## What is a real boundary

**The app runtime.** Apps get an iframe with `sandbox="allow-scripts allow-forms allow-popups"` — deliberately **without** `allow-same-origin`, so the document has an opaque origin and cannot reach Bricolage's cookies, storage, or DOM. The CSP sets `connect-src 'none'`, so an app cannot make network requests at all. Everything it does goes through the bridge, where the host decides.

**Network egress from actions.** `safeFetch` requires HTTPS, resolves the hostname and rejects private, loopback, link-local and multicast addresses, blocks `localhost` and cloud metadata hosts, caps redirects and response size.
*Known weakness:* it validates the resolved address and then fetches by hostname, so a DNS rebind inside that window can slip through. Pinning to the validated address would close it.

**Connection grants.** An app can only reach MCP connections listed in its `manifest.connections`. Anything else fails by name. Verified both ways in the test suite.

**Secrets.** Connection env values are never returned by the API — only key names and where they resolve from. A `$NAME` value stays a reference into Bricolage's own environment, so a token can live in `.env` rather than in `connections.json`.

**Catalog provenance.** Every npm entry sits under an org scope only its vendor can publish to, at a pinned version. Tests enforce both, so a future entry cannot quietly weaken it.

## The action sandbox

Generated action code runs in a **child process spawned with Node's permission model** and read access to exactly one file — the runner itself. Inside that process the network modules are removed from the module loader and `fetch` is deleted from the global object.

The process is the boundary, not the JavaScript context. Reaching the host realm from action code is *expected* and worthless:

| Attempt | Result |
|---|---|
| `Function('return process')()` | succeeds — and buys nothing |
| `require('node:fs').readFileSync('/etc/passwd')` | `ERR_ACCESS_DENIED` |
| reading `~/.ssh`, or Bricolage's own `.env` | `ERR_ACCESS_DENIED` |
| `child_process.execSync('id')` | `ERR_ACCESS_DENIED` |
| `require('node:net')` / `node:dns` / `node:https` | refused by the loader |
| `fetch(...)` | `undefined` |
| `process.binding('fs')` | refused by Node |
| native addon via `dlopen` | `ERR_DLOPEN_DISABLED` |

The child is handed an environment of three variables, none of them secret. It gets no capabilities of its own: `ctx.fetch`, `ctx.storage`, `ctx.llm` and `ctx.mcp` are round trips to the parent, where the checks live. A run that will not finish is killed, and memory is capped.

The cost is a process per action — measured at **~24ms**, against a 15s-plus budget for anything that calls a model.

`test/sandbox.test.js` runs each escape in the table above and requires it to fail.

## Prompt injection

The dangerous combination is **private data + untrusted content + the ability to act**. This is now enforced rather than advised.

Every action run is tracked. The moment it ingests something a stranger could have written — a page from `ctx.fetch`, a web-search-backed `ctx.llm` answer, a result from an outside connection — it loses the ability to act on the outside world for the rest of that run:

- Further `ctx.mcp` calls are permitted **only** for tools the server marks `readOnlyHint: true` in its MCP annotations. A tool that is unannotated, or annotated as anything else, is refused.
- Further `ctx.llm` calls lose web search, so injected text cannot steer a fresh lookup.

Reads keep working, so the pattern the contract asks for still holds: read, return a proposal a person confirms, and do the write in a separate action. The refusal message says exactly that.

Verified end to end: a clean action writes through a connection; the same action preceded by one `ctx.fetch` is refused and the file never reaches disk, while a read-only call on the same connection still succeeds.

## What is still not a boundary

**MCP servers added outside Docker.** `npx -y some-package` is remote code execution by design, and a bare stdio server inherits Bricolage's environment — unlike actions, it is not confined. The catalog mitigates this with publisher provenance and pinned versions. The **Docker MCP Gateway** mitigates it properly, by running each server in its own container; prefer it when Docker Desktop is available. Anything added through "Add manually" has whatever access you give it, and the UI shows the exact command before spawning it.

**Claude Code builds.** Codex runs turns inside an OS-level `workspace-write` sandbox. Claude Code in print mode has no equivalent, so the tool allowlist (`Read,Write,Edit,Glob,Grep,Bash(node:*)`) is the only boundary, and it is not enforced by the operating system. This applies to *building* apps, not to running them.

## Cost as a safety property

Agent turns cost real money and take minutes. Two guards exist: `ctx.llm` is capped per action invocation and `ctx.mcp` likewise, so a generated loop costs a handful of calls rather than an account. There is **no global budget ceiling**, and nothing stops a person from starting many builds.

## Known gaps

| | |
|---|---|
| MCP servers are unconfined unless run through the Docker gateway | Highest remaining |
| Claude Code builds have no OS-level sandbox | Affects building, not running |
| No global spend ceiling — only per-invocation caps | |
| No auth by default (`API_TOKEN` optional) | Fine locally, not otherwise |
| Literal connection secrets sit in plaintext in `.workshop/connections.json` | Prefer `$NAME` references |
| Remote/OAuth MCP servers unsupported | Only stdio with env auth today |
| Response bodies cross the sandbox boundary as text | Binary payloads are not supported by `ctx.fetch` |

## Reporting

This is a personal project without a security team. Open an issue for anything non-sensitive. For something you'd rather not post publicly, contact the repository owner directly.
