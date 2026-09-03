/**
 * Vanilla wiring for the engine — the ONLY DOM-touching file in the repo.
 *
 * ONE-CLICK FLOW (v0.3.1): Run click, classical → process() immediately.
 * Run click, neural, no session → consent modal immediately; accepting runs
 * loadModel() then AUTO-CONTINUES into process() with the same options — one
 * Run click completes the entire job. The engine's typed Two-Gate error is
 * never rendered on the human path (the harness owns the gating; the engine
 * error only surfaces for real failures).
 *
 * States: EMPTY → LOADED → CONSENT? → MODEL_LOADING → PROCESSING → RESULT | ERROR
 *
 * The stable machine-facing IDs (#file #method #scale #format #run #loadModel
 * #detect #caps #log #output #outMeta) are consumed by the automated gates
 * (tests/browser-e2e.mjs, tests/neural-gate.mjs) — keep them meaningful.
 * `window.__engine` is exposed for gate-side event-order assertions.
 */
import { UpscalerEngine } from '../dist/index.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing element #${id}`);
  }
  return el as T;
};

// ——— Elements ————————————————————————————————————————————————————————
const dropzone = $('dropzone');
const fileInput = $<HTMLInputElement>('file');
const preview = $('preview');
const previewImg = $<HTMLImageElement>('previewImg');
const inputStats = $('inputStats');
const runButton = $<HTMLButtonElement>('run');
const loadModelButton = $<HTMLButtonElement>('loadModel');
const modelState = $('modelState');
const detectButton = $<HTMLButtonElement>('detect');
const capsPanel = $('caps');
const gpuPicker = $('gpuPicker');
const logEl = $('log');
const outMeta = $('outMeta');
const outputImg = $<HTMLImageElement>('output');
const beforeImg = $<HTMLImageElement>('beforeImg');
const statusChip = $('statusChip');
const fallbackBanner = $('fallbackBanner');
const consentModal = $('consentModal');
const consentDetail = $('consentDetail');
const consentAccept = $<HTMLButtonElement>('consentAccept');
const consentCancel = $<HTMLButtonElement>('consentCancel');
const classicalNote = $('classicalNote');

// ——— Test catalog (third-party PUBLIC Real-ESRGAN exports on Hugging Face,
// pinned by commit SHA — see README "Model Hosting" for provenance). ————
const TEST_CATALOG = {
  webgpu: 'https://huggingface.co/FuryTMP/RealESR_Gx4_fp16/resolve/3767133b06ab19a3636b342d44f5d2da5c3a132e/RealESR_Gx4_fp16.onnx',
  wasm: 'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/488e5dda07333179f229a6205d92135eea4c25e9/realesr-general-x4v3.onnx',
};

const engine = new UpscalerEngine({ models: TEST_CATALOG });
// Gate seam: event-order assertions without touching engine internals.
(window as unknown as { __engine: UpscalerEngine }).__engine = engine;

// ——— State machine ———————————————————————————————————————————————————
type Method = 'lanczos' | 'bicubic' | 'neural';
type Phase = 'empty' | 'loaded' | 'consent' | 'loading-model' | 'processing' | 'result';
let method: Method = 'lanczos';
let scale: 2 | 4 = 2;
let format: 'image/png' | 'image/webp' = 'image/png';
let zoom: 'fit' | '1' | '2' | '4' = 'fit';
let currentFile: File | null = null;
let lastObjectUrl: string | null = null;
let lastBlob: Blob | null = null;
let lastTileLine: HTMLElement | null = null;
let modelLoaded = false;
let phase: Phase = 'empty';
let consentResolver: ((ok: boolean) => void) | null = null;

function updateLoadAffordance(): void {
  // Explicit pre-consent affordance exists only while the AI model is missing.
  loadModelButton.hidden = !(method === 'neural' && !modelLoaded);
}

