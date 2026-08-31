/**
 * Honest hardware probing for the upscaler engine.
 *
 * Design rules (deliberate, non-negotiable):
 *  - WebGPU is probed by actually calling `navigator.gpu.requestAdapter()`.
 *    Merely checking `typeof navigator.gpu !== 'undefined'` lies: the API can
 *    be present while every adapter is blocklisted, disabled by policy, or
 *    fails creation. `requestAdapter()` rejects on blocklisted GPUs and
 *    resolves `null` when no adapter is usable — both mean "no WebGPU".
 *  - `navigator.deviceMemory` is Chromium-only; it is `undefined` on Firefox
 *    and Safari. An undefined reading means "unknown" — we treat unknown as
 *    LOW memory (`lowVram: true`) so routing stays conservative instead of
 *    optimistic. A reading of <= 4 GiB also flags lowVram.
 *  - `crossOriginIsolated` gates ONLY multi-threaded WASM (SharedArrayBuffer).
 *    It does NOT gate WebGPU, which needs just a secure context. Disabling
 *    WebGPU because a page lacks COOP/COEP headers is a classic bug this
 *    router refuses to make.
 */
/** Hardware capabilities as reported by {@link DeviceRouter.getCapabilities}. */
interface Capabilities {
    /** A usable WebGPU adapter exists (probed via requestAdapter()). */
    webgpu: boolean;
    /** WebAssembly is supported at all. */
    wasm: boolean;
    /** Multi-threaded WASM is available (requires crossOriginIsolated). */
    wasmThreads: boolean;
    /**
     * Conservative VRAM/Memory hint: true when deviceMemory is unknown
     * (Firefox/Safari) or <= 4 GiB. Drives smaller neural tiles.
     */
    lowVram: boolean;
}
declare class DeviceRouter {
    #private;
    /**
     * Probes (once, then memoizes) the device capabilities. Concurrent calls
     * share a single probe.
     */
    getCapabilities(): Promise<Capabilities>;
    /** Previously memoized capabilities, if a probe already completed. */
    get cached(): Capabilities | null;
}

/**
 * Framework-agnostic typed event stream for the upscaler engine.
 *
 * No DOM, no framework imports: the engine exposes `on()`/`off()`/`emit()`
 * and the exact event payload union below. All events are also relayed from
 * the Web Worker through {@link import('./WorkerController.js').WorkerController}.
 */
type ModelDownloadEvent = {
    type: 'model_download';
    /** Download progress in [0, 1]. Never emitted on a cache hit. */
    progress: number;
};
type TileProcessingEvent = {
    type: 'tile_processing';
    /** Zero-based index of the tile that started processing. */
    tileIndex: number;
    totalTiles: number;
};
type FallbackEvent = {
    type: 'fallback';
    from: 'webgpu';
    to: 'wasm';
    reason: string;
};
type CompleteEvent = {
    type: 'complete';
    /**
     * Object URL of the processed Blob, created by the engine on the main
     * thread. The CONSUMER must call `URL.revokeObjectURL(blobUrl)` when the
     * URL is no longer needed — the engine intentionally does not revoke it
     * because the consumer may still be rendering it.
     */
    blobUrl: string;
};
type ErrorEvent = {
    type: 'error';
    message: string;
    /**
     * true when the engine itself is still healthy and the consumer may retry
     * (bad input, busy, download failure). false when the failure is terminal
     * for the operation (timeout, dimension limit, unrecovered inference or
     * scaler failure) or for the worker.
     */
    recoverable: boolean;
};
/** The exact event payload union emitted by the engine. */
type UpscalerEvent = ModelDownloadEvent | TileProcessingEvent | FallbackEvent | CompleteEvent | ErrorEvent;
type UpscalerEventType = UpscalerEvent['type'];
type UpscalerEventListener<K extends UpscalerEventType> = (event: Extract<UpscalerEvent, {
    type: K;
}>) => void;
declare class EventEmitter {
    #private;
    /**
     * Subscribes to an event type. Returns an unsubscribe function; calling it
     * twice is a no-op.
     */
    on<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): () => void;
    /** Removes a previously subscribed handler. Unknown handlers are ignored. */
    off<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): void;
    /**
     * Dispatches an event to the current listeners of its type. The listener
     * set is snapshotted, so a handler may subscribe/unsubscribe during
     * dispatch without affecting the in-flight iteration. A throwing listener
     * is reported to the console and never breaks the engine or other listeners.
     */
    emit(event: UpscalerEvent): void;
    /** Removes every listener. Used by {@link import('./index.js').UpscalerEngine.destroy}. */
    clear(): void;
}

/**
 * Typed error type shared by the engine surface. Every rejection thrown by
 * the engine is an {@link UpscalerError}; every error surfaced through the
 * `error` event carries the same `code`-derived message.
 */
type UpscalerErrorCode = 
/** loadModel() called without a configured modelUrl. */
'MODEL_URL_REQUIRED'
/** process({ method: 'neural' }) called before loadModel(). */
 | 'MODEL_NOT_LOADED'
