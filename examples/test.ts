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
// The classical engine is download-free forever. The neural engine is only
// constructed when the user clicks loadModel() — the Two-Gate flow.
const classicalEngine = new UpscalerEngine();
const neuralEngines: UpscalerEngine[] = [];

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
    const engine = neuralEngines.at(-1) ?? classicalEngine;
    runButton.disabled = true;
    tileLine = document.createElement('div');
    tileLine.textContent = 'tile_processing —';
    logEl.appendChild(tileLine);
    try {
      const buffer = await file.arrayBuffer(); // engine detaches it — do not reuse
      const blob = await engine.process(buffer, {
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
    const url = $<HTMLInputElement>('modelUrl').value.trim();
    if (!url) {
      log('enter a model URL first (this click IS the user consent — Two-Gate)', 'error');
      return;
    }
    loadModelButton.disabled = true;
    try {
      const neuralEngine = new UpscalerEngine({ modelUrl: url });
      logLineForTiles.set(neuralEngine, tileLine);
      wire(neuralEngine);
      await neuralEngine.loadModel();
      neuralEngines.push(neuralEngine);
      log('model ready (cached by the engine for next time)', 'ok');
    } catch (err) {
      log(`loadModel failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      loadModelButton.disabled = false;
    }
  })();
});

window.addEventListener('pagehide', () => {
  classicalEngine.destroy();
  for (const engine of neuralEngines) {
    engine.destroy();
  }
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
  }
});
