/**
 * PHASE 2 NEURAL GATE — live neural verification against SHA-pinned
 * HuggingFace models, through the REAL engine + worker + examples harness.
 *
 * Checks:
 *  (a) session init via engine env (wasmPaths CDN, jsep, threads, proxy:false)
 *  (c) catalog selection per probed hardware (real probe; simulated no-WebGPU
 *      run separately) — records which EP/variant executed
 *  (d) 4x output sanity: exact dims, pixel stats, differs from bicubic
 *  (e) 2x output: exact dims (4x model → Lanczos downscale)
 *  (g) cache-first: fresh page loadModel() issues NO model network request
 *      and emits no download progress; result reports cached: true
 *  (h) WASM-EP neural run on the wasm variant completes
 *  (j) Two-Gate regression: neural before loadModel() throws
 *
 * Run: PLAYWRIGHT_DIR=<dir with playwright-core> node tests/neural-gate.mjs
 * Requires `npm run build` (dist/) and network to huggingface.co + jsdelivr.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'http://localhost:5199/';

const MODELS = {
  webgpu: 'https://huggingface.co/FuryTMP/RealESR_Gx4_fp16/resolve/3767133b06ab19a3636b342d44f5d2da5c3a132e/RealESR_Gx4_fp16.onnx',
  wasm: 'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/488e5dda07333179f229a6205d92135eea4c25e9/realesr-general-x4v3.onnx',
};

const { chromium } = await (async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const req = createRequire(import.meta.url);
  const dirs = [process.env.PLAYWRIGHT_DIR, root].filter(Boolean);
  for (const dir of dirs) {
    try {
      const resolved = req.resolve('playwright-core', { paths: [dir] });
      const mod = await import(pathToFileURL(resolved).href);
      const lib = mod.chromium ?? mod.default?.chromium;
      if (lib) return { chromium: lib };
    } catch {
      /* next */
    }
  }
  console.error('playwright-core not found (set PLAYWRIGHT_DIR)');
  process.exit(1);
})();

const shell =
  process.env.CHROME_HEADLESS_SHELL ??
  '/home/aryan/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';

const evidence = [];
const check = (name, ok, detail = '') => {
  evidence.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const vite = spawn('npx', ['vite', 'examples/', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'ignore' });

async function waitVite() {
  for (let i = 0; i < 30; i++) {
    if (await fetch(BASE).then((r) => r.ok).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error('vite did not start');
}

async function newPage(browser, { hideWebGPU = false } = {}) {
  const context = await browser.newContext();
  if (hideWebGPU) {
    // Simulated WebGPU-less device BEFORE any page script runs — exercises
    // the honest probe path (requestAdapter absent → webgpu: false).
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined });
    });
  }
  const page = await context.newPage();
  const net = { model: 0, ort: 0 };
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('huggingface.co') && u.includes('/resolve/')) net.model++;
    if (u.includes('cdn.jsdelivr.net/npm/onnxruntime-web')) net.ort++;
  });
  return { context, page, net };
}

async function clickLoadModel(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const logEl = document.querySelector('#log');
        const before = logEl.textContent.length;
        // Consent modal flow: if the modal is already open (e.g. it opened on
        // the Two-Gate typed error), accept it directly; otherwise open it
        // via #loadModel, then accept. Accepting IS the consent.
        const modal = document.querySelector('#consentModal');
        if (modal && !modal.hidden) {
          document.querySelector('#consentAccept').click();
        } else {
          document.querySelector('#loadModel').click();
          const acceptWhenOpen = () => {
            const m = document.querySelector('#consentModal');
            if (m && !m.hidden) {
              document.querySelector('#consentAccept').click();
            } else {
              setTimeout(acceptWhenOpen, 50);
            }
          };
          setTimeout(acceptWhenOpen, 50);
        }
        const obs = new MutationObserver(() => {
          const text = logEl.textContent.slice(before);
          const m = text.match(/model ready — variant=(\w+) cached=(\w+)/);
          if (m) {
            obs.disconnect();
            resolve({ ok: true, variant: m[1], cached: m[2] === 'true' });
          }
          if (text.includes('loadModel failed')) {
            obs.disconnect();
            resolve({ ok: false, log: text.trim() });
          }
        });
        obs.observe(logEl, { childList: true, subtree: true, characterData: true });
      }),
  );
}

