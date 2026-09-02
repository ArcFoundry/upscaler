/**
 * Web Worker entry point for the upscaler engine (built as a SEPARATE tsup
 * entry → `dist/worker.js`; `WorkerController` spawns exactly that file).
 *
 * Responsibilities:
 *  - Route requests: classical methods → Rust/WASM scalers; `neural` →
 *    Real-ESRGAN via onnxruntime-web (tiled).
 *  - Own the ORT session (via ModelManager) and the tiling pipeline.
 *  - Own the Codec (decode/encode need OffscreenCanvas; keep them off the
 *    main thread).
 *  - Stream progress and fallback events back, then answer exactly once
 *    with `done`/`error`.
 *
 * Two distinct WASM file families live here — never conflate them:
 *  1. The Rust scalers, committed at `src/wasm/` and copied to `dist/wasm/`,
 *     loaded by the generated wasm-bindgen glue.
 *  2. ONNX Runtime's own artifacts, fetched via `ort.env.wasm.wasmPaths`
 *     (configured in ModelManager).
 */

import initUpscalerWasm, { WasmScalerJob } from './wasm/upscaler_wasm.js';

import { Codec, type OutputFormat } from './Codec.js';
import { DeviceRouter, type Capabilities } from './DeviceRouter.js';
import { ModelManager } from './ModelManager.js';
import { TileProcessor } from './TileProcessor.js';
import { UpscalerError } from './errors.js';
import type { Method, WorkerRequest, WorkerResponse } from './WorkerController.js';

/**
 * Initializes the Rust scaler module. The generated glue fetches the binary
 * from `./wasm/upscaler_wasm_bg.wasm` relative to this bundle (patched at
 * build time), i.e. `dist/wasm/` in the shipped package.
 */
let wasmReady: Promise<void> | null = null;
function initWasm(): Promise<void> {
  wasmReady ??= initUpscalerWasm().then(() => undefined);
  return wasmReady;
}

let capabilities: Capabilities | null = null;
async function getCapabilities(): Promise<Capabilities> {
  capabilities ??= await new DeviceRouter().getCapabilities();
  return capabilities;
}

interface WorkerState {
  model: ModelManager;
  tiles: TileProcessor;
}

let state: WorkerState | null = null;
let currentId = 0;

function getState(): WorkerState {
  if (!state) {
    const model = new ModelManager({
      onDownloadProgress: (progress) => emit({ kind: 'model_download', id: currentId, progress }),
      onFallback: (reason) => emit({ kind: 'fallback', id: currentId, reason }),
    });
    const tiles = new TileProcessor((tileIndex, totalTiles) =>
      emit({ kind: 'tile_processing', id: currentId, tileIndex, totalTiles }),
    );
    state = { model, tiles };
  }
  return state;
}

function emit(message: WorkerResponse): void {
  (self as unknown as { postMessage: (m: WorkerResponse) => void }).postMessage(message);
}

/**
 * Wraps a flat RGBA byte array (as returned by the Rust scalers) into
 * ImageData. wasm-bindgen returns exact, non-shared buffers; the cast only
 * narrows the ArrayBufferLike that TS's typed-array generics permit.
 */
function toImageData(bytes: Uint8Array, width: number, height: number): ImageData {
  return new ImageData(
    new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
    width,
    height,
  );
}

/**
 * Classical scaling through the Rust/WASM job API. The job holds its
 * buffers in the WASM heap; per the crate's memory-safety contract the JS
 * side MUST call `.free()` — done here in a `finally` so an error mid-run
 * cannot leak the heap.
 */
async function runClassical(
  image: ImageData,
  method: Extract<Method, 'lanczos' | 'bicubic'>,
  scale: 2 | 4,
  format: OutputFormat,
  quality?: number,
): Promise<Blob> {
  await initWasm();
  let job: WasmScalerJob | null = null;
  try {
    job = new WasmScalerJob(
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width,
      image.height,
      scale,
      method === 'lanczos',
    );
    job.process();
    const outBytes: Uint8Array = job.take_output();
    const out = toImageData(outBytes, Math.round(image.width * scale), Math.round(image.height * scale));
    return await Codec.encode(out, format, quality);
  } finally {
    job?.free();
  }
}

