/**
 * The public engine class. See `src/index.ts` for re-exports.
 *
 * Contracts implemented here:
 *  - Two-Gate: the engine NEVER downloads the neural model implicitly.
 *    `loadModel()` is a consumer-triggered call, made after user consent.
 *  - Object URL lifecycle: the engine creates the Blob URL for the
 *    `complete` event; the CONSUMER is responsible for calling
 *    `URL.revokeObjectURL()` when done. The engine must not revoke the URL
 *    because the consumer may still be using it after the promise resolves.
 *  - Errors: every operational failure is emitted on the `error` event AND
 *    rejected on the operation's promise. Pure usage errors (bad scale,
 *    missing modelUrl, neural before loadModel) throw typed errors without
 *    emitting, so accidental misuse doesn't pollute the event stream.
 *  - One operation at a time. The worker is strictly serialized.
 *
 * v0.3.0 (incident-driven):
 *  - `timeout` is an INACTIVITY timeout (worker messages reset it); an
 *    optional `hardTimeoutMs` caps the total absolutely. A progressing job
 *    is never killed by the idle limit (the 300s-kill incident).
 *  - `gpuPreference` (default 'high-performance') steers adapter probing so
 *    dual-GPU machines get the dGPU for this compute workload.
 *  - `getDiagnostics()` exposes the synchronous truth snapshot: chosen
 *    variant, requested/actual EP, adapter info, tier, dual-GPU, last tile
 *    duration.
 */

import { DeviceRouter, type AdapterInfoSummary, type Capabilities, type GpuPreference, type GpuTier } from './DeviceRouter.js';
import { EventEmitter, type UpscalerEventListener, type UpscalerEventType } from './EventEmitter.js';
import { UpscalerError } from './errors.js';
import type { LoadModelResult, Quantization } from './ModelManager.js';
import { WorkerController, type ForwardableWorkerEvent, type Method, type ProcessParams } from './WorkerController.js';

export interface UpscalerEngineConfig {
  /** Simple path: one model URL for every execution provider. */
  modelUrl?: string;
  /**
   * Catalog path (takes precedence over `modelUrl` when both are given):
   * capability-aware model selection. PRECISION is an engine decision made
   * from probed hardware; JOB and SCALE remain consumer decisions. At least
   * a `wasm` variant is required for any environment without WebGPU.
   */
  models?: { webgpu?: string; wasm?: string };
  /**
   * Worker INACTIVITY timeout in ms — reset by every worker message
   * (progress, fallback, heartbeat). A silent worker is killed with a
   * non-recoverable TIMEOUT error; a progressing worker is never killed by
   * this. Default 300_000. (v0.2.0 and earlier: absolute wall-clock.)
   */
  timeout?: number;
  /**
   * Optional ABSOLUTE cap in ms that overrides the idle logic — the job is
   * killed when total elapsed time exceeds it even if progress continues.
   * Default: disabled.
   */
  hardTimeoutMs?: number;
  /** Maximum allowed input width/height in px. Default 16384. */
  maxDimension?: number;
  /**
   * Adapter preference for WebGPU probing. Default 'high-performance' — a
   * compute workload wants the dGPU; the browser default may pick an iGPU
   * (10-50x slower on dual-GPU machines). Change to 'low-power' or
   * 'default' deliberately.
   */
  gpuPreference?: GpuPreference;
  /** Override ONNX Runtime's artifact directory. Default: jsDelivr CDN. */
  ortWasmPaths?: string;
  /**
   * Model variant selector for directory-style `modelUrl` (simple path only).
   * Default 'fp16'.
   */
  quantization?: Quantization;
}

export interface ProcessOptions {
  method: Method;
  scale: 2 | 4;
  format?: 'image/png' | 'image/webp';
  quality?: number;
}