/** The model file could not be fetched from the configured URL. */
 | 'MODEL_DOWNLOAD_FAILED'
/** process() was called with a scale other than 2 or 4. */
 | 'INVALID_SCALE'
/** process() was called with an unknown method. */
 | 'INVALID_METHOD'
/** Malformed or unusable input buffer (empty/detached, bad quality). */
 | 'INVALID_INPUT'
/** Input image exceeds the configured maxDimension. */
 | 'DIMENSION_LIMIT'
/** The operation exceeded the configured timeout; the worker was killed. */
 | 'TIMEOUT'
/** A Rust/WASM scaler failed (e.g. OOM on a huge image). */
 | 'WASM_SCALER_FAILED'
/** Neural inference failed and could not be recovered by fallback. */
 | 'INFERENCE_FAILED'
/** The input could not be decoded into pixels in the worker. */
 | 'DECODE_FAILED'
/** The result could not be encoded into a Blob in the worker. */
 | 'ENCODE_FAILED'
/** The Web Worker crashed (uncaught error, message serialization). */
 | 'WORKER_FAILED'
/** Another operation is already running; the engine processes serially. */
 | 'BUSY'
/** destroy() was called; the engine instance can no longer be used. */
 | 'DESTROYED';
interface UpscalerErrorOptions {
    /**
     * true when the consumer may retry (possibly after fixing input or calling
     * loadModel()). Defaults to false (terminal failure).
     */
    recoverable?: boolean;
    cause?: unknown;
}
declare class UpscalerError extends Error {
    readonly code: UpscalerErrorCode;
    readonly recoverable: boolean;
    /**
     * true when the error was already emitted on the engine's `error` event
     * (worker → WorkerController → event). The engine uses this to emit every
     * failure exactly once while still rejecting the operation's promise.
     */
    forwarded: boolean;
    constructor(code: UpscalerErrorCode, message: string, options?: UpscalerErrorOptions);
}

/**
 * Model lifecycle for the upscaler engine: cache-first fetching of the
 * Real-ESRGAN ONNX file, onnxruntime-web runtime configuration, session
 * creation per device capabilities, and WebGPU→WASM fallback recovery.
 *
 * This module runs INSIDE the engine worker (it creates ORT sessions, which
 * must live in the same context that runs inference).
 */

type Quantization = 'fp32' | 'fp16' | 'int8';

/**
 * Spawns and controls the engine's Web Worker. Runs on the MAIN THREAD only.
 *
 * The worker is referenced as the COMPILED `./worker.js` next to this bundle
 * (`src/worker.ts` is a separate tsup entry producing `dist/worker.js`), so
 * no in-browser TypeScript compilation is ever needed.
 *
 * Protocol: one operation at a time (`load-model` or `process`), each with a
 * configurable timeout. Every request carries an id; the worker answers with
 * progress/fallback events, then exactly one terminal `ready`/`done`/`error`.
 * Image bytes cross the boundary as zero-copy transferables.
 */

/** The processing methods the engine supports. */
type Method = 'lanczos' | 'bicubic' | 'neural';

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

interface UpscalerEngineConfig {
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
interface ProcessOptions {
    method: Method;
    scale: 2 | 4;
    format?: 'image/png' | 'image/webp';
    quality?: number;
}
declare class UpscalerEngine {
    #private;
    constructor(config?: UpscalerEngineConfig);
    /**
     * Subscribes to a typed engine event. Returns an unsubscribe function.
     * Events: `model_download`, `tile_processing`, `fallback`, `complete`,
     * `error` — see the README for exact payload shapes.
     */
    on<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): () => void;
    /** Removes a previously subscribed handler. */
    off<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): void;
    /**
     * Probes (and memoizes) hardware capabilities: WebGPU adapter presence
     * (honest `requestAdapter()` probe), WASM availability, WASM threading
     * (cross-origin isolation), and the conservative lowVram hint.
     */
    detectDevice(): Promise<Capabilities>;
    /**
     * Downloads (cache-first) the neural model and creates the ORT session.
     * Consumer-triggered ONLY — call this after the user has consented to the
     * download (Two-Gate flow). Emits `model_download` progress while
     * streaming; emits nothing when the model is already cached.
     */
    loadModel(): Promise<void>;
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
    process(buffer: ArrayBuffer, options: ProcessOptions): Promise<Blob>;
    /**
     * Tears the engine down: terminates the worker (which frees the ORT
     * session and all WASM memory — they lived in the worker's heap), rejects
     * any in-flight operation, and clears every listener. The instance is
     * unusable afterwards.
     */
    destroy(): void;
}

export { type Capabilities, DeviceRouter, EventEmitter, type Method, type ProcessOptions, type Quantization, UpscalerEngine, type UpscalerEngineConfig, UpscalerError, type UpscalerErrorCode, type UpscalerEvent, type UpscalerEventListener, type UpscalerEventType };