async function injectTestImage(page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 96, 96);
    g.addColorStop(0, '#e74c8b');
    g.addColorStop(0.5, '#f9d423');
    g.addColorStop(1, '#1f6feb');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.beginPath();
    ctx.arc(30, 38, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(56, 58, 26, 10);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 64, 22, 22);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'synthetic-96.png', { type: 'image/png' }));
    const input = document.querySelector('#file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Runs process() with the given options and returns { ok, imageStats } where
 * imageStats are luminance stats of the CURRENT output img at completion.
 * Polls the harness log from Node (no waitForFunction) and dumps state on stall. */
async function runProcess(page, method, scale, timeoutMs = 300000) {
  await page.click(`#method-${method}`);
  await page.click(`#scaleSeg button[data-scale="${scale}"]`);
  // Markers are DELTAS over the pre-click log: '#log .ok' also holds the
  // 'model ready' line, and the log keeps stale 'process failed' lines from
  // earlier checks (e.g. the Two-Gate probe), so absolute substring scans
  // would both miss the target and fire on old failures.
  const marker = await page.evaluate(() => ({
    complete: [...document.querySelectorAll('#log .line--ok')].filter((el) => el.textContent.endsWith('complete')).length + 1,
    failed: [...document.querySelectorAll('#log .line--err')].filter((el) => el.textContent.includes('process failed')).length,
  }));
  await page.click('#run');

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(2500);
    const state = await page.evaluate((m) => {
      const logEl = document.querySelector('#log');
      const ok = [...logEl.querySelectorAll('.line--ok')].filter((el) => el.textContent.endsWith('complete')).length;
      const failed = [...logEl.querySelectorAll('.line--err')].filter((el) => el.textContent.includes('process failed')).length;
      return { ok, failed: failed > m.failed, tail: logEl.textContent.slice(-200) };
    }, marker);
    if (state.failed) {
      return { ok: false, logTail: state.tail };
    }
    if (state.ok >= marker.complete) {
      break;
    }
    if (Date.now() > deadline) {
      console.log(`        [stall dump after ${timeoutMs}ms] ${state.tail.replace(/\n/g, ' | ')}`);
      return { ok: false, logTail: `STALL: ${state.tail}` };
    }
  }
  return page.evaluate((base) => {
    const logEl = document.querySelector('#log');
    const log = logEl.textContent;
    const failed = [...logEl.querySelectorAll('.line--err')].filter((el) => el.textContent.includes('process failed')).length;
    if (failed > base) return { ok: false, logTail: log.slice(-300) };
    const img = document.querySelector('#output');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sum2 = 0, min = 255, max = 0;
    const chans = [[], [], []];
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += lum;
      sum2 += lum * lum;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      chans[0].push(d[i]);
      chans[1].push(d[i + 1]);
      chans[2].push(d[i + 2]);
    }
    const n = d.length / 4;
    const mean = sum / n;
    const std = Math.sqrt(sum2 / n - mean * mean);
    return {
      ok: true,
      w: img.naturalWidth,
      h: img.naturalHeight,
      mean,
      std,
      min,
      max,
      chanStd: chans.map((arr) => {
        const m = arr.reduce((a, b) => a + b, 0) / arr.length;
        return Math.round(Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length) * 10) / 10;
      }),
    };
  }, marker.failed);
}

/** Captures current output pixels as a plain array for later diffing. */
async function captureOutput(page) {
  return page.evaluate(() => {
    const img = document.querySelector('#output');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
  });
}

