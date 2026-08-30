# DOM Terminal System Design

## 1. Purpose
Build a multi-user, server-side LLM platform where apps are generated as client-side HTML/JavaScript, while backend behavior is synthesized lazily per user action. The system should feel like a modern DOM terminal: UI is dynamic and generated, server capabilities are callable, and unneeded backend code is never generated.

## 2. Product Goals
- Run models server-side using OpenAI APIs.
- Store app specs and state server-side for durability and multi-user support.
- Generate a full client app (single HTML document) from a spec.
- Lazily generate backend action handlers only when corresponding UI actions are invoked.
- Validate generated backend code through execution and bounded self-repair.
- Return structured results to the frontend for immediate interactive updates.

## 3. Non-Goals (MVP)
- Full enterprise auth/SSO.
- Arbitrary third-party package installs in generated action code.
- Distributed execution across multiple regions.
- Visual canvas/window manager (single app surface is enough for MVP).

## 4. Core Concepts
- App: Logical unit identified by `appId`.
- Spec: Markdown source-of-truth for requirements, actions, data contracts, and UI expectations (`specs/<appId>.md`).
- Frontend Artifact: LLM-generated full HTML document rendered as iframe `srcdoc`.
- Action: Named backend capability called by frontend (`/action/:appId/:action`), generated on first use and cached.
- Action Runtime: Restricted execution sandbox for generated action code.

## 5. High-Level Architecture
- Frontend Host (browser):
  - Operator/developer panel to edit spec and trigger render.
  - Iframe runtime for generated app HTML.
- API Server (Node/Express):
  - Spec read/write endpoints.
  - Render endpoint (spec -> generated HTML via OpenAI).
  - Action endpoint (lazy codegen + sandbox execution + response).
- LLM Service Layer:
  - OpenAI client wrapper, model selection, prompt templates.
- Storage:
  - Filesystem-backed in MVP (`specs/`, `actions/`).
  - Upgrade path to DB/object storage for production.
- Sandbox Runtime:
  - Node `vm` with strict timeout and limited globals.

## 6. End-to-End Lifecycle
1. User edits and saves app spec.
2. User requests render.
3. Server prompts OpenAI with spec and returns HTML.
4. Frontend loads HTML in iframe.
5. User interaction triggers action call from iframe.
6. Server checks action cache:
   - If exists: execute.
   - If missing: generate code from spec + action context, save, execute.
7. Server returns result JSON.
8. Frontend updates DOM based on returned result.
9. Optional: if execution fails, one or two auto-repair attempts before returning error.

## 7. Functional Requirements

### 7.1 Spec Management
- `GET /spec/:appId` returns Markdown spec.
- `POST /spec/:appId` writes full Markdown spec.
- Spec must persist across restarts.

### 7.2 Frontend Generation
- `POST /render/:appId` returns JSON `{ html }`.
- Generated output must be a complete HTML document.
- HTML must use same-origin `fetch` to call backend actions.

### 7.3 Action Invocation
- `POST /action/:appId/:action` accepts JSON payload.
- Returns:
  - `status: ok` and serializable `output` for success.
  - `status: error` with machine-readable reason on failure.
- Response should include metadata (logs, code hash) in MVP.

### 7.4 Lazy Code Generation
- Missing action handler triggers OpenAI codegen.
- Generated module must export async `handler(input, ctx)`.
- Persist generated code to action cache for reuse.

### 7.5 Execution and Validation
- Execute in isolated runtime with max time budget.
- Capture logs and output.
- Enforce serializable response shape.
- On runtime error, support bounded iterative repair (target: up to 2 retries).

### 7.6 Observability
- Log render and action timings.
- Log whether action executed from cache vs generated.
- Log action hash/version for reproducibility.

## 8. Non-Functional Requirements
- Reliability:
  - API should return deterministic structured errors.
  - Timeouts on model calls and action execution.
- Performance:
  - Warm path action latency target < 700ms for simple handlers.
  - Cold path (new action generation) target < 8s.
- Security:
  - Do not expose `OPENAI_API_KEY` to browser.
  - Enforce sandbox global allowlist.
  - Restrict outbound network in production to approved domains.
- Maintainability:
  - Prompt templates and runtime policies must be configurable.

