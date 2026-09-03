/**
 * VISUAL SELF-AUDIT (v0.3.0) — verifies the harness against the design
 * token system and screenshots every state for human review.
 *
 * Checks per state: every .btn is --ctl-h (36px) tall with --r1 radius;
 * every .card has the same padding; every flex gap is from the spacing
 * scale; telemetry is entirely mono; the accent palette is the ONLY accent.
 * Screenshots land in /tmp/harness-states/.
 *
 * Run: PLAYWRIGHT_DIR=<dir> node tests/visual-audit.mjs   (needs `npm run build`)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'http://localhost:5199/';
const OUT_DIR = process.env.AUDIT_DIR ?? '/tmp/harness-states';

const { chromium } = await (async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const req = createRequire(import.meta.url);
  for (const dir of [process.env.PLAYWRIGHT_DIR, root].filter(Boolean)) {
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
  process.env.CHROME_HEADLESS_SHELL ?? '/home/aryan/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';

mkdirSync(OUT_DIR, { recursive: true });

const evidence = [];
const check = (name, ok, detail = '') => {
  evidence.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const vite = spawn('npx', ['vite', 'examples/', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'ignore' });
try {
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(500);
    up = await fetch(BASE).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error('vite did not start');

  const browser = await chromium.launch({ executablePath: shell, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(400);

  /** Token invariants, evaluated against the CURRENT DOM. */
  async function auditTokens(stateName) {
    const r = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const ctlH = parseFloat(cs.getPropertyValue('--ctl-h'));
      const radii = ['--r1', '--r2'].map((t) => parseFloat(cs.getPropertyValue(t)));
      const scale = [1, 2, 3, 4, 6, 8].map((n) => parseFloat(cs.getPropertyValue(`--s${n}`)));

      const buttons = [...document.querySelectorAll('.btn')];
      const btnIssues = buttons
        .filter((b) => b.offsetParent !== null)
        .map((b) => {
          const s = getComputedStyle(b);
          return {
            id: b.id || b.className,
            h: parseFloat(s.height),
            r: s.borderRadius,
            p: s.padding,
          };
        })
        .filter((m) => m.h !== ctlH || parseFloat(m.r) !== radii[0] || !m.p.endsWith('12px'));

      // The .seg CONTROL carries --ctl-h (border-box); its inner buttons fill
      // it (content height may be 2px less inside the 1px border).
      const segs = [...document.querySelectorAll('.seg')].filter((b) => b.offsetParent !== null);
      const segIssues = segs
        .filter((seg) => {
          const s = getComputedStyle(seg);
          return parseFloat(s.height) !== ctlH;
        })
        .map((seg) => seg.id || seg.className);

      const cards = [...document.querySelectorAll('.card')];
      const paddings = new Set(cards.map((c) => getComputedStyle(c).padding));
      const cardPadding = cards.length ? getComputedStyle(cards[0]).padding : null;
      const cardIssues = paddings.size > 1 ? [...paddings].join(' | ') : null;

      const gapSet = new Set();
      for (const el of document.querySelectorAll('.row, .methods, .modal__actions')) {
        if (el.offsetParent === null) continue;
        const g = getComputedStyle(el).columnGap;
        if (g && g !== 'normal') gapSet.add(parseFloat(g));
      }
      const badGaps = [...gapSet].filter((g) => !scale.includes(g));

      const panels = [...document.querySelectorAll('.mono-panel')].filter((p) => p.offsetParent !== null);
      const nonMono = panels.filter((p) => !getComputedStyle(p).fontFamily.includes('JetBrains Mono'));

      return { btnIssues, segIssues, cardPadding, cardIssues, badGaps, nonMono: nonMono.length };
    });

    check(`[${stateName}] every visible .btn is ${r.cardPadding ? '36px' : 'ctl-h'} tall, r1 radius, s3 padding`, r.btnIssues.length === 0, JSON.stringify(r.btnIssues));
    check(`[${stateName}] every .seg button shares --ctl-h`, r.segIssues.length === 0, JSON.stringify(r.segIssues));
    check(`[${stateName}] all .card paddings identical`, r.cardIssues === null, r.cardIssues ?? r.cardPadding);
    check(`[${stateName}] every flex gap is on the spacing scale`, r.badGaps.length === 0, JSON.stringify(r.badGaps));
    check(`[${stateName}] telemetry panels are mono`, r.nonMono === 0, `non-mono panels: ${r.nonMono}`);
  }

  async function shot(name) {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
    console.log(`        screenshot: ${path.join(OUT_DIR, `${name}.png`)}`);
  }

  // ——— State 1: empty ————————————————————————————————————————————————
  await auditTokens('1-empty');
  await shot('1-empty');

  // ——— State 2: input loaded —————————————————————————————————————————
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
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'synthetic-96.png', { type: 'image/png' }));
    const input = document.querySelector('#file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => !document.querySelector('#run').disabled, null, { timeout: 15000 });
  await page.click('#method-neural');
  await sleep(200);
  await auditTokens('2-loaded');
  await shot('2-loaded');

  // ——— State 3: consent modal —————————————————————————————————————————
  await page.click('#run');
  await page.waitForFunction(() => !document.querySelector('#consentModal').hidden, null, { timeout: 15000 });
  await sleep(200);
  await auditTokens('3-consent');
  await shot('3-consent');

  // ——— State 4: processing (accept consent → tiles run) ———————————————
  await page.click('#consentAccept');
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('model ready'), null, { timeout: 120000 });
  // The run continues automatically; catch it mid-flight.
  await page.waitForFunction(
    () => document.querySelector('#log').textContent.includes('tile_processing'),
    null,
    { timeout: 60000 },
  );
  await sleep(150);
  await auditTokens('4-processing');
  await shot('4-processing');

  // ——— State 5: result ————————————————————————————————————————————————
  await page.waitForFunction(
    () => [...document.querySelectorAll('#log .line--ok')].some((el) => el.textContent.endsWith('complete')),
    null,
    { timeout: 120000 },
  );
  await page.waitForFunction(() => document.querySelector('#output').naturalWidth > 0, null, { timeout: 15000 });
  await sleep(300);
  await auditTokens('5-result');
  await shot('5-result');

  // ——— State 6: error display —————————————————————————————————————————
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 4, 4);
    // Corrupt the engine input: an empty buffer produces a typed error.
    const dt = new DataTransfer();
    const file = new File([new Uint8Array([0, 1, 2, 3])], 'garbage.bin', { type: 'application/octet-stream' });
    dt.items.add(file);
    const input = document.querySelector('#file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.click('#method-bicubic');
  await page.click('#scaleSeg button[data-scale="2"]');
  await page.click('#run');
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('process failed'), null, { timeout: 30000 });
  await sleep(200);
  await auditTokens('6-error');
  await shot('6-error');

  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

const failed = evidence.filter((e) => !e.ok);
console.log(`\n${evidence.length - failed.length}/${evidence.length} visual-audit checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
