#!/usr/bin/env node
/**
 * Look at the app you are building.
 *
 *   node .bricolage/see.mjs                what it renders, plus anything broken
 *   node .bricolage/see.mjs --shot         also write .bricolage/screen.png
 *   node .bricolage/see.mjs --wait 6000    give a slow first paint longer
 *
 * This loads the app in a real browser, with the host bridge answered exactly as
 * the desktop answers it, and reports what came out: the visible text, any
 * script error, any failed action, and anything the app logged. Reading the
 * source tells you what should happen; this tells you what does.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(here);
const base = 'http://127.0.0.1:4000';

const argv = process.argv.slice(2);
const wantsShot = argv.includes('--shot');
const waitMs = Number(argv[argv.indexOf('--wait') + 1]) || 3500;

const manifest = JSON.parse(await fs.readFile(path.join(appDir, 'manifest.json'), 'utf8'));

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.error('This needs playwright. From the Bricolage repo: npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 650 } });

const logs = [];
const errors = [];
page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) logs.push(`${message.type()}: ${message.text()}`.slice(0, 300)); });
page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 300)));

// A rejected promise in an async boot never reaches pageerror, so the app just
// stops half-loaded with nothing reported. Catch those in the page itself.
await page.addInitScript(() => {
  window.__thrown = [];
  addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.__thrown.push(String((reason && (reason.stack || reason.message)) || reason).slice(0, 400));
  });
  addEventListener('error', (event) => window.__thrown.push(String(event.message).slice(0, 400)));
});

await page.goto(`${base}/probe/${manifest.id}`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(waitMs);

const frame = page.frames().find((f) => f.url().includes('/runtime/'));
if (!frame) { console.error('The app frame never loaded.'); await browser.close(); process.exit(1); }

// What a person would actually see, and what they could actually press.
const view = await frame.evaluate(() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && box.width > 0 && box.height > 0;
  };
  const text = (document.body.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')]
    .filter(visible)
    .map((el) => `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''}: ${(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 60)}`)
    .filter((line) => line.split(': ')[1]);
  // An invisible full-bleed layer is a real bug and easy to miss in source.
  const covering = [...document.querySelectorAll('body *')].filter((el) => {
    const box = el.getBoundingClientRect();
    return visible(el) && box.width >= innerWidth * 0.9 && box.height >= innerHeight * 0.9 && getComputedStyle(el).position === 'fixed';
  }).map((el) => `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`);
  return { text: text.slice(0, 60), controls: controls.slice(0, 30), covering: covering.slice(0, 5) };
});

const probe = await page.evaluate(() => window.__probe || { errors: [], calls: [] });
const thrown = await frame.evaluate(() => window.__thrown || []).catch(() => []);

console.log(`${manifest.name} — what it renders\n`);
console.log(view.text.length ? view.text.map((line) => `  ${line}`).join('\n') : '  (nothing visible)');
if (view.controls.length) console.log(`\ncontrols\n${view.controls.map((line) => `  ${line}`).join('\n')}`);
if (view.covering.length) console.log(`\nfull-screen layers on top (a hidden one here means the app is covered)\n${view.covering.map((line) => `  ${line}`).join('\n')}`);
if (probe.calls.length) console.log(`\nactions it called\n${probe.calls.map((c) => `  ${c.action} ${c.ok ? 'ok' : `FAILED: ${c.error}`}`).join('\n')}`);
const allErrors = [...errors, ...thrown];
if (allErrors.length) console.log(`\nscript errors\n${allErrors.map((line) => `  ${line}`).join('\n')}`);
if (logs.length) console.log(`\nconsole\n${logs.slice(0, 15).map((line) => `  ${line}`).join('\n')}`);
if (!allErrors.length && !probe.calls.some((c) => !c.ok)) console.log('\nno script errors, no failed actions');

if (wantsShot) {
  const shot = path.join(here, 'screen.png');
  await frame.locator('body').screenshot({ path: shot }).catch(() => page.screenshot({ path: shot }));
  console.log(`\nscreenshot: .bricolage/screen.png  (open it with your Read tool)`);
}

await browser.close();
