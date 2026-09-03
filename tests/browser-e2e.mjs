/**
 * Headless-browser E2E for the examples harness — ONE-CLICK FLOW edition.
 * Run: node tests/browser-e2e.mjs  (spawns its Vite server; requires
 * `npm run build` first). Exits non-zero on any failure.
 *
 * v0.3.1 additions (mechanical, cannot be eyeballed away):
 *  - classical run = ONE click → complete + result view, ZERO error lines;
 *  - neural decline = consent modal appears, declining never renders the
 *    engine's typed error and never downloads (network counter stays 0);
 *  - meta row answers "did it even upscale" (dims · size · method · format).
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'http://localhost:5199/';

const { chromium } = await (async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const req = createRequire(import.meta.url);
  const searchPaths = [...(process.env.PLAYWRIGHT_DIR ? [process.env.PLAYWRIGHT_DIR] : []), root];
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

const shell =
  process.env.CHROME_HEADLESS_SHELL ??
  '/home/aryan/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';

const vite = spawn('npx', ['vite', 'examples/', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'ignore' });
try {
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(500);
    up = await fetch(BASE).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error('vite dev server did not come up on :5199');

  const browser = await chromium.launch({ executablePath: shell, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  let modelRequests = 0;
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('request', (req) => {
    if (req.url().includes('huggingface.co') && req.url().includes('/resolve/')) modelRequests++;
  });

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  const coi = await page.evaluate(() => crossOriginIsolated);
  check('crossOriginIsolated (COOP/COEP)', coi === true, String(coi));

  const engineExposed = await page.evaluate(() => typeof window.__engine !== 'undefined');
  check('window.__engine exposed for gates', engineExposed);

  await page.click('#detect');
  await page.waitForSelector('#caps:not([hidden])', { timeout: 15000 });
  const capsText = await page.evaluate(() => document.querySelector('#caps').textContent);
  check('detectDevice() renders wasm=true', /wasm:\s*true/.test(capsText), capsText.split('\n')[0]);

  // ——— ONE-CLICK classical flow ————————————————————————————————————————
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
    document.querySelector('#file').dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => !document.querySelector('#run').disabled, null, { timeout: 15000 });

  await page.click('#run'); // THE one click.
  await page.waitForFunction(
    () => [...document.querySelectorAll('#log .line--ok')].some((el) => el.textContent.endsWith('complete')),
    null,
    { timeout: 60000 },
  );
  check('ONE click → complete (classical)', true);

  const happyErrors = await page.evaluate(() =>
    [...document.querySelectorAll('#log .line--err')].map((el) => el.textContent),
  );
  check('ZERO error-styled lines on the happy path', happyErrors.length === 0, happyErrors.join(' | ').slice(0, 200));

  const out = await page.evaluate(() => {
    const img = document.querySelector('#output');
    return {
      w: img.naturalWidth,
      h: img.naturalHeight,
      src: img.src.slice(0, 5),
      meta: document.querySelector('#outMeta').textContent,
    };
  });
  check('lanczos 2x output is 128x96', out.w === 128 && out.h === 96, JSON.stringify(out));
  check('meta answers "did it even upscale" (dims · size · method)', /128×96/.test(out.meta) && /lanczos/i.test(out.meta), out.meta);
  check('blob URL contract (blob: scheme)', out.src === 'blob:');
  check('classical honesty note visible under result', await page.evaluate(() => !document.querySelector('#classicalNote').hidden));
  check('no model download lines on classical', await page.evaluate(() => !document.querySelector('#log').textContent.includes('model download')));

  // ——— Neural decline: modal, no engine error, no download ————————————
  await page.click('#method-neural');
  await page.click('#run');
  await page.waitForFunction(() => !document.querySelector('#consentModal').hidden, null, { timeout: 15000 });
  const twoGateLeak = await page.evaluate(() =>
    document.querySelector('#log').textContent.includes('requires a prior loadModel'),
  );
  check('neural Run → consent modal WITHOUT the typed error', twoGateLeak === false);
  await page.click('#consentCancel');
  check('decline reverts to Medium with an info line', await page.evaluate(() => document.querySelector('#log').textContent.includes('stayed on Medium')));
  check('decline triggered ZERO model downloads', modelRequests === 0, `model requests=${modelRequests}`);

  check('no console/page errors overall', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
} finally {
  vite.kill('SIGTERM');
}