try {
  await waitVite();

  // ——— Primary environment (software GPU flags — WebGPU may or may not
  //      probe; whichever way it goes is recorded honestly) ———————————————
  const browser = await chromium.launch({
    executablePath: shell,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=swiftshader'],
  });
  const { context, page, net } = await newPage(browser);
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  const env = await page.evaluate(async () => ({
    crossOriginIsolated,
    webgpuProbe: await (async () => {
      try {
        const a = await navigator.gpu?.requestAdapter();
        return a ? 'adapter' : 'null';
      } catch {
        return 'rejected';
      }
    })(),
  }));
  const EP = env.webgpuProbe === 'adapter' ? 'webgpu' : 'wasm';
  console.log(`env: crossOriginIsolated=${env.crossOriginIsolated} webgpuProbe=${env.webgpuProbe} → EP expected: ${EP}`);

  await injectTestImage(page);

  // (a/c) loadModel through the harness button — catalog selection.
  const load1 = await clickLoadModel(page);
  check(
    `(a/c) loadModel selects the ${EP} variant per probed hardware`,
    load1.ok === true && load1.variant === EP,
    `result=${JSON.stringify(load1)}`,
  );
  check('(a) model fetched from the pinned URL (network seen for variant file)', net.model >= 1 || load1.cached, `model requests=${net.model}`);
  check('(a) first loadModel streams download progress (not a cache hit)', await page.evaluate(() => document.querySelector('#log').textContent.includes('model_download')));
  check('(a) no console/page errors during session init', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  // (d) neural 4x.
  const n4 = await runProcess(page, 'neural', 4);
  check('(d) neural 4x completes with exactly 384x384 output', n4.ok === true && n4.w === 384 && n4.h === 384, n4.ok ? `${n4.w}x${n4.h}` : n4.logTail);
  if (n4.ok) {
    const sane = n4.mean > 20 && n4.mean < 235 && n4.std > 15 && n4.std < 110 && n4.chanStd.every((v) => v > 8) && n4.max - n4.min > 60;
    check('(d) pixel stats non-degenerate', sane, `mean=${n4.mean.toFixed(1)} std=${n4.std.toFixed(1)} chanStd=${n4.chanStd} range=${n4.min.toFixed(0)}..${n4.max.toFixed(0)}`);
    const neuralPixels = await captureOutput(page);

    // (d) differs from bicubic 4x of the same input.
    const b4 = await runProcess(page, 'bicubic', 4);
    check('(d) bicubic 4x regression after neural', b4.ok === true && b4.w === 384 && b4.h === 384, b4.ok ? `${b4.w}x${b4.h}` : b4.logTail);
    const diff = await page.evaluate(({ a, b }) => {
      let sad = 0;
      for (let i = 0; i < a.length; i += 4) {
        sad += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      }
      return sad / (a.length / 4) / 3;
    }, { a: neuralPixels, b: await captureOutput(page) });
    check('(d) neural differs meaningfully from bicubic 4x', diff > 1.0, `meanAbsDiff=${diff.toFixed(2)} per channel`);
  }

  // (e) neural 2x = 4x model → Lanczos downscale.
  const n2 = await runProcess(page, 'neural', 2);
  check('(e) neural 2x completes with exactly 192x192 output', n2.ok === true && n2.w === 192 && n2.h === 192, n2.ok ? `${n2.w}x${n2.h}` : n2.logTail);

  // (g) cache-first: FRESH page in the same context (same Cache Storage).
  const page2Net = { model: 0 };
  const page2 = await context.newPage();
  page2.on('request', (req) => {
    if (req.url().includes('huggingface.co') && req.url().includes('/resolve/')) page2Net.model++;
  });
  await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await injectTestImage(page2);
  const load2 = await clickLoadModel(page2);
  check('(g) fresh page: loadModel reports cached=true', load2.ok === true && load2.cached === true, JSON.stringify(load2));
  check('(g) fresh page: ZERO network requests for the model file', page2Net.model === 0, `model requests=${page2Net.model}`);
  check('(g) fresh page: no model_download progress events', !(await page2.evaluate(() => document.querySelector('#log').textContent.includes('model_download'))));

  await browser.close();

  // ——— (h)+(j) Simulated WebGPU-less device → wasm variant + WASM-EP run ——
  const browser2 = await chromium.launch({ executablePath: shell, args: ['--no-sandbox'] });
  const { page: page3, net: net3 } = await newPage(browser2, { hideWebGPU: true });
  const consoleErrors3 = [];
  page3.on('console', (msg) => { if (msg.type() === 'error') consoleErrors3.push(msg.text()); });
  page3.on('pageerror', (err) => consoleErrors3.push(`pageerror: ${err.message}`));
  await page3.goto(BASE, { waitUntil: 'domcontentloaded' });

  await page3.click('#detect');
  await page3.waitForSelector('#caps:not([hidden])', { timeout: 15000 });
  const capsShown = await page3.evaluate(() => document.querySelector('#caps').textContent);
  check('(c) no-WebGPU env shows honest webgpu=false badge', /webgpu:\s*false/.test(capsShown), capsShown);

  // (j) Two-Gate regression first: neural before loadModel must throw.
  await injectTestImage(page3);
  await page3.click('#method-neural');
  await page3.click('#scaleSeg button[data-scale="4"]');
  await page3.click('#run');
  await page3.waitForFunction(() => document.querySelector('#log').textContent.includes('process failed'), null, { timeout: 15000 });
  check('(j) Two-Gate: neural before loadModel() throws typed error', await page3.evaluate(() => document.querySelector('#log').textContent.includes('requires a prior loadModel')));

  const load3 = await clickLoadModel(page3);
  check('(c/h) no-WebGPU env: catalog selects wasm variant', load3.ok === true && load3.variant === 'wasm', JSON.stringify(load3));
  check('(c/h) wasm variant fetched from its pinned URL', net3.model >= 1 || load3.cached, `model requests=${net3.model}`);

  const w4 = await runProcess(page3, 'neural', 4);
  check('(h) WASM-EP neural run completes with exactly 384x384 output', w4.ok === true && w4.w === 384 && w4.h === 384, w4.ok ? `${w4.w}x${w4.h}` : w4.logTail);
  if (w4.ok) {
    const sane = w4.mean > 20 && w4.mean < 235 && w4.std > 15 && w4.std < 110 && w4.chanStd.every((v) => v > 8);
    check('(h) WASM-EP output non-degenerate', sane, `mean=${w4.mean.toFixed(1)} std=${w4.std.toFixed(1)} chanStd=${w4.chanStd}`);
  }
  check('(h) no console/page errors on the WASM path', consoleErrors3.length === 0, consoleErrors3.join(' | ').slice(0, 300));

  await browser2.close();
} finally {
  vite.kill('SIGTERM');
}

const failed = evidence.filter((e) => !e.ok);
console.log(`\n${evidence.length - failed.length}/${evidence.length} neural-gate checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
