# Workshop

Workshop is a local-first app desktop. Describe a small tool, let Codex build it in an isolated workspace, then launch and refine it like a desktop app.

## Experience

- macOS-inspired desktop, Dock, app windows, Spotlight (`⌘K`), library, archive, and settings
- prompt-to-app builds with live status, follow-up edits, approvals, cancellation, and version rollback
- persistent dependency-free mini-apps under `apps/<appId>/`
- opaque-origin iframe runtime with a host bridge for actions, storage, notifications, titles, and safe links
- sandboxed server actions with durable JSON storage and guarded public HTTPS access
- Codex App Server integration over local stdio using the current Codex login

## Requirements

- Node.js 18 or later
- Codex CLI installed and signed in

```bash
npm install -g @openai/codex
codex login
```

## Run

```bash
npm install
npm run build
npm start
```

Open [http://localhost:4000](http://localhost:4000).

For frontend development with live reload:

```bash
npm run dev
```

Vite runs at [http://127.0.0.1:4173](http://127.0.0.1:4173) and proxies API/runtime requests to Express on port 4000. The explicit loopback address and strict port prevent Workshop from silently attaching to another local Vite project.

## Configuration

```dotenv
PORT=4000
API_TOKEN=
CODEX_BIN=codex
```

`OPENAI_API_KEY` is optional and only supports the temporary legacy `/render` route. New Workshop builds use the local Codex session.

## Generated app contract

Each workspace contains `manifest.json`, `runtime/index.html`, optional `actions/*.js`, `data.json`, `AGENTS.md`, and revision snapshots under `.workshop/revisions/`.

Generated runtimes use the host bridge:

```js
await Workshop.callAction('search', { query: 'example' });
await Workshop.storage.set('items', []);
await Workshop.storage.get('items');
Workshop.notify('Saved');
Workshop.setTitle('My app');
Workshop.openLink('https://example.com');
```

## Test

```bash
npm test
npm run build
```

The suite covers the legacy API, Workshop readiness and migration, prompt-to-app builds with a mock Codex server, revisions, storage isolation, and runtime security headers.
