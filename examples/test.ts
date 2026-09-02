/**
 * Vanilla wiring for the engine: detectDevice → process(classical) →
 * user-consented loadModel → process(neural). Every event is logged so the
 * engine's contract (progress, fallback, complete, error) is observable.
 *
 * This file is the ONLY place in the repo that touches the DOM — the engine
 * itself is headless.
 */
import { UpscalerEngine } from '../dist/index.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing element #${id}`);
  }
  return el as T;
};

const logEl = $('log');
const capsTable = $('caps');
const runButton = $<HTMLButtonElement>('run');
const loadModelButton = $<HTMLButtonElement>('loadModel');
const detectButton = $<HTMLButtonElement>('detect');
const outputImg = $<HTMLImageElement>('output');
const outMeta = $('outMeta');

const log = (message: string, cls = ''): void => {
  const line = document.createElement('div');
  if (cls) {
    line.className = cls;
  }
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
};

// ——— Engine instances ——————————————————————————————————————————————
// Third-party PUBLIC test models on Hugging Face, pinned by commit SHA
// (see README "Model Hosting" for provenance and attribution).
//   job (photo vs anime) and scale are YOUR choices; the engine picks the
//   precision variant from probed hardware (fp16 for WebGPU, fp32 for CPU).
const TEST_CATALOG = {
  webgpu: 'https://huggingface.co/FuryTMP/RealESR_Gx4_fp16/resolve/3767133b06ab19a3636b342d44f5d2da5c3a132e/RealESR_Gx4_fp16.onnx',
  wasm: 'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/488e5dda07333179f229a6205d92135eea4c25e9/realesr-general-x4v3.onnx',
};

const classicalEngine = new UpscalerEngine({ models: TEST_CATALOG });

// ——— Event wiring (all five event types) ———————————————————————————
const logLineForTiles = new Map<UpscalerEngine, HTMLElement>();

let tileLine = document.createElement('div');
tileLine.textContent = 'tile_processing —';
logEl.appendChild(tileLine);

function wire(engine: UpscalerEngine): void {
  engine.on('model_download', (e) => log(`model_download ${Math.round(e.progress * 100)}%`));
  engine.on('tile_processing', (e) => {
    const line = logLineForTiles.get(engine) ?? tileLine;
    line.textContent = `tile_processing ${e.tileIndex + 1}/${e.totalTiles}`;
  });
  engine.on('fallback', (e) => log(`fallback webgpu → wasm: ${e.reason}`, 'error'));
  engine.on('error', (e) => log(`error (recoverable=${String(e.recoverable)}): ${e.message}`, 'error'));
  engine.on('complete', (e) => showResult(e.blobUrl));
}

wire(classicalEngine);
// ——— Object-URL lifecycle contract ——————————————————————————————————
// The ENGINE creates the URL in `complete`; the CONSUMER (this file) owns
// revoking it. We revoke only the previous URL when a new result arrives.
let lastObjectUrl: string | null = null;

function showResult(blobUrl: string): void {
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
  }
  lastObjectUrl = blobUrl;
  outputImg.src = blobUrl;
  outputImg.hidden = false;
  log('complete', 'ok');
}

// ——— Controls ———————————————————————————————————————————————————————
detectButton.addEventListener('click', () => {
  void (async () => {
    detectButton.disabled = true;
    try {
      const caps = await classicalEngine.detectDevice();
      const rows: [string, boolean][] = [
        ['webgpu', caps.webgpu],
        ['wasm', caps.wasm],
        ['wasmThreads', caps.wasmThreads],
        ['lowVram', caps.lowVram],
      ];
      capsTable.innerHTML = rows
        .map(
          ([key, value]) =>
            `<tr><td class="key">${key}</td><td class="${value ? 'ok-badge' : 'no-badge'}">${value}</td></tr>`,
        )
        .join('');
      capsTable.hidden = false;
      log(
        `crossOriginIsolated=${String(crossOriginIsolated)} deviceMemory=${String(
          (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        )}`,
        'dim',
      );
    } finally {
      detectButton.disabled = false;
    }
  })();
});

runButton.addEventListener('click', () => {
  void (async () => {
    const file = $<HTMLInputElement>('file').files?.[0];
    if (!file) {
      log('pick an input image first', 'error');
      return;
    }
    runButton.disabled = true;
    tileLine = document.createElement('div');
    tileLine.textContent = 'tile_processing —';
    logEl.appendChild(tileLine);
    try {
      const buffer = await file.arrayBuffer(); // engine detaches it — do not reuse
      const blob = await classicalEngine.process(buffer, {
        method: $<HTMLSelectElement>('method').value as 'lanczos' | 'bicubic' | 'neural',
        scale: Number($<HTMLSelectElement>('scale').value) as 2 | 4,
        format: $<HTMLSelectElement>('format').value as 'image/png' | 'image/webp',
      });
      outMeta.textContent = `output: ${blob.type}, ${(blob.size / 1024).toFixed(1)} KiB — blob URL revoked on next run (consumer responsibility)`;
      outMeta.hidden = false;
    } catch (err) {
      log(`process failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      runButton.disabled = false;
    }
  })();
});

loadModelButton.addEventListener('click', () => {
  void (async () => {
    loadModelButton.disabled = true;
    try {
      // Two-Gate: this click IS the user consent to fetch the catalog
      // variant the engine selected for this hardware.
      const result = await classicalEngine.loadModel();
      log(
        `model ready — variant=${result.variant} cached=${String(result.cached)} url=${result.url.split('/').slice(3, 5).join('/')}`,
        'ok',
      );
    } catch (err) {
      log(`loadModel failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      loadModelButton.disabled = false;
    }
  })();
});

window.addEventListener('pagehide', () => {
  classicalEngine.destroy();
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
  }
});