/** Synchronous truth snapshot — see {@link UpscalerEngine.getDiagnostics}. */
export interface EngineDiagnostics {
  /** Last probed capabilities (null before any probe). */
  capabilities: Capabilities | null;
  /** Variant the loaded session runs (from loadModel's result). */
  chosenVariant?: 'webgpu' | 'wasm';
  /** EP the capability decision asked for. */
  requestedEp?: 'webgpu' | 'wasm';
  /** EP the successful session was created with (single-EP guarantee). */
  actualEp?: 'webgpu' | 'wasm';
  /** Raw adapter info — shown beside any tier heuristic, never replaced. */
  adapterInfo?: AdapterInfoSummary | null;
  /** HEURISTIC tier; raw `adapterInfo` is the ground truth beside it. */
  gpuTier?: GpuTier;
  /** Two power-preference probes returned different adapters. */
  dualGpu?: boolean;
  /** Duration (ms) of the most recently completed tile. */
  lastTileDurationMs?: number;
  /** True while a loaded ORT session lives in the worker. */
  sessionActive: boolean;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_DIMENSION = 16384;
const DEFAULT_QUANTIZATION: Quantization = 'fp16';
const DEFAULT_GPU_PREFERENCE: GpuPreference = 'high-performance';
const VALID_QUANTIZATIONS: readonly Quantization[] = ['fp32', 'fp16', 'int8'];
const VALID_METHODS: readonly Method[] = ['lanczos', 'bicubic', 'neural'];
const VALID_FORMATS: readonly string[] = ['image/png', 'image/webp'];
const VALID_PREFERENCES: readonly GpuPreference[] = ['high-performance', 'low-power', 'default'];

export class UpscalerEngine {
  readonly #events = new EventEmitter();
  readonly #device = new DeviceRouter();
  readonly #config: Required<Pick<UpscalerEngineConfig, 'timeout' | 'maxDimension' | 'quantization'>> & UpscalerEngineConfig;
  readonly #controller: WorkerController;
  readonly #capabilities = new Map<GpuPreference, Capabilities>();
  #activePreference: GpuPreference;
  #loadResult: (LoadModelResult & { requestedEp: 'webgpu' | 'wasm'; actualEp: 'webgpu' | 'wasm' }) | null = null;
  #modelLoaded = false;
  #destroyed = false;
  #lastTileDurationMs: number | undefined = undefined;

  constructor(config: UpscalerEngineConfig = {}) {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxDimension = config.maxDimension ?? DEFAULT_MAX_DIMENSION;
    const quantization = config.quantization ?? DEFAULT_QUANTIZATION;
    const gpuPreference = config.gpuPreference ?? DEFAULT_GPU_PREFERENCE;

    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new UpscalerError('INVALID_INPUT', `config.timeout must be a positive number (ms), got ${String(timeout)}.`);
    }
    if (config.hardTimeoutMs !== undefined && (!Number.isFinite(config.hardTimeoutMs) || config.hardTimeoutMs <= 0)) {
      throw new UpscalerError('INVALID_INPUT', `config.hardTimeoutMs must be a positive number (ms) or undefined, got ${String(config.hardTimeoutMs)}.`);
    }
    if (!Number.isInteger(maxDimension) || maxDimension <= 0) {
      throw new UpscalerError('INVALID_INPUT', `config.maxDimension must be a positive integer, got ${String(maxDimension)}.`);
    }
    if (!VALID_QUANTIZATIONS.includes(quantization)) {
      throw new UpscalerError('INVALID_INPUT', `config.quantization must be one of ${VALID_QUANTIZATIONS.join(', ')}, got ${String(quantization)}.`);
    }
    if (!VALID_PREFERENCES.includes(gpuPreference)) {
      throw new UpscalerError('INVALID_INPUT', `config.gpuPreference must be one of ${VALID_PREFERENCES.join(', ')}, got ${String(gpuPreference)}.`);
    }