function setPhase(next: Phase): void {
  phase = next;
  const working = next === 'loading-model' || next === 'processing';
  // Every input is disabled while the engine works; the run button doubles
  // as the progress surface.
  loadModelButton.disabled = working;
  detectButton.disabled = working;
  for (const id of ['method-bicubic', 'method-lanczos', 'method-neural']) {
    ($(id) as HTMLButtonElement).disabled = working;
  }
  for (const segId of ['scaleSeg', 'formatSeg']) {
    for (const b of $(segId).querySelectorAll('button')) {
      (b as HTMLButtonElement).disabled = working;
    }
  }
  runButton.disabled = working || next === 'empty';

  const chip = (label: string, cls = ''): void => {
    statusChip.textContent = label;
    statusChip.className = cls ? `chip chip--${cls}` : 'chip';
  };
  switch (next) {
    case 'empty':
      chip('idle');
      runButton.textContent = 'Run';
      break;
    case 'loaded':
      chip('ready');
      runButton.textContent = 'Run';
      break;
    case 'consent':
      chip('consent');
      break;
    case 'loading-model':
      chip('loading model', 'busy');
      runButton.textContent = 'Loading model…';
      break;
    case 'processing':
      chip('processing', 'busy');
      runButton.textContent = 'Processing…';
      break;
    case 'result':
      chip('done', 'done');
      runButton.textContent = 'Run again';
      break;
  }
  updateLoadAffordance();
}

