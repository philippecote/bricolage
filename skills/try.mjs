#!/usr/bin/env node
/**
 * Run this app's own actions while you build it.
 *
 *   node .bricolage/try.mjs                      list actions and connection tools
 *   node .bricolage/try.mjs <action> '<json>'    run one action with a payload
 *
 * This calls the real Bricolage server, so the action runs with the real
 * connections, the real sandbox and the real ctx — exactly as it will when the
 * person uses it. Use it to check your work instead of simulating anything.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(here);
const base = '__BASE__';

const manifest = JSON.parse(await fs.readFile(path.join(appDir, 'manifest.json'), 'utf8'));
const [action, payloadJson] = process.argv.slice(2);

async function api(pathname, init) {
  const response = await fetch(`${base}${pathname}`, init);
  const body = await response.text();
  try { return JSON.parse(body); } catch { throw new Error(`${pathname} -> ${response.status} ${body.slice(0, 200)}`); }
}

if (!action) {
  console.log(`app        ${manifest.id}`);
  console.log(`actions    ${(manifest.actions || []).join(', ') || '(none yet)'}`);
  console.log(`granted    ${(manifest.connections || []).join(', ') || '(none — add ids to manifest.connections)'}`);
  const { connections = [] } = await api('/api/connections?probe=1');
  for (const connection of connections) {
    const granted = (manifest.connections || []).includes(connection.id);
    console.log(`\n${connection.id}${granted ? '' : '   NOT granted to this app'}`);
    if (connection.error) console.log(`  ${connection.error}`);
    for (const tool of connection.tools) {
      const required = new Set(tool.required || []);
      const args = (tool.args || []).map((name) => (required.has(name) ? name : `${name}?`)).join(', ');
      console.log(`  ${tool.name}(${args})`);
    }
  }
  console.log('\nRun one:  node .bricolage/try.mjs <action> \'{"key":"value"}\'');
  process.exit(0);
}

let payload = {};
if (payloadJson) {
  try { payload = JSON.parse(payloadJson); }
  catch { console.error('The payload must be JSON in single quotes, e.g. \'{"path":"/tmp"}\''); process.exit(1); }
}

const result = await api(`/api/apps/${manifest.id}/actions/${action}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ payload }),
});

if (result.status !== 'ok') { console.error(`FAILED  ${result.error}`); process.exit(1); }
console.log(JSON.stringify(result.output, null, 2));
if (result.logs?.length) console.error(`\nconsole:\n${result.logs.map((line) => `  ${line}`).join('\n')}`);