    this.#config = { ...config, timeout, maxDimension, quantization };
    this.#activePreference = gpuPreference;
    this.#controller = new WorkerController(
      {
        onEvent: (event) => this.#forwardWorkerEvent(event),
        onWorkerDied: () => {
          // The ORT session lived in the terminated worker — gone.
          this.#modelLoaded = false;
          this.#loadResult = null;
        },
      },
      {
        idleMs: timeout,
        ...(config.hardTimeoutMs !== undefined ? { hardMs: config.hardTimeoutMs } : {}),
      },
    );
  }

  /**
   * Subscribes to a typed engine event. Returns an unsubscribe function.
   * Events: `model_download`, `tile_processing`, `fallback`, `complete`,
   * `error` — see the README for exact payload shapes.
   */
  on<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): () => void {
    return this.#events.on(type, handler);
  }

  /** Removes a previously subscribed handler. */
  off<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): void {
    this.#events.off(type, handler);
  }

  /**
   * Probes (and memoizes, per preference) hardware capabilities: WebGPU
   * adapter presence (honest `requestAdapter()` probe with the configured
   * `gpuPreference`), WASM availability, WASM threading (cross-origin
   * isolation), the conservative lowVram hint, and the v0.3.0 additive
   * fields (adapterInfo, dualGpu, softwareGpu, gpuTier).
   *
   * An explicit `preference` overrides the configured one for this call
   * (used by GPU pickers); results are cached per preference.
   */
  async detectDevice(preference?: GpuPreference): Promise<Capabilities> {
    this.#assertAlive();
    const pref = preference ?? this.#activePreference;
    if (preference) {
      this.#assertValidPreference(preference);
    }
    let caps = this.#capabilities.get(pref);
    if (!caps) {
      caps = await this.#device.getCapabilities(pref);
      this.#capabilities.set(pref, caps);
    }
    return caps;
  }

  /**
   * Downloads (cache-first) the selected model and creates the ORT session.
   * Consumer-triggered ONLY — call this after the user has consented to the
   * download (Two-Gate flow). Emits `model_download` progress while
   * streaming; emits nothing and reports `cached: true` on cache hits.
   *
   * Catalog path: selection happens HERE against freshly probed hardware —
   * `capabilities.webgpu && models.webgpu` → the webgpu variant (routed to
   * the wasm variant on a software GPU adapter); else `models.wasm` (missing
   * variant ⇒ typed `MODEL_VARIANT_MISSING` error). The returned
   * {@link LoadModelResult} reports which variant and URL were selected —
   * and, additively, WHY when the choice is non-obvious.
   *
   * An explicit `preference` re-probes and REBUILDS the session for that
   * adapter (GPU-picker flow; no hot-swap — a WebGPU constraint).
   */
  async loadModel(preference?: GpuPreference): Promise<LoadModelResult> {
    this.#assertAlive();
    if (preference) {
      this.#assertValidPreference(preference);
      this.#activePreference = preference;
    }

    // Both paths configured: the catalog wins. Validate so the consumer
    // learns about the ignored key instead of silently using one URL.
    if (this.#config.models && this.#config.modelUrl) {
      throw new UpscalerError(
        'INVALID_INPUT',
        'Pass EITHER modelUrl OR models — the models catalog takes precedence, so a simultaneously configured modelUrl is almost certainly a mistake.',
        { recoverable: true },
      );
    }

    const capabilities = await this.detectDevice(this.#activePreference);
    const forceReload = preference !== undefined && this.#modelLoaded;
    let result: LoadModelResult & { requestedEp: 'webgpu' | 'wasm'; actualEp: 'webgpu' | 'wasm' };
    try {
      result = await this.#controller.loadModel({
        // Simple path: expand dir-style URL here (quantization is an
        // engine-config concern). Catalog URLs are used verbatim.
        modelUrl: this.#config.modelUrl ? this.#resolveModelUrl() : undefined,
        models: this.#config.models,
        capabilities,
        ortWasmPaths: this.#config.ortWasmPaths,
        forceReload,
      });
    } catch (err) {
      throw this.#asEmitted(err);
    }
    this.#modelLoaded = true;
    this.#loadResult = result;
    return {
      variant: result.variant,
      url: result.url,
      cached: result.cached,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }

  /**
   * Processes an image buffer (any format `createImageBitmap` decodes).
   *
   * - `lanczos` / `bicubic` run through the Rust/WASM scalers; no model is
   *   needed, and progress is reported as a single tile (they are not tiled).
   * - `neural` requires a prior `loadModel()`. Real-ESRGAN is fixed 4x:
   *   `scale: 2` produces the 4x result and Lanczos-downsizes to 2x.
   * - The input ArrayBuffer is TRANSFERRED to the worker (zero-copy) and is
   *   detached afterwards — do not reuse it.
   *
   * Resolves with the output Blob; also emits `complete` with an object URL
   * the CONSUMER must revoke (`URL.revokeObjectURL`) when done.
   */
  async process(buffer: ArrayBuffer, options: ProcessOptions): Promise<Blob> {
    this.#assertAlive();

    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
      throw new UpscalerError(
        'INVALID_INPUT',
        'process() requires a non-empty ArrayBuffer. Note: the engine transfers it (zero-copy), so a buffer from a previous process() call is detached and cannot be reused.',
        { recoverable: true },
      );
    }
    if (!VALID_METHODS.includes(options.method)) {
      throw new UpscalerError('INVALID_METHOD', `options.method must be one of ${VALID_METHODS.join(', ')}, got ${String(options.method)}.`, {
        recoverable: true,
      });
    }
    if (options.scale !== 2 && options.scale !== 4) {
      throw new UpscalerError('INVALID_SCALE', `options.scale must be 2 or 4, got ${String(options.scale)}.`, { recoverable: true });
    }
    if (options.format !== undefined && !VALID_FORMATS.includes(options.format)) {
      throw new UpscalerError('INVALID_INPUT', `options.format must be 'image/png' or 'image/webp', got ${String(options.format)}.`, {
        recoverable: true,
      });
    }
    if (options.quality !== undefined && !(Number.isFinite(options.quality) && options.quality >= 0 && options.quality <= 1)) {
      throw new UpscalerError('INVALID_INPUT', `options.quality must be within [0, 1], got ${String(options.quality)}.`, {
        recoverable: true,
      });
    }
    if (options.method === 'neural' && !this.#modelLoaded) {
      throw new UpscalerError(
        'MODEL_NOT_LOADED',
        'process({ method: "neural" }) requires a prior loadModel() call — the engine never downloads the model implicitly. ' +
          'Use lanczos or bicubic for instant, download-free upscaling.',
        { recoverable: true },
      );
    }

    // Neural work must run under the SAME capability probe the session was
    // created from (tile tier policy matches the loaded EP).
    const capabilities = await this.detectDevice(this.#activePreference);
    const params: ProcessParams = {
      buffer,
      method: options.method,
      scale: options.scale,
      format: options.format ?? 'image/png',
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
      capabilities,
      maxDimension: this.#config.maxDimension,
    };

    let blob: Blob;
    try {
      blob = await this.#controller.process(params);
    } catch (err) {
      throw this.#asEmitted(err);
    }

    const blobUrl = URL.createObjectURL(blob);
    this.#events.emit({ type: 'complete', blobUrl });
    return blob;
  }

  /**
   * Synchronous truth snapshot: what hardware was probed, which variant was
   * chosen and why, which EP was requested vs actually created (the
   * single-EP guarantee makes `actualEp` recorded fact, not a guess), the
   * raw adapter info beside the tier heuristic, and the last tile duration.
   */
  getDiagnostics(): EngineDiagnostics {
    const capabilities = this.#capabilities.get(this.#activePreference) ?? null;
    return {
      capabilities,
      ...(this.#loadResult
        ? {
            chosenVariant: this.#loadResult.variant,
            requestedEp: this.#loadResult.requestedEp,
            actualEp: this.#loadResult.actualEp,
          }
        : {}),
      ...(capabilities?.adapterInfo !== undefined ? { adapterInfo: capabilities.adapterInfo } : {}),
      ...(capabilities?.gpuTier !== undefined ? { gpuTier: capabilities.gpuTier } : {}),
      ...(capabilities?.dualGpu !== undefined ? { dualGpu: capabilities.dualGpu } : {}),
      ...(this.#lastTileDurationMs !== undefined ? { lastTileDurationMs: this.#lastTileDurationMs } : {}),
      sessionActive: this.#modelLoaded && !this.#destroyed,
    };
  }

  /**
   * Tears the engine down: terminates the worker (which frees the ORT
   * session and all WASM memory — they lived in the worker's heap), rejects
   * any in-flight operation, and clears every listener. The instance is
   * unusable afterwards.
   */
  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#controller.dispose();
    this.#modelLoaded = false;
    this.#loadResult = null;
    this.#capabilities.clear();
    this.#events.clear();
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new UpscalerError('DESTROYED', 'This UpscalerEngine instance has been destroyed. Create a new instance.', {
        recoverable: false,
      });
    }
  }

  #assertValidPreference(preference: GpuPreference): void {
    if (!VALID_PREFERENCES.includes(preference)) {
      throw new UpscalerError('INVALID_INPUT', `gpu preference must be one of ${VALID_PREFERENCES.join(', ')}, got ${String(preference)}.`, {
        recoverable: true,
      });
    }
  }

  /**
   * Two-Gate support (simple path): a directory-style `modelUrl` gets the
   * quantization-variant filename appended. The catalog path never touches
   * this — its URLs are used verbatim. No default remote host is invented —
   * a missing modelUrl/models throws.
   */
  #resolveModelUrl(): string {
    const url = this.#config.modelUrl;
    if (!url) {
      throw new UpscalerError(
        'MODEL_URL_REQUIRED',
        'loadModel() requires either a modelUrl or a models catalog ({ webgpu?, wasm? }) in the engine config. The engine never downloads a model without the consumer explicitly configuring and calling loadModel() (Two-Gate flow).',
        { recoverable: true },
      );
    }
    if (url.endsWith('/')) {
      return `${url}realesrgan-x4-${this.#config.quantization}.onnx`;
    }
    return url;
  }

  /**
   * Worker events become engine events. Errors are forwarded for the event
   * stream; the controller already rejected the operation's promise with
   * the same error.
   */
  #forwardWorkerEvent(event: ForwardableWorkerEvent): void {
    switch (event.kind) {
      case 'model_download':
        this.#events.emit({ type: 'model_download', progress: event.progress });
        return;
      case 'tile_processing':
        if (event.tileDurationMs !== undefined) {
          this.#lastTileDurationMs = event.tileDurationMs;
        }
        this.#events.emit({
          type: 'tile_processing',
          tileIndex: event.tileIndex,
          totalTiles: event.totalTiles,
          ...(event.tileDurationMs !== undefined ? { tileDurationMs: event.tileDurationMs } : {}),
          ...(event.etaMs !== undefined ? { etaMs: event.etaMs } : {}),
        });
        return;
      case 'fallback':
        this.#events.emit({
          type: 'fallback',
          from: 'webgpu',
          to: 'wasm',
          reason: event.swappedTo === 'wasm-variant' ? `${event.reason} (swapped to the wasm variant)` : event.reason,
          ...(event.swappedTo !== undefined ? { swappedTo: event.swappedTo } : {}),
        });
        return;
      case 'error':
        this.#events.emit({ type: 'error', message: event.message, recoverable: event.recoverable });
        return;
    }
  }

  /**
   * Emits an `error` event for operational failures and returns the error
   * so the caller can throw it (single source of truth, two channels).
   * Usage errors that never reached the worker are NOT re-emitted here.
   */
  #asEmitted(err: unknown): UpscalerError {
    const error =
      err instanceof UpscalerError
        ? err
        : new UpscalerError('WORKER_FAILED', err instanceof Error ? err.message : String(err), {
            recoverable: false,
            cause: err,
          });
    // Worker-reported failures were already emitted on the event stream by
    // the controller; emit only once (the promise rejects either way).
    if (!error.forwarded) {
      this.#events.emit({ type: 'error', message: error.message, recoverable: error.recoverable });
    }
    return error;
  }
}
