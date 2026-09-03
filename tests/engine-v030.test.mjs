/**
 * v0.3.0 unit tests: timeout semantics, GPU-tier classification + tile
 * policy, capability-aware routing (software GPU / dual GPU), and the
 * single-EP session guarantee with explicit fallback.
 * Run: npm run test:node
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UpscalerEngine,
  UpscalerError,
  ModelManager,
  TimeoutGovernor,
  classifyGpuTier,
  isSoftwareGpuInfo,
  selectModelVariant,
  tilePolicyFor,
  TIER_NEURAL_MEGAPIXELS,
} from '../dist/index.js';

// —— 1.1 Idle-based timeout semantics ——————————————————————————————————————

test('idle timeout: a silent worker dies at the idle limit', async () => {
  const events = [];
  const gov = new TimeoutGovernor({ idleMs: 50, onExpire: (r) => events.push(r) });
  gov.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(events, ['idle']);
  assert.equal(gov.expiredWith, 'idle');
});

test('idle timeout: a progressing worker survives PAST the old absolute limit', async () => {
  const events = [];
  const gov = new TimeoutGovernor({ idleMs: 50, onExpire: (r) => events.push(r) });
  gov.start();
  // Simulate tile progress every 30 ms — 8 pokes ≈ 240 ms, ~5× the idle limit.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 30));
    gov.poke();
  }
  assert.deepEqual(events, [], 'poke() must keep resetting the idle timer');
  assert.equal(gov.expiredWith, null);
  gov.stop();
});

test('idle timeout: silence AFTER progress still expires (idle = since last message)', async () => {
  const events = [];
  const gov = new TimeoutGovernor({ idleMs: 60, onExpire: (r) => events.push(r) });
  gov.start();
  await new Promise((r) => setTimeout(r, 20));
  gov.poke();
  await new Promise((r) => setTimeout(r, 140));
  assert.deepEqual(events, ['idle']);
});

test('hardTimeoutMs overrides idle logic: progressing worker still dies at the cap', async () => {
  const events = [];
  const gov = new TimeoutGovernor({ idleMs: 40, hardMs: 100, onExpire: (r) => events.push(r) });
  gov.start();
  const t0 = Date.now();
  while (Date.now() - t0 < 160) {
    await new Promise((r) => setTimeout(r, 20));
    gov.poke();
    if (events.length > 0) break;
  }
  assert.deepEqual(events, ['hard']);
  assert.ok(Date.now() - t0 >= 90, 'hard cap fires no earlier than hardMs');
  assert.ok(Date.now() - t0 < 155, 'hard cap fires close to hardMs despite progress');
});

test('timeout fires exactly once and poke() cannot resurrect a fired governor', async () => {
  const events = [];
  const gov = new TimeoutGovernor({ idleMs: 30, onExpire: (r) => events.push(r) });
  gov.start();
  await new Promise((r) => setTimeout(r, 60));
  gov.poke(); // must not resurrect a fired governor
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(events, ['idle']);
});

test('governor rejects non-positive idleMs/hardMs', () => {
  assert.throws(() => new TimeoutGovernor({ idleMs: 0, onExpire: () => undefined }));
  assert.throws(() => new TimeoutGovernor({ idleMs: 100, hardMs: -5, onExpire: () => undefined }));
});

// —— 1.2 GPU tier heuristic (labeled; raw info shown beside it) ————————————

const info = (vendor, architecture, device = '', description = '') => ({ vendor, architecture, device, description });

test('software adapter info → softwareGpu=true → tier software', () => {
  for (const i of [
    info('Google', 'swiftshader', '', 'SwiftShader'),
    info('Mesa', 'lavapipe'),
    info('Mesa', 'llvmpipe'),
    info('X', 'software renderer'),
    info('X', 'basic render'),
  ]) {
    assert.equal(isSoftwareGpuInfo(i), true, JSON.stringify(i));
    assert.equal(classifyGpuTier({ info: i, softwareGpu: true }), 'software');
  }
  assert.equal(isSoftwareGpuInfo(info('NVIDIA', 'RTX 4090')), false);
  assert.equal(isSoftwareGpuInfo(null), false);
});

test('dGPU name patterns → high (enough deviceMemory) / mid (little)', () => {
  const rtx = info('NVIDIA', 'RTX 4070 Ada');
  assert.equal(classifyGpuTier({ info: rtx, softwareGpu: false, deviceMemory: 8 }), 'high');
  assert.equal(classifyGpuTier({ info: rtx, softwareGpu: false, deviceMemory: 4 }), 'mid');
  const rx = info('AMD', 'Radeon RX 7800M');
  assert.equal(classifyGpuTier({ info: rx, softwareGpu: false }), 'high');
});

test('iGPU name patterns → mid/entry; unknown names → entry (conservative)', () => {
  const uhd = info('Intel', 'UHD Graphics 620');
  assert.equal(classifyGpuTier({ info: uhd, softwareGpu: false, deviceMemory: 8 }), 'mid');
  assert.equal(classifyGpuTier({ info: uhd, softwareGpu: false, deviceMemory: 4 }), 'entry');
  const xe = info('Intel(R)', 'Iris(Xe) Graphics');
  assert.equal(classifyGpuTier({ info: xe, softwareGpu: false }), 'mid');
  assert.equal(classifyGpuTier({ info: info('Unknown', 'Math Co-Processor'), softwareGpu: false }), 'entry');
  assert.equal(classifyGpuTier({ info: null, softwareGpu: false }), 'entry');
});

test('full-featured limits lift an unnamed adapter to mid; small RAM downgrades one step', () => {
  const limits = { maxTextureDimension2D: 16384 };
  assert.equal(classifyGpuTier({ info: info('Acme', 'Gfx'), softwareGpu: false, limits }), 'mid');
  assert.equal(classifyGpuTier({ info: info('Acme', 'Gfx'), softwareGpu: false, deviceMemory: 2, limits }), 'entry');
});

test('advisory megapixel ceiling exists per tier', () => {
  assert.equal(TIER_NEURAL_MEGAPIXELS.software, 0.5);
  assert.ok(TIER_NEURAL_MEGAPIXELS.high > TIER_NEURAL_MEGAPIXELS.mid);
});

// —— 1.3 Tier-driven tile policy ————————————————————————————————————————————

test('tile policy by tier (lowVram overrides downward, wasm clamps by threads)', () => {
  const cap = (tier) => ({ lowVram: false, gpuTier: tier, webgpu: true });
  assert.deepEqual(tilePolicyFor(cap('high')), { tileSize: 512, overlap: 24, concurrency: 4 });
  assert.deepEqual(tilePolicyFor(cap('mid')), { tileSize: 512, overlap: 16, concurrency: 4 });
  assert.deepEqual(tilePolicyFor(cap('entry')), { tileSize: 256, overlap: 16, concurrency: 2 });
  assert.deepEqual(tilePolicyFor(cap('software')), { tileSize: 256, overlap: 16, concurrency: 2 });
  // Unknown/missing tier → conservative entry.
  assert.deepEqual(tilePolicyFor({ lowVram: false, webgpu: true }), { tileSize: 256, overlap: 16, concurrency: 2 });
  // lowVram wins over a high tier.
  assert.deepEqual(tilePolicyFor({ lowVram: true, gpuTier: 'high', webgpu: true }), {
    tileSize: 256,
    overlap: 16,
    concurrency: 2,
  });
  // WASM EP clamps concurrency to hardware threads (caps without WebGPU).
  const wasmCap = (tier) => ({ lowVram: false, gpuTier: tier, webgpu: false });
  assert.equal(tilePolicyFor(wasmCap('mid'), 2).concurrency, 2);
  assert.equal(tilePolicyFor(wasmCap('mid'), 16).concurrency, 4);
});

// —— 1.2 Catalog routing with softwareGpu / dualGpu —————————————————————————

const WEBGPU_ONLY = { webgpu: 'https://m/fp16.onnx' };
const BOTH = { webgpu: 'https://m/fp16.onnx', wasm: 'https://m/fp32.onnx' };

test('softwareGpu + wasm variant → routed to wasm with recorded reason', () => {
  const sel = selectModelVariant(BOTH, {
    webgpu: true,
    wasm: true,
    wasmThreads: false,
    lowVram: false,
    softwareGpu: true,
    dualGpu: false,
    adapterInfo: info('Google', 'swiftshader'),
    gpuTier: 'software',
  });
  assert.equal(sel.variant, 'wasm');
  assert.equal(sel.url, 'https://m/fp32.onnx');
  assert.match(sel.reason, /software GPU adapter/);
});

test('softwareGpu without a wasm variant → proceeds on webgpu with honest reason', () => {
  const sel = selectModelVariant(WEBGPU_ONLY, { webgpu: true, softwareGpu: true });
  assert.equal(sel.variant, 'webgpu');
  assert.match(sel.reason, /no wasm variant/);
});

test('dualGpu note recorded on webgpu selection', () => {
  const sel = selectModelVariant(BOTH, { webgpu: true, softwareGpu: false, dualGpu: true });
  assert.equal(sel.variant, 'webgpu');
  assert.match(sel.reason, /high-performance adapter/);
});

test('plain webgpu selection has no reason field (unchanged shape)', () => {
  const sel = selectModelVariant(BOTH, { webgpu: true, softwareGpu: false, dualGpu: false });
  assert.equal(sel.reason, undefined);
  assert.equal(sel.variant, 'webgpu');
  assert.equal(sel.wasmFallbackUrl, 'https://m/fp32.onnx');
});

// —— 1.4 Single-EP session guarantee + explicit creation fallback ———————————

function fakeSession() {
  return {
    inputNames: ['input'],
    outputNames: ['output'],
    inputMetadata: [{ isTensor: true, type: 'float32' }],
    run: async () => {
      throw new Error('not used in these tests');
    },
    release: async () => undefined,
  };
}

function makeManager() {
  const events = [];
  const factory = async (bytes, eps) => {
    events.push({ type: 'create', eps: [...eps] });
    return factory.behavior(eps);
  };
  factory.behavior = () => fakeSession();
  const mm = new ModelManager(
    {
      onDownloadProgress: () => undefined,
      onFallback: (reason, swappedTo) => events.push({ type: 'fallback', reason, swappedTo }),
    },
    factory,
    (url) => {
      events.push({ type: 'acquire', url });
      return new ArrayBuffer(64);
    },
  );
  return { mm, events, factory };
}

test('session is created with EXACTLY ONE execution provider (never a two-EP list)', async () => {
  const { mm, events } = makeManager();
  await mm.loadModel({
    modelUrl: 'https://m/model.onnx',
    capabilities: { webgpu: true, wasm: true, wasmThreads: false, lowVram: false },
  });
  assert.deepEqual(
    events.filter((e) => e.type === 'create').map((e) => e.eps),
    [['webgpu']],
  );
  assert.equal(mm.actualEp, 'webgpu');
  assert.equal(mm.requestedEp, 'webgpu');
  assert.equal(mm.activeVariant, 'webgpu');
});

test('webgpu init failure → explicit fallback: wasm session, fallback event, actualEp=wasm', async () => {
  const { mm, events, factory } = makeManager();
  factory.behavior = (eps) => {
    if (eps[0] === 'webgpu') {
      throw new Error('JSEP device creation failed');
    }
    return fakeSession();
  };
  // One file for every EP (simple path): creation fallback reuses it.
  const result = await mm.loadModel({
    modelUrl: 'https://m/model.onnx',
    capabilities: { webgpu: true, wasm: true, wasmThreads: false, lowVram: false },
  });
  assert.deepEqual(
    events.filter((e) => e.type === 'create').map((e) => e.eps),
    [['webgpu'], ['wasm']],
    'exactly one EP per creation attempt',
  );
  assert.equal(result.variant, 'wasm');
  assert.equal(result.actualEp, 'wasm');
  assert.equal(result.requestedEp, 'webgpu');
  const fallbacks = events.filter((e) => e.type === 'fallback');
  assert.equal(fallbacks.length, 1);
  assert.match(fallbacks[0].reason, /WebGPU session creation failed/);
  assert.equal(fallbacks[0].swappedTo, 'same-file');
  assert.equal(mm.actualEp, 'wasm');
});

test('cataloged wasm variant is used for creation fallback (cache-first acquisition)', async () => {
  const { mm, events, factory } = makeManager();
  factory.behavior = (eps) => {
    if (eps[0] === 'webgpu') {
      throw new Error('no adapter');
    }
    return fakeSession();
  };
  const result = await mm.loadModel({
    models: { webgpu: 'https://m/fp16.onnx', wasm: 'https://m/fp32.onnx' },
    capabilities: { webgpu: true, wasm: true, wasmThreads: false, lowVram: false },
  });
  assert.equal(result.variant, 'wasm');
  assert.equal(result.url, 'https://m/fp32.onnx');
  assert.equal(result.actualEp, 'wasm');
  assert.equal(result.requestedEp, 'webgpu');
  const fallbacks = events.filter((e) => e.type === 'fallback');
  assert.equal(fallbacks[0].swappedTo, 'wasm-variant');
  assert.deepEqual(
    events.filter((e) => e.type === 'create').map((e) => e.eps),
    [['webgpu'], ['wasm']],
  );
});

test('loadModel resolves reason on the result (software routing)', async () => {
  const { mm } = makeManager();
  const result = await mm.loadModel({
    models: { webgpu: 'https://m/fp16.onnx', wasm: 'https://m/fp32.onnx' },
    capabilities: {
      webgpu: true,
      wasm: true,
      wasmThreads: false,
      lowVram: false,
      softwareGpu: true,
      adapterInfo: info('Google', 'swiftshader'),
      gpuTier: 'software',
    },
  });
  assert.equal(result.variant, 'wasm');
  assert.match(result.reason, /software GPU adapter/);
});

test('forceReload rebuilds the session even when the URL is unchanged', async () => {
  const { mm, events } = makeManager();
  const caps = { webgpu: true, wasm: true, wasmThreads: false, lowVram: false };
  await mm.loadModel({ modelUrl: 'https://m/model.onnx', capabilities: caps });
  await mm.loadModel({ modelUrl: 'https://m/model.onnx', capabilities: caps });
  assert.equal(events.filter((e) => e.type === 'create').length, 1, 'same URL + no flag → reused');
  await mm.loadModel({ modelUrl: 'https://m/model.onnx', capabilities: caps, forceReload: true });
  assert.equal(events.filter((e) => e.type === 'create').length, 2, 'forceReload → rebuilt');
});

// —— 1.6 Diagnostics + config validation ————————————————————————————————————

test('getDiagnostics: synchronous snapshot with documented shape', () => {
  const engine = new UpscalerEngine({ models: BOTH });
  const d0 = engine.getDiagnostics();
  assert.equal(d0.sessionActive, false);
  assert.equal(d0.capabilities, null); // not probed yet
  assert.equal(d0.chosenVariant, undefined);
  engine.destroy();
});

test('engine config validates gpuPreference and hardTimeoutMs', () => {
  assert.throws(() => new UpscalerEngine({ gpuPreference: 'max-fps' }), (err) => err instanceof UpscalerError);
  assert.throws(() => new UpscalerEngine({ hardTimeoutMs: 0 }), (err) => err instanceof UpscalerError);
  // Valid values construct fine.
  for (const cfg of [{ gpuPreference: 'low-power' }, { gpuPreference: 'default' }, { hardTimeoutMs: 60_000 }]) {
    const e = new UpscalerEngine(cfg);
    e.destroy();
  }
});

test('destroy() clears diagnostics session truth', () => {
  const engine = new UpscalerEngine({ models: BOTH });
  engine.destroy();
  const d = engine.getDiagnostics();
  assert.equal(d.sessionActive, false);
});
