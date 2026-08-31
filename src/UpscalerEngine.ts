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
 */

import { DeviceRouter, type Capabilities } from './DeviceRouter.js';
import { EventEmitter, type UpscalerEventListener, type UpscalerEventType } from './EventEmitter.js';
import { UpscalerError } from './errors.js';
import type { Quantization } from './ModelManager.js';
import { WorkerController, type ForwardableWorkerEvent, type Method, type ProcessParams } from './WorkerController.js';

export interface UpscalerEngineConfig {
  /** Required for neural processing — see `src/index.ts` docs. */
  modelUrl?: string;
  /** Per-operation timeout in ms (worker is killed on expiry). Default 300_000. */
  timeout?: number;
  /** Maximum allowed input width/height in px. Default 16384. */
  maxDimension?: number;
  /** Override ONNX Runtime's artifact directory. Default: jsDelivr CDN. */
  ortWasmPaths?: string;
  /** Model variant selector for directory-style modelUrl. Default 'fp16'. */
  quantization?: Quantization;
}

export interface ProcessOptions {
  method: Method;
  scale: 2 | 4;
  format?: 'image/png' | 'image/webp';
  quality?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_DIMENSION = 16384;
const DEFAULT_QUANTIZATION: Quantization = 'fp16';
const VALID_QUANTIZATIONS: readonly Quantization[] = ['fp32', 'fp16', 'int8'];
const VALID_METHODS: readonly Method[] = ['lanczos', 'bicubic', 'neural'];
const VALID_FORMATS: readonly string[] = ['image/png', 'image/webp'];

export class UpscalerEngine {
  readonly #events = new EventEmitter();
  readonly #device = new DeviceRouter();
  readonly #config: Required<Pick<UpscalerEngineConfig, 'timeout' | 'maxDimension' | 'quantization'>> & UpscalerEngineConfig;
  readonly #controller: WorkerController;
  #capabilities: Capabilities | null = null;
  #modelLoaded = false;
  #destroyed = false;

  constructor(config: UpscalerEngineConfig = {}) {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxDimension = config.maxDimension ?? DEFAULT_MAX_DIMENSION;
    const quantization = config.quantization ?? DEFAULT_QUANTIZATION;

    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new UpscalerError('INVALID_INPUT', `config.timeout must be a positive number (ms), got ${String(timeout)}.`);
    }
    if (!Number.isInteger(maxDimension) || maxDimension <= 0) {
      throw new UpscalerError('INVALID_INPUT', `config.maxDimension must be a positive integer, got ${String(maxDimension)}.`);
    }
    if (!VALID_QUANTIZATIONS.includes(quantization)) {
      throw new UpscalerError('INVALID_INPUT', `config.quantization must be one of ${VALID_QUANTIZATIONS.join(', ')}, got ${String(quantization)}.`);
    }

    this.#config = { ...config, timeout, maxDimension, quantization };
    this.#controller = new WorkerController(
      {
        onEvent: (event) => this.#forwardWorkerEvent(event),
        onWorkerDied: () => {
          // The ORT session lived in the terminated worker — gone.
          this.#modelLoaded = false;
        },
      },
      timeout,
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
   * Probes (and memoizes) hardware capabilities: WebGPU adapter presence
   * (honest `requestAdapter()` probe), WASM availability, WASM threading
   * (cross-origin isolation), and the conservative lowVram hint.
   */
  async detectDevice(): Promise<Capabilities> {
    this.#assertAlive();
    if (!this.#capabilities) {
      this.#capabilities = await this.#device.getCapabilities();
    }
    return this.#capabilities;
  }

  /**
   * Downloads (cache-first) the neural model and creates the ORT session.
   * Consumer-triggered ONLY — call this after the user has consented to the
   * download (Two-Gate flow). Emits `model_download` progress while
   * streaming; emits nothing when the model is already cached.
   */
  async loadModel(): Promise<void> {
    this.#assertAlive();
    const modelUrl = this.#resolveModelUrl();

    const capabilities = await this.detectDevice();
    try {
      await this.#controller.loadModel({
        modelUrl,
        quantization: this.#config.quantization,
        capabilities,
        ortWasmPaths: this.#config.ortWasmPaths,
      });
    } catch (err) {
      throw this.#asEmitted(err);
    }
    this.#modelLoaded = true;
  }

  /**
   * Processes an image buffer (any format `createImageBitmap` decodes).
   *
   * - `lanczos` / `bicubic` run through the Rust/WASM scalers; no model is
   *   needed, and progress is reported as a single tile (they are not tiled).
   * - `neural` requires a prior `loadModel()`. Real-ESRGAN is fixed 4x:
   *   `scale: 2` produces the 4x result and Lanczos-downscales to 2x.
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

    const capabilities = await this.detectDevice();
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
    this.#capabilities = null;
    this.#events.clear();
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new UpscalerError('DESTROYED', 'This UpscalerEngine instance has been destroyed. Create a new instance.', {
        recoverable: false,
      });
    }
  }

  /**
   * Two-Gate support: if `modelUrl` is a base directory (ends with `/`),
   * the quantization-variant filename is appended; otherwise it is used
   * verbatim. No default remote host is invented — a missing modelUrl throws.
   */
  #resolveModelUrl(): string {
    const url = this.#config.modelUrl;
    if (!url) {
      throw new UpscalerError(
        'MODEL_URL_REQUIRED',
        'loadModel() requires a modelUrl in the engine config. The engine never downloads a model without the consumer explicitly configuring and calling loadModel() (Two-Gate flow).',
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
        this.#events.emit({ type: 'tile_processing', tileIndex: event.tileIndex, totalTiles: event.totalTiles });
        return;
      case 'fallback':
        this.#events.emit({ type: 'fallback', from: 'webgpu', to: 'wasm', reason: event.reason });
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