async function runNeural(
  image: ImageData,
  scale: 2 | 4,
  format: OutputFormat,
  quality?: number,
): Promise<Blob> {
  const { model, tiles } = getState();
  if (!model.isLoaded) {
    throw new UpscalerError(
      'MODEL_NOT_LOADED',
      'process({ method: "neural" }) requires a prior loadModel() call — the engine never downloads the model implicitly.',
      { recoverable: true },
    );
  }

  // Real-ESRGAN is a fixed 4x model: even when the consumer asked for 2x,
  // the 4x intermediate is produced first (then Lanczos-downscaled).
  const outW4 = image.width * 4;
  const outH4 = image.height * 4;
  if (outW4 > maxDimensionOf() || outH4 > maxDimensionOf()) {
    throw new UpscalerError(
      'DIMENSION_LIMIT',
      `Neural 4x intermediate ${outW4}x${outH4} exceeds maxDimension. Reduce the input size or raise maxDimension.`,
      { recoverable: false },
    );
  }

  const upscaled = await tiles.processNeural(image, await getCapabilities(), model);

  // scale 2 = 4x then Lanczos-downscale to 2x (documented contract).
  if (scale === 2) {
    await initWasm();
    let job: WasmScalerJob | null = null;
    try {
      job = new WasmScalerJob(
        new Uint8Array(upscaled.data.buffer, upscaled.data.byteOffset, upscaled.data.byteLength),
        upscaled.width,
        upscaled.height,
        0.5,
        true,
      );
      job.process();
      const outBytes: Uint8Array = job.take_output();
      const down = toImageData(outBytes, upscaled.width >> 1, upscaled.height >> 1);
      return await Codec.encode(down, format, quality);
    } finally {
      job?.free();
    }
  }

  return Codec.encode(upscaled, format, quality);
}

// Set per running process request; used by the neural dimension guard.
let runningMaxDimension = Number.POSITIVE_INFINITY;
function maxDimensionOf(): number {
  return runningMaxDimension;
}

async function runProcess(message: Extract<WorkerRequest, { kind: 'process' }>): Promise<Blob> {
  const image = await Codec.decode(message.buffer);

  if (image.width > message.maxDimension || image.height > message.maxDimension) {
    throw new UpscalerError(
      'DIMENSION_LIMIT',
      `Input ${image.width}x${image.height} exceeds maxDimension ${message.maxDimension} (default 16384).`,
      { recoverable: false },
    );
  }

  switch (message.method) {
    case 'lanczos':
    case 'bicubic':
      // Classical methods are NOT tiled: one WASM call processes the full
      // image. Report honest granularity — a single tile.
      emit({ kind: 'tile_processing', id: currentId, tileIndex: 0, totalTiles: 1 });
      return runClassical(image, message.method, message.scale, message.format, message.quality);
    case 'neural':
      runningMaxDimension = message.maxDimension;
      return runNeural(image, message.scale, message.format, message.quality);
  }
}

async function handle(message: WorkerRequest): Promise<void> {
  switch (message.kind) {
    case 'load-model': {
      const caps = await getCapabilities();
      const result = await getState().model.loadModel({
        modelUrl: message.modelUrl,
        models: message.models,
        capabilities: caps,
        ortWasmPaths: message.ortWasmPaths,
      });
      emit({ kind: 'ready', id: message.id, ...result });
      return;
    }
    case 'process': {
      const blob = await runProcess(message);
      emit({ kind: 'done', id: message.id, blob });
      return;
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const message = event.data;
  currentId = message.id;
  // Requests are strictly serialized by WorkerController, so a module-level
  // "current request id" is safe for attributing streamed events.
  void handle(message).catch(() => undefined); // handle() emits `error` itself
};
