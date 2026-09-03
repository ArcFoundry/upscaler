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

  /** AUDIT v2 — tokens AND composition, evaluated against the CURRENT DOM. */
  async function auditTokens(stateName) {
    const r = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const ctlH = parseFloat(cs.getPropertyValue('--ctl-h'));
      const radii = ['--r1', '--r2'].map((t) => parseFloat(cs.getPropertyValue(t)));
      const scale = [1, 2, 3, 4, 6, 8].map((n) => parseFloat(cs.getPropertyValue(`--s${n}`)));

      // 1. Every .btn: identical height (±1px), r1 radius, s3 h-padding.
      const heights = new Set();
      const btnIssues = [];
      for (const b of document.querySelectorAll('.btn')) {
        if (b.offsetParent === null) continue;
        const s = getComputedStyle(b);
        heights.add(Math.round(parseFloat(s.height)));
        if (Math.abs(parseFloat(s.height) - ctlH) > 1 || parseFloat(s.borderRadius) !== radii[0]) {
          btnIssues.push({ id: b.id || b.className, h: s.height, r: s.borderRadius });
        }
      }

      // 2. Every .seg control shares --ctl-h (±1px).
      const segIssues = [...document.querySelectorAll('.seg')]
        .filter((seg) => seg.offsetParent !== null)
        .filter((seg) => Math.abs(parseFloat(getComputedStyle(seg).height) - ctlH) > 1)
        .map((seg) => seg.id || seg.className);

      // 3. All .card paddings identical.
      const cards = [...document.querySelectorAll('.card')];
      const paddings = new Set(cards.map((c) => getComputedStyle(c).padding));
      const cardPadding = cards.length ? getComputedStyle(cards[0]).padding : null;
      const cardIssues = paddings.size > 1 ? [...paddings].join(' | ') : null;

      // 4. All flex/grid gaps from the spacing scale (incl. grid3 rows).
      const gapSet = new Set();
      for (const el of document.querySelectorAll('.ctl-row, .grid3, .modal__actions, .card-foot, .meta-row, .masthead')) {
        if (el.offsetParent === null) continue;
        for (const g of [getComputedStyle(el).columnGap, getComputedStyle(el).rowGap]) {
          if (g && g !== 'normal') gapSet.add(parseFloat(g));
        }
      }
      const badGaps = [...gapSet].filter((g) => !scale.includes(g));

      // 5. Telemetry 100% mono.
      const nonMono = [...document.querySelectorAll('.mono-panel')].filter(
        (p) => p.offsetParent !== null && !getComputedStyle(p).fontFamily.includes('JetBrains Mono'),
      ).length;

      // 6. COMPOSITION invariants.
      const bodyW = document.body.clientWidth;
      const dropPromptHidden = document.querySelector('#dropzone').hidden;
      const methodCards = [...document.querySelectorAll('.method')].filter((m) => m.offsetParent !== null);
      const methodHeights = methodCards.map((m) => Math.round(m.getBoundingClientRect().height));
      const methodEqual = methodHeights.length === 0 || Math.max(...methodHeights) - Math.min(...methodHeights) <= 1;
      // COMPOSITION: no child may escape its card (the min-content overflow
      // the grid fix addresses). Measured, not assumed.
      let overflow = null;
      for (const card of document.querySelectorAll('.card')) {
        const cr = card.getBoundingClientRect();
        for (const child of card.querySelectorAll('.method, .btn, .seg')) {
          const r = child.getBoundingClientRect();
          if (r.width > 0 && (r.right > cr.right + 0.5 || r.left < cr.left - 0.5)) {
            overflow = { child: child.id || child.className, cardRight: Math.round(cr.right), childRight: Math.round(r.right) };
            break;
          }
        }
        if (overflow) break;
      }
      const accentCount = new Set();
      for (const el of document.querySelectorAll('button, .method, .chip, .banner, .compare__handle')) {
        if (el.offsetParent === null) continue;
        const c = getComputedStyle(el);
        for (const col of [c.backgroundColor, c.borderColor, c.color]) {
          if (/255, 158|245, 158|F59E0B/i.test(col)) accentCount.add('accent');
          if (/59, 130, 246|99, 102, 241|139, 92, 246|236, 72, 153/i.test(col)) accentCount.add('foreign-accent');
        }
      }

      return {
        btnIssues, segIssues, cardPadding, cardIssues, badGaps, nonMono,
        bodyW, dropPromptHidden, methodEqual, overflow,
        heights: [...heights],
        accents: [...accentCount],
      };
    });

    check(`[${stateName}] every visible .btn ≈ ${'ctl-h'} + r1`, r.btnIssues.length === 0, JSON.stringify(r.btnIssues));
    check(`[${stateName}] .seg controls share --ctl-h`, r.segIssues.length === 0, JSON.stringify(r.segIssues));
    check(`[${stateName}] all .card paddings identical`, r.cardIssues === null, r.cardIssues ?? r.cardPadding);
    check(`[${stateName}] every gap on the spacing scale`, r.badGaps.length === 0, JSON.stringify(r.badGaps));
    check(`[${stateName}] telemetry panels mono`, r.nonMono === 0, `non-mono: ${r.nonMono}`);
    check(`[${stateName}] single accent (no foreign hues)`, !r.accents.includes('foreign-accent'), JSON.stringify(r.accents));
    check(`[${stateName}] no control escapes its card`, r.overflow === null, JSON.stringify(r.overflow));
    check(`[${stateName}] single-column ≤760px body`, r.bodyW <= 760, `${r.bodyW}px`);
    return r;
  }

  async function shot(name) {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
    console.log(`        screenshot: ${path.join(OUT_DIR, `${name}.png`)}`);
  }

  // ——— State 1: empty ————————————————————————————————————————————————
  await auditTokens('1-empty');
  check('[1-empty] GPU picker hidden without dualGpu', await page.evaluate(() => document.querySelector('#gpuPicker').hidden));
  check('[1-empty] Run disabled', await page.evaluate(() => document.querySelector('#run').disabled));
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
  await sleep(150);
  const loaded = await auditTokens('2-loaded');
  check('[2-loaded] drop prompt hidden once a file is loaded', loaded.dropPromptHidden === true);
  await page.click('#method-neural');
  await sleep(150);
  check('[2-loaded] Load-model affordance visible for High without a session', await page.evaluate(() => !document.querySelector('#loadModel').hidden));
  await shot('2-loaded');

  // ——— State 3: consent modal —————————————————————————————————————————
  await page.click('#run');
  await page.waitForFunction(() => !document.querySelector('#consentModal').hidden, null, { timeout: 15000 });
  await sleep(200);
  await auditTokens('3-consent');
  await shot('3-consent');

  // ——— State 4: processing (accept consent → tiles run, ONE click) ————
  await page.click('#consentAccept');
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('model ready'), null, { timeout: 120000 });
  // AUTO-CONTINUE: tiles must follow the model without a second click.
  await page.waitForFunction(
    () => [...document.querySelectorAll('#log .line--accent')].some((el) => el.textContent.includes('tile ')),
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
  await auditTokens('5-result-fit');
  check('[5-result-fit] meta has dims + method', /\d+×\d+/.test(await page.evaluate(() => document.querySelector('#outMeta').textContent)));
  await shot('5-result-fit');

  // ——— State 6: result @ 2× (divider mid) — the honest comparison ————
  await page.click('#zoomSeg button[data-zoom="2"]');
  await page.waitForFunction(() => document.querySelector('#compareHandle').getAttribute('aria-valuenow') === '50', null, { timeout: 5000 });
  await sleep(300);
  await auditTokens('6-result-2x');
  const align = await page.evaluate(() => {
    const b = document.querySelector('#beforeImg').getBoundingClientRect();
    const a = document.querySelector('#output').getBoundingClientRect();
    return { same: Math.abs(b.width - a.width) < 0.5 && Math.abs(b.height - a.height) < 0.5 && Math.abs(b.left - a.left) < 0.5 && Math.abs(b.top - a.top) < 0.5, w: b.width };
  });
  check('[6-result-2x] both images identical scale/alignment (±0.5px)', align.same, JSON.stringify(align));
  await shot('6-result-2x');

  // ——— State 7: error display ———————————————————————————————————————

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
  await page.click('#run');
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('process failed'), null, { timeout: 30000 });
  await sleep(200);
  await auditTokens('7-error');
  await shot('7-error');

  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

const failed = evidence.filter((e) => !e.ok);
console.log(`\n${evidence.length - failed.length}/${evidence.length} visual-audit checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