## 9. API Contracts (MVP)

### 9.1 `GET /health`
Response:
```json
{ "ok": true }
```

### 9.2 `GET /spec/:appId`
Response: `text/markdown`

### 9.3 `POST /spec/:appId`
Request:
```json
{ "content": "# My App\n..." }
```
Response:
```json
{ "status": "saved", "bytes": 1234 }
```

### 9.4 `POST /render/:appId`
Request: empty body (MVP)
Response:
```json
{ "html": "<!doctype html>..." }
```

### 9.5 `POST /action/:appId/:action`
Request:
```json
{ "payload": { "any": "json" } }
```
Response (success):
```json
{
  "status": "ok",
  "output": { "any": "json" },
  "logs": ["..."],
  "codeHash": "sha256..."
}
```
Response (error):
```json
{ "status": "error", "error": "message" }
```

## 10. Storage Design

### 10.1 MVP File Layout
- `specs/<appId>.md`: source-of-truth app spec.
- `actions/<action>.js`: generated action handlers (currently global by name).

### 10.2 Required Improvement
Action caching key must include `appId` to avoid cross-app collisions:
- Proposed: `actions/<appId>/<action>.js`.

### 10.3 Production Upgrade Path
- Postgres:
  - `apps(app_id, owner_id, created_at, updated_at)`
  - `app_specs(app_id, version, markdown, created_at)`
  - `actions(app_id, action_name, version, code, hash, status, created_at)`
  - `action_runs(run_id, app_id, action_name, input_json, output_json, status, duration_ms, created_at)`
- Object storage for large artifacts/log blobs if needed.

## 11. Prompting and Generation Policy

### 11.1 Render Prompt Requirements
- Return only HTML.
- Include explicit action wiring helpers.
- Keep UI self-contained.
- Avoid external JS dependencies for MVP.

### 11.2 Action Prompt Requirements
- Return only runnable JavaScript (no fences).
- Export `handler(input, ctx)`.
- No file system/process access.
- Output must be JSON-serializable.

### 11.3 Repair Loop
- Trigger only on deterministic runtime or syntax errors.
- Provide prior code + error trace to model.
- Stop after max attempts and return structured failure.

## 12. Security Model

### 12.1 Secrets
- `OPENAI_API_KEY` loaded from server environment only.
- Never sent to frontend.

### 12.2 Sandbox Guardrails
- Disallow `require`, `process`, `child_process`, `fs`, and dynamic import.
- Hard execution timeout.
- Cap response size and log size.

### 12.3 Frontend Isolation
- Generated app runs in iframe.
- Use restrictive iframe sandbox attributes.
- Use CSP in production.

### 12.4 Input Validation
- Validate payload size and schema per action (phase 2).
- Sanitize/validate appId and action names for path safety.

## 13. Failure Modes and Handling
- Missing/invalid spec: return clear 4xx.
- Model call failure: return 502-like error payload.
- Invalid generated code: run repair loop then fail.
- Action timeout: return `status:error` with timeout reason.
- Non-serializable output: coerce or fail with explanation.

## 14. MVP Scope Definition
MVP is complete when:
- A user can author a spec, generate UI, and interact with app actions.
- First action call generates backend code automatically.
- Repeated action call reuses cached code.
- Logs and outputs are visible to operator.
- All secrets remain server-side.

## 15. Acceptance Criteria
- `GET /health` works.
- Spec save/load roundtrip works for arbitrary markdown.
- Render endpoint returns valid HTML for seeded SEC app spec.
- First call to `search_filings` produces generated action file and successful output.
- Second call to same action executes without regeneration.
- Action runtime enforces timeout and returns structured errors.

## 16. Immediate Engineering Tasks
1. Namespace action cache by `appId`.
2. Implement action repair loop with max retries.
3. Add schema validation for action request/response.
4. Add minimal request logging with correlation IDs.
5. Add integration tests for render + action cold/warm paths.
6. Add basic auth token for API endpoints.

## 17. Open Questions
- Should action code be regenerated when spec version changes?
- Do we permit external network calls from actions in MVP (SEC only vs unrestricted)?
- Should frontend generation be cached per spec hash?
- Should `render` also return a machine-readable UI contract for observability?
