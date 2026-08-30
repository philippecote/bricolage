/**
 * A curated list of MCP servers Workshop offers by name.
 *
 * An MCP server is an arbitrary local process that Workshop spawns with whatever
 * environment it is given, so `npx -y anything` is remote code execution by
 * design. Two rules keep this list defensible:
 *
 *  1. Publisher provenance, not popularity. Every entry lives under an npm org
 *     scope that only its vendor can publish to — @modelcontextprotocol (Anthropic),
 *     @notionhq (Notion), @sentry (Sentry), @playwright. An unscoped package name
 *     is claimable by anyone and is never listed here.
 *  2. Pinned versions. `@latest` would let a future compromised release execute on
 *     the next add. Versions here are moved deliberately, not automatically.
 *
 * Anything outside this list is still reachable through "Add manually", which
 * says plainly what it is about to run.
 */
export const CONNECTION_CATALOG = [
  {
    // The strongest option when it is available: every server runs in a
    // container rather than as a bare process holding Workshop's whole
    // environment, secrets come from Docker Desktop's store, and one stdio
    // connection fronts the entire catalog. Needs Docker Desktop running.
    id: 'docker',
    label: 'Docker MCP Gateway',
    publisher: 'docker',
    summary: 'Hundreds of servers, each sandboxed in its own container. Pick which ones in Docker Desktop.',
    command: 'docker',
    args: ['mcp', 'gateway', 'run', '--block-secrets'],
    inputs: [],
    secrets: [],
    caution: 'Requires Docker Desktop to be running. Manage which servers are enabled and their credentials in Docker Desktop, not here.',
  },
  {
    id: 'files',
    label: 'Local Files',
    publisher: '@modelcontextprotocol',
    summary: 'Read and write files inside one folder you choose.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@2026.7.10'],
    // Everything after args is appended; the folder is the sandbox boundary.
    inputs: [{ key: 'directory', label: 'Folder to share', placeholder: '/Users/you/Documents/notes', appendToArgs: true }],
    secrets: [],
    caution: 'Apps granted this can read and change every file in that folder. Pick a specific folder, never your home directory.',
  },
  {
    id: 'notion',
    label: 'Notion',
    publisher: '@notionhq',
    summary: 'Search and read pages and databases in your Notion workspace.',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server@2.5.1'],
    inputs: [],
    secrets: [{ key: 'NOTION_TOKEN', label: 'Notion integration token', hint: 'Create one at notion.so/profile/integrations, then share the pages you want reachable with it.' }],
    caution: 'The token decides what is reachable. Share only the pages this needs.',
  },
  {
    id: 'sentry',
    label: 'Sentry',
    publisher: '@sentry',
    summary: 'Look up issues and events from your Sentry projects.',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server@0.39.0'],
    inputs: [],
    secrets: [{ key: 'SENTRY_ACCESS_TOKEN', label: 'Sentry access token', hint: 'Create a user auth token in Sentry settings with read scopes.' }],
    caution: 'Use a read-only token.',
  },
  {
    id: 'browser',
    label: 'Browser',
    publisher: '@playwright',
    summary: 'Open pages and read them, so an app can work with the live web.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.79', '--headless'],
    inputs: [],
    secrets: [],
    caution: 'A page an app visits is untrusted content. Never let one decide what the app does next.',
  },
  {
    id: 'memory',
    label: 'Shared Memory',
    publisher: '@modelcontextprotocol',
    summary: 'A small knowledge graph apps can write notes into and read back.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory@2026.7.4'],
    inputs: [],
    secrets: [],
    caution: 'Every app you grant this shares one store, so they can read each other\'s notes.',
  },
];

export function catalogEntry(id) {
  return CONNECTION_CATALOG.find((entry) => entry.id === id) || null;
}

/**
 * Turns a catalog pick plus the person's answers into a connection definition.
 * Inputs are appended as arguments; secrets become env values, and a bare $NAME
 * stays a reference to Workshop's own environment rather than a stored copy.
 */
export function buildFromCatalog(id, { values = {}, secrets = {} } = {}) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`No catalog entry named "${id}".`);

  const args = [...entry.args];
  for (const input of entry.inputs) {
    const value = String(values[input.key] ?? '').trim();
    if (!value) throw new Error(`${entry.label} needs ${input.label.toLowerCase()}.`);
    if (input.appendToArgs) args.push(value);
  }

  const env = {};
  for (const secret of entry.secrets) {
    const value = String(secrets[secret.key] ?? '').trim();
    if (!value) throw new Error(`${entry.label} needs ${secret.label.toLowerCase()}.`);
    env[secret.key] = value;
  }

  return { id: entry.id, label: entry.label, command: entry.command, args, env };
}