// ——— Telemetry ———————————————————————————————————————————————————————
function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function log(message: string, cls: '' | 'ok' | 'err' | 'warn' | 'info' | 'accent' = ''): void {
  const line = document.createElement('span');
  line.className = cls ? `line line--${cls}` : 'line';
  line.textContent = `[${ts()}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;

// ——— Engine events (all five; order asserted by gates) ————————————————
engine.on('model_download', (e) => {
  log(`model download ${Math.round(e.progress * 100)}%`);
});
engine.on('tile_processing', (e) => {
  if (lastTileLine) {
    lastTileLine.remove();
  }
  const dur = e.tileDurationMs !== undefined ? ` · ${(e.tileDurationMs / 1000).toFixed(1)}s/tile` : '';
  const eta = e.etaMs !== undefined && e.etaMs > 0 ? ` · ETA ~${Math.max(1, Math.round(e.etaMs / 1000))}s` : '';
  const line = document.createElement('span');
  line.className = 'line line--accent';
  line.textContent = `[${ts()}] tile ${e.tileIndex + 1}/${e.totalTiles}${dur}${eta}`;
  logEl.appendChild(line);
  lastTileLine = line;
  logEl.scrollTop = logEl.scrollHeight;
  if (phase === 'processing' && e.totalTiles > 1) {
    runButton.textContent = `Processing… ${e.tileIndex + 1}/${e.totalTiles}`;
  }
});
engine.on('fallback', (e) => {
  log(`fallback webgpu → wasm: ${e.reason}`, 'warn');
  fallbackBanner.textContent = `Fallback to WASM: ${e.reason}`;
  fallbackBanner.hidden = false;
});
engine.on('error', (e) => {
  // Only REAL failures reach this on the human path (the harness never lets
  // the typed Two-Gate error escape).
  log(`error (recoverable=${String(e.recoverable)}): ${e.message}`, 'err');
});
engine.on('complete', (e) => {
  showResult(e.blobUrl);
});

// ——— Result view ——————————————————————————————————————————————————————
function showResult(blobUrl: string): void {
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
  }
  lastObjectUrl = blobUrl;
  beforeImg.src = previewImg.src;
  outputImg.src = blobUrl;
  $('card-result').hidden = false;
  $('card-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // Classical expectation-setting (info-styled, never error).
  classicalNote.hidden = method === 'neural';
  applyZoom();
  log('complete', 'ok');
}

function renderMeta(): void {
  if (!lastBlob) {
    return;
  }
  const dims = `${outputImg.naturalWidth}×${outputImg.naturalHeight}`;
  outMeta.textContent = `${dims} · ${fmtBytes(lastBlob.size)} · ${method} · ${lastBlob.type.replace('image/', '').toUpperCase()}`;
  const dl = $<HTMLAnchorElement>('download');
  dl.href = outputImg.src;
  dl.download = `upscaled-${scale}x.${format === 'image/webp' ? 'webp' : 'png'}`;
}
outputImg.addEventListener('load', renderMeta);

// ——— 1:1 zoom comparison ——————————————————————————————————————————————
// Both images live in ONE shared canvas box (same width, same origin, same
// clip): FIT stretches both to the container; 1×/2×/4× render the RESULT at
// factor × its natural pixels and stretch the ORIGINAL to the identical box.
// The divider therefore always compares the same content region at the same
// screen scale — fit-to-view destroys exactly this, which is why a neural
// result "looked identical" to bicubic at FIT.
const afterClip = $('afterClip');
const compareCanvas = $('compareCanvas');
const handle = $('compareHandle');

function applyZoom(): void {
  const w = outputImg.naturalWidth;
  const h = outputImg.naturalHeight;
  if (!w || !h) {
    return;
  }
  if (zoom === 'fit') {
    compareCanvas.style.width = '';
    for (const img of [beforeImg, outputImg]) {
      img.style.width = '100%';
      img.style.height = 'auto';
    }
  } else {
    const factor = Number(zoom);
    compareCanvas.style.width = `${Math.round(w * factor)}px`;
    for (const img of [beforeImg, outputImg]) {
      img.style.width = `${Math.round(w * factor)}px`;
      img.style.height = `${Math.round(h * factor)}px`;
    }
  }
  setSplit(Number(handle.getAttribute('aria-valuenow') ?? '50'));
}

function setZoom(next: 'fit' | '1' | '2' | '4'): void {
  zoom = next;
  for (const b of $('zoomSeg').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.zoom === next));
  }
  applyZoom();
}

$('zoomSeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn) {
    setZoom(btn.dataset.zoom as typeof zoom);
  }
});

function setSplit(pct: number): void {
  const clamped = Math.min(Math.max(pct, 0), 100);
  afterClip.style.width = `${clamped}%`;
  handle.style.left = `${clamped}%`;
  handle.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

function splitFromPointer(e: PointerEvent): void {
  const rect = compareCanvas.getBoundingClientRect();
  setSplit(((e.clientX - rect.left) / rect.width) * 100);
}

handle.addEventListener('pointerdown', (e) => {
  handle.setPointerCapture(e.pointerId);
  splitFromPointer(e);
});
handle.addEventListener('pointermove', (e) => {
  if (e.buttons > 0) {
    splitFromPointer(e);
  }
});
handle.addEventListener('keydown', (e) => {
  const now = Number(handle.getAttribute('aria-valuenow') ?? '50');
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    setSplit(now - (e.shiftKey ? 10 : 2));
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    setSplit(now + (e.shiftKey ? 10 : 2));
  }
});
setSplit(50);

// ——— Input: drop / click / paste / replace ————————————————————————————
function takeFile(file: File): void {
  currentFile = file;
  previewImg.onload = () => {
    inputStats.textContent = `${previewImg.naturalWidth}×${previewImg.naturalHeight} · ${fmtBytes(file.size)} · ${(file.type || 'unknown').replace('image/', '').toUpperCase()}`;
    updateEstimate();
  };
  previewImg.src = URL.createObjectURL(file);
  dropzone.hidden = true;
  preview.hidden = false;
  setPhase('loaded');
  log(`input: ${file.name}`);
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) {
    takeFile(f);
  }
});
$('replace').addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('is-dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('is-dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) {
    takeFile(f);
  }
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const f = item?.getAsFile();
  if (f) {
    takeFile(f);
  }
});

// ——— Method cards + segmented controls ——————————————————————————————
const methodButtons: Record<Method, HTMLButtonElement> = {
  bicubic: $<HTMLButtonElement>('method-bicubic'),
  lanczos: $<HTMLButtonElement>('method-lanczos'),
  neural: $<HTMLButtonElement>('method-neural'),
};

function setMethod(next: Method): void {
  method = next;
  for (const [name, btn] of Object.entries(methodButtons)) {
    btn.setAttribute('aria-pressed', String(name === next));
  }
  ($('method') as HTMLInputElement).value = next;
  if (phase === 'result') {
    classicalNote.hidden = next === 'neural';
  }
  updateLoadAffordance();
}

for (const [name, btn] of Object.entries(methodButtons)) {
  btn.addEventListener('click', () => setMethod(name as Method));
}

function wireSeg(id: string, attr: 'scale' | 'format', apply: (value: string) => void): void {
  const seg = $(id);
  seg.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    apply(btn.dataset[attr] ?? '');
  });
}

wireSeg('scaleSeg', 'scale', (v) => {
  scale = Number(v) as 2 | 4;
  ($('scale') as HTMLInputElement).value = v;
  updateEstimate();
});
wireSeg('formatSeg', 'format', (v) => {
  format = v as 'image/png' | 'image/webp';
  ($('format') as HTMLInputElement).value = v;
});

function updateEstimate(): void {
  if (!previewImg.naturalWidth) {
    $('outEstimate').textContent = '';
    return;
  }
  $('outEstimate').textContent = `→ ${previewImg.naturalWidth * scale}×${previewImg.naturalHeight * scale} px`;
}

// ——— Consent modal ————————————————————————————————————————————————————
function requestConsent(detail: string): Promise<boolean> {
  consentDetail.textContent = detail;
  consentModal.hidden = false;
  consentAccept.focus();
  setPhase('consent');
  return new Promise<boolean>((resolve) => {
    consentResolver = resolve;
  });
}

function settleConsent(ok: boolean): void {
  if (consentModal.hidden) return;
  consentModal.hidden = true;
  consentResolver?.(ok);
  consentResolver = null;
}

consentAccept.addEventListener('click', () => settleConsent(true));
consentCancel.addEventListener('click', () => settleConsent(false));
consentModal.addEventListener('click', (e) => {
  if (e.target === consentModal) settleConsent(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !consentModal.hidden) settleConsent(false);
});

/** Mirrors the engine's pure selection for the consent detail (display only). */
function selectVariantPreview(
  catalog: typeof TEST_CATALOG,
  caps: { webgpu: boolean; softwareGpu?: boolean },
): { variant: string; url: string } {
  if (caps.webgpu && catalog.webgpu && !caps.softwareGpu) {
    return { variant: 'webgpu', url: catalog.webgpu };
  }
  return { variant: 'wasm', url: catalog.wasm };
}

function consentDetailText(): string {
  return `variant: auto (selected from probed hardware)\nsource: huggingface.co (pinned by commit SHA)\ncached after first download — 0 MB on reuse`;
}

// ——— loadModel with honest cache/download telemetry ———————————————————
async function loadModelWithTelemetry(): Promise<void> {
  setPhase('loading-model');
  const result = await engine.loadModel();
  modelLoaded = true;
  modelState.textContent = `model: ${result.variant}${result.cached ? ' · cached' : ''}`;
  updateLoadAffordance();
  log(
    result.cached
      ? `model ready — variant=${result.variant} · cached · 0 MB downloaded`
      : `model ready — variant=${result.variant} · downloaded & cached for next time`,
    'ok',
  );
  renderDiagnostics(await engine.detectDevice());
}

// ——— THE one-click run ————————————————————————————————————————————————
let processStart = 0;

async function runJob(): Promise<void> {
  if (!currentFile || phase === 'loading-model' || phase === 'processing') {
    return;
  }
  const file = currentFile;

  // Neural without a session → consent modal IMMEDIATELY (the engine's typed
  // Two-Gate error is never shown on the human path).
  if (method === 'neural' && !modelLoaded) {
    const caps = await engine.detectDevice();
    const chosen = selectVariantPreview(TEST_CATALOG, caps);
    const ok = await requestConsent(
      `variant: ${chosen.variant}\nsource: ${new URL(chosen.url).host}${new URL(chosen.url).pathname.split('/').slice(1, 3).join('/')}\npinned by commit SHA — cached after first download`,
    );
    if (!ok) {
      // Stay on Medium — revert the method, info-styled line.
      setMethod('lanczos');
      log('stayed on Medium · Lanczos (instant, no download)', 'info');
      setPhase('loaded');
      return;
    }
  }

  processStart = performance.now();
  try {
    if (method === 'neural' && !modelLoaded) {
      await loadModelWithTelemetry();
      // AUTO-CONTINUE: the very next lines after "model ready" are the run.
    }
    setPhase('processing');
    lastTileLine = null;
    const buffer = await file.arrayBuffer(); // engine detaches it
    const blob = await engine.process(buffer, { method, scale, format });
    lastBlob = blob;
    log(`done in ${((performance.now() - processStart) / 1000).toFixed(1)}s · ${fmtBytes(blob.size)} blob`, 'ok');
    setPhase('result');
  } catch (err) {
    // Real failures only (timeout, OOM, decode…) — the flow above never lets
    // the typed Two-Gate error reach the user.
    log(`process failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    statusChip.textContent = 'error';
    statusChip.className = 'chip chip--err';
    setPhase('loaded');
  }
}

