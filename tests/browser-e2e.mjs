/**
 * Headless-browser E2E for the examples harness (classical paths + engine
 * contract). Run: node tests/browser-e2e.mjs  (spawns its own Vite server;
 * requires `npm run build` first). Exits non-zero on any failure.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'http://localhost:5199/';

// Playwright is not a repo dependency; resolve it from wherever it exists —
// repo node_modules, or PLAYWRIGHT_DIR (a dir containing node_modules with
// playwright-core), e.g. PLAYWRIGHT_DIR=/tmp/upscaler-e2e
const { chromium } = await (async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const req = createRequire(import.meta.url);
  const searchPaths = [
    ...(process.env.PLAYWRIGHT_DIR ? [process.env.PLAYWRIGHT_DIR] : []),
    root,
  ];
  for (const dir of searchPaths) {
    try {
      const resolved = req.resolve('playwright-core', { paths: [dir] });
      const mod = await import(pathToFileURL(resolved).href);
      const lib = mod.chromium ?? mod.default?.chromium;
      if (lib) return { chromium: lib };
    } catch {
      /* try next */
    }
  }
  console.error('browser E2E requires playwright-core: install it anywhere and set PLAYWRIGHT_DIR to that project dir');
  process.exit(1);
})();

const shell = process.env.CHROME_HEADLESS_SHELL ?? '/home/aryan/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';

// 1. Launch Vite dev server.
const vite = spawn('npx', ['vite', 'examples/', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'ignore' });
try {
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(500);
    up = await fetch(BASE).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error('vite dev server did not come up on :5199');

  // 2. Drive the harness.
  const browser = await chromium.launch({ executablePath: shell, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  const coi = await page.evaluate(() => crossOriginIsolated);
  check('crossOriginIsolated (COOP/COEP)', coi === true, String(coi));

  await page.click('#detect');
  await page.waitForSelector('#caps:not([hidden])', { timeout: 15000 });
  const caps = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#caps tr')];
    return Object.fromEntries(rows.map((r) => [r.children[0].textContent, r.children[1].textContent]));
  });
  check('detectDevice() renders wasm=true', caps.wasm === 'true', JSON.stringify(caps));
  check('detectDevice() renders all four capability keys', 'webgpu' in caps && 'wasmThreads' in caps && 'lowVram' in caps);

  // Two-Gate: neural before loadModel() throws a typed error.
  await page.selectOption('#method', 'neural');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 64, 48);
    g.addColorStop(0, '#ff3366');
    g.addColorStop(1, '#3366ff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 48);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'gradient.png', { type: 'image/png' }));
    document.querySelector('#file').files = dt.files;
  });
  await page.click('#run');
  await page.waitForFunction(() => document.querySelector('#log')?.textContent.includes('process failed'), null, { timeout: 15000 });
  check(
    'neural without loadModel() throws typed Two-Gate error',
    await page.evaluate(() => document.querySelector('#log').textContent.includes('requires a prior loadModel')),
  );

  // Classical lanczos 2x.
  await page.selectOption('#method', 'lanczos');
  await page.selectOption('#scale', '2');
  await page.click('#run');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#log .ok')].some((el) => el.textContent === 'complete'),
    null,
    { timeout: 60000 },
  );
  const out = await page.evaluate(() => {
    const img = document.querySelector('#output');
    return { w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 5), meta: document.querySelector('#outMeta').textContent };
  });
  check('lanczos 2x complete: output is 128x96', out.w === 128 && out.h === 96, JSON.stringify(out));
  check('blob URL contract (blob: scheme + revoke note)', out.src === 'blob:' && out.meta.includes('revoke'));
  check(
    'classical reports a single tile',
    await page.evaluate(() => document.querySelector('#log').textContent.includes('tile_processing 1/1')),
  );

  // Bicubic 4x.
  await page.selectOption('#method', 'bicubic');
  await page.selectOption('#scale', '4');
  await page.click('#run');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#log .ok')].filter((el) => el.textContent === 'complete').length >= 2,
    null,
    { timeout: 60000 },
  );
  const out4 = await page.evaluate(() => {
    const img = document.querySelector('#output');
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  check('bicubic 4x complete: output is 256x192', out4.w === 256 && out4.h === 192, JSON.stringify(out4));

  check('no console/page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
} finally {
  vite.kill('SIGTERM');
}
