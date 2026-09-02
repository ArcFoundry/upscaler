/* Diagnose the neural hang: full console capture incl. worker messages. */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'http://localhost:5199/';
const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const req = createRequire(import.meta.url);
const mod = await import(pathToFileURL(req.resolve('playwright-core', { paths: [process.env.PLAYWRIGHT_DIR] })).href);
const chromium = mod.chromium ?? mod.default?.chromium;
const shell = '/home/aryan/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';

const vite = spawn('npx', ['vite', 'examples/', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'ignore' });
try {
  for (let i = 0; i < 30; i++) await sleep(500).then(() => fetch(BASE).then((r) => r.ok).catch(() => false)).then(Boolean).then((ok) => { if (!ok) throw 0; });
} catch { /* retried below */ }
for (let i = 0; i < 20; i++) { if (await fetch(BASE).then((r) => r.ok).catch(() => false)) break; await sleep(500); }

const browser = await chromium.launch({ executablePath: shell, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (msg) => console.log(`[console:${msg.type()}]`, msg.text().slice(0, 300)));
page.on('pageerror', (err) => console.log('[pageerror]', err.message.slice(0, 300)));
page.on('worker', (worker) => {
  console.log('[worker created]', worker.url());
  worker.on('console', (msg) => console.log(`[worker:${msg.type()}]`, msg.text().slice(0, 300)));
  worker.on('pageerror', (err) => console.log('[worker pageerror]', err.message.slice(0, 300)));
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });

await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 96; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e74c8b'; ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(40, 40, 12, 0, 7); ctx.fill();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 't.png', { type: 'image/png' }));
  document.querySelector('#file').files = dt.files;
  document.querySelector('#loadModel').click();
});

await sleep(40000);
console.log('--- after loadModel wait ---');
console.log(await page.evaluate(() => document.querySelector('#log').textContent));

await page.evaluate(() => {
  document.querySelector('#method').value = 'neural';
  document.querySelector('#scale').value = '4';
  document.querySelector('#run').click();
});

for (let i = 1; i <= 12; i++) {
  await sleep(10000);
  const log = await page.evaluate(() => document.querySelector('#log').textContent);
  console.log(`--- t+${i * 10}s ---`, log.slice(-260).replace(/\n/g, ' | '));
}

await browser.close();
vite.kill('SIGTERM');
process.exit(0);