runButton.addEventListener('click', () => void runJob());

// #loadModel (explicit affordance): consent → load only; the next Run is a
// single click (session already active).
loadModelButton.addEventListener('click', () => {
  void (async () => {
    const ok = await requestConsent(consentDetailText());
    if (!ok) {
      log('model download declined', 'info');
      return;
    }
    try {
      await loadModelWithTelemetry();
      setPhase(currentFile ? 'loaded' : 'empty');
    } catch (err) {
      log(`loadModel failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
      setPhase(currentFile ? 'loaded' : 'empty');
    }
  })();
});

// ——— Diagnostics ——————————————————————————————————————————————————————
function renderDiagnostics(caps: Awaited<ReturnType<UpscalerEngine['detectDevice']>>): void {
  const info = caps.adapterInfo;
  const infoText = info
    ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' · ') || '(no info)'
    : '(none probed)';
  const lines = [
    `webgpu: ${caps.webgpu}  wasm: ${caps.wasm}  threads: ${caps.wasmThreads}  lowVram: ${caps.lowVram}`,
    `adapter: ${infoText}`,
    `gpuTier (HEURISTIC): ${caps.gpuTier ?? '—'}  softwareGpu: ${String(caps.softwareGpu ?? false)}  dualGpu: ${String(caps.dualGpu ?? false)}`,
  ];
  if (caps.dualGpu && caps.secondaryAdapterInfo) {
    const s = caps.secondaryAdapterInfo;
    lines.push(`secondary: ${[s.vendor, s.architecture, s.device, s.description].filter(Boolean).join(' · ')}`);
  }
  const d = engine.getDiagnostics();
  if (d.chosenVariant) {
    lines.push(`variant: ${d.chosenVariant}  requestedEp: ${d.requestedEp}  actualEp: ${d.actualEp}`);
  }
  if (d.lastTileDurationMs !== undefined) {
    lines.push(`lastTile: ${d.lastTileDurationMs} ms`);
  }
  capsPanel.textContent = lines.join('\n');
  capsPanel.hidden = false;
  gpuPicker.hidden = !caps.dualGpu;
}

detectButton.addEventListener('click', () => {
  void (async () => {
    detectButton.disabled = true;
    try {
      const caps = await engine.detectDevice();
      renderDiagnostics(caps);
      log(
        `probe: crossOriginIsolated=${String(crossOriginIsolated)} deviceMemory=${String((navigator as Navigator & { deviceMemory?: number }).deviceMemory)}`,
        'info',
      );
    } finally {
      detectButton.disabled = false;
    }
  })();
});

gpuPicker.addEventListener('click', (e) => {
  void (async () => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const pref = btn.dataset.gpu as 'high-performance' | 'low-power';
    for (const b of gpuPicker.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    log(`gpu preference → ${pref}; rebuilding session (no hot adapter swap)`, 'info');
    try {
      const caps = await engine.detectDevice(pref);
      renderDiagnostics(caps);
      await engine.loadModel(pref);
      modelLoaded = true;
      renderDiagnostics(await engine.detectDevice());
      log(`model rebuilt for ${pref}`, 'ok');
    } catch (err) {
      log(`loadModel failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  })();
});

// ——— Cleanup + initial state ————————————————————————————————————————
window.addEventListener('pagehide', () => {
  engine.destroy();
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
  }
});

setPhase('empty');
