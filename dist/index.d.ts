import * as ort from 'onnxruntime-web/webgpu';

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
 *
 * v0.3.0 (incident-driven additions, all additive/optional):
 *  - The compute probe requests `powerPreference: 'high-performance'` by
 *    default — this is a compute workload; the default adapter policy may
 *    otherwise pick an iGPU and run 10-50x slower (the v0.2.0 incident).
 *  - Dual-GPU detection via the ONLY enumeration technique stable WebGPU
 *    offers: a second probe with the OPPOSITE powerPreference, comparing
 *    adapter info. Same adapter (or any probe failure) ⇒ single GPU. We do
 *    not pretend full enumeration exists.
 *  - Software-GPU detection (SwiftShader/LAVAPIPE/llvmpipe/…) from adapter
 *    info — a software adapter must not silently masquerade as a GPU path.
 *  - A HONESTLY-LABELED gpu tier heuristic; the raw adapter info string is
 *    always available beside it (`adapterInfo`), never replaced by it.
 */
/** Summary of a WebGPU adapter's identity (raw data, shown beside heuristics). */
interface AdapterInfoSummary {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
}
/** Coarse compute-performance tier. HEURISTIC — see `classifyGpuTier`. */
type GpuTier = 'software' | 'entry' | 'mid' | 'high';
/** Adapter preference for the compute probe. Default 'high-performance'. */
type GpuPreference = 'high-performance' | 'low-power' | 'default';
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
    /** Raw adapter info of the preferred (compute) adapter, when probed. */
    adapterInfo?: AdapterInfoSummary | null;
    /** True when the two-preference probes returned two DIFFERENT adapters. */
    dualGpu?: boolean;
    /** Raw adapter info of the opposite-preference adapter, when different. */
    secondaryAdapterInfo?: AdapterInfoSummary | null;
    /** The preferred adapter identifies itself as a software rasterizer. */
    softwareGpu?: boolean;
    /** HEURISTIC tier — always shown alongside the raw `adapterInfo`. */
    gpuTier?: GpuTier;
}
interface GPUAdapterInfoLike {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
}
interface MinimalGPUAdapter {
    info?: GPUAdapterInfoLike;
    limits?: {
        maxTextureDimension2D?: number;
        maxBufferSize?: number;
    };
    requestAdapterInfo?: () => Promise<GPUAdapterInfoLike>;
}
/**
 * Reads adapter identity: `adapter.info` is a sync property on current
 * Chrome; `requestAdapterInfo()` is the legacy async fallback. Returns null
 * when neither exists (nothing is invented).
 */
declare function readAdapterInfo(adapter: MinimalGPUAdapter): Promise<AdapterInfoSummary | null>;
/** Stable comparison key for "did two probes return the same adapter". */
declare function adapterInfoKey(info: AdapterInfoSummary | null): string;
/**
 * Software-rasterizer detection from raw adapter info. Pure; exported for
 * tests. Matching is deliberately on the JOINED info string — vendors put
 * the tell-tale in different fields (description vs architecture).
 */
declare function isSoftwareGpuInfo(info: AdapterInfoSummary | null | undefined): boolean;
/** Advisory neural input ceiling (megapixels) per tier. Heuristic, surfaced via getDiagnostics(). */
declare const TIER_NEURAL_MEGAPIXELS: Readonly<Record<GpuTier, number>>;
interface GpuTierInput {
    info: AdapterInfoSummary | null;
    softwareGpu: boolean;
    /** navigator.deviceMemory (GiB), Chromium-only — undefined elsewhere. */
    deviceMemory?: number;
    limits?: {
        maxTextureDimension2D?: number;
        maxBufferSize?: number;
    };
}
/**
 * Tier heuristic — LABELED AS SUCH everywhere it surfaces; the raw adapter
 * string is always available beside it. Inputs: the software flag, iGPU /
 * dGPU name patterns, deviceMemory, adapter limits. Unknown ⇒ 'entry'
 * (conservative: smaller tiles, lower concurrency). Pure; exported for tests.
 */
declare function classifyGpuTier(input: GpuTierInput): GpuTier;
declare class DeviceRouter {
    #private;
    /**
     * Probes (once per preference, then memoizes) the device capabilities.
     * Concurrent calls for the same preference share a single probe.
     * Default preference 'high-performance': a compute engine wants the dGPU.
     */
    getCapabilities(preference?: GpuPreference): Promise<Capabilities>;
    /** Previously memoized capabilities for a preference, if probed already. */
    get cached(): Capabilities | null;
    cachedFor(preference: GpuPreference): Capabilities | null;
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
    /**
     * Zero-based index of the tile this event reports. v0.3.0: neural events
     * fire when a tile COMPLETES (so duration/ETA refer to it); classical
     * methods fire once, on their single completion step.
     */
    tileIndex: number;
    totalTiles: number;
    /**
     * v0.3.0, additive optional: duration of the tile just completed (ms).
     * The first tile's duration includes model warmup — expected.
     */
    tileDurationMs?: number;
    /**
     * v0.3.0, additive optional: running-average estimate for the remaining
     * tiles (average completed duration × remaining ÷ concurrency), in ms.
     */
    etaMs?: number;
};
type FallbackEvent = {
    type: 'fallback';
    from: 'webgpu';
    to: 'wasm';
    reason: string;
    /**
     * v0.3.0, additive optional: which file the retrying session uses — the
     * catalog's wasm variant, or the same file when no variant exists.
     */
    swappedTo?: 'wasm-variant' | 'same-file';
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
/** loadModel() called without a configured modelUrl/models catalog. */
'MODEL_URL_REQUIRED'
/** The models catalog lacks the variant the probed hardware requires. */
 | 'MODEL_VARIANT_MISSING'
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
 * Capability-aware model selection — the engine's half of the ownership
 * split documented in the README:
 *
 *   JOB (photo vs anime)  → consumer decision. Never inferred here.
 *   SCALE (2×/4×)         → consumer option; the engine executes it.
 *   PRECISION (fp16/fp32/int8) → ENGINE capability decision, made from the
 *   real probed hardware via the consumer-supplied catalog.
 *
 * Pure and side-effect free so it can be unit-tested without a worker and
 * reused by consumers (e.g. to show which variant a consent dialog would
 * fetch BEFORE asking for consent).
 *
 * v0.3.0: a software GPU adapter (SwiftShader & friends — detected in
 * DeviceRouter) routes to the wasm variant when the catalog has one: the
 * software "WebGPU" EP is a CPU rasterizer in disguise and 10-50x slower
 * than the native WASM path (the v0.2.0 incident). Without a wasm variant
 * it PROCEEDS on the software adapter — honesty via the reported reason and
 * badge, not gating. A real iGPU-only device also proceeds (badge, not gate).
 */

/**
 * Consumer-supplied catalog of precision variants. URLs are used verbatim —
 * no filename synthesis, no default hosts.
 */
interface ModelCatalog {
    /** Variant for the WebGPU execution provider (typically fp16). */
    webgpu?: string;
    /** Variant for the CPU/WASM execution provider (typically fp32 or int8). */
    wasm?: string;
}
interface ModelSelection {
    variant: 'webgpu' | 'wasm';
    url: string;
    /** URL of the fallback variant for a mid-flight WebGPU→WASM swap, if any. */
    wasmFallbackUrl?: string;
    /**
     * Why this variant was chosen, when the choice is non-obvious (software
     * GPU routing, dual-GPU note). Undefined for unremarkable selections.
     * Additive optional field — surfaced on LoadModelResult and diagnostics.
     */
    reason?: string;
}
/**
 * Selects the variant to load:
 *  1. `webgpu && catalog.webgpu && !softwareGpu` → the webgpu variant.
 *  2. `webgpu && catalog.webgpu && softwareGpu` → wasm variant when the
 *     catalog has one (reason recorded); otherwise webgpu on the software
 *     adapter (reason records the degraded path).
 *  3. otherwise → `catalog.wasm`; missing ⇒ typed `MODEL_VARIANT_MISSING`
 *     error naming exactly what is absent.
 */
declare function selectModelVariant(catalog: ModelCatalog, capabilities: Pick<Capabilities, 'webgpu'> & {
    softwareGpu?: boolean;
    dualGpu?: boolean;
}): ModelSelection;

/**
 * Model lifecycle for the upscaler engine: cache-first fetching, ORT session
 * creation per device capabilities, WebGPU→WASM fallback (with catalog
 * variant swap), and export-true tensor marshaling.
 *
 * Selection model (documented ownership split — see README):
 *  - JOB (photo vs anime) and SCALE are CONSUMER decisions. The engine never
 *    selects by content and never auto-discovers model URLs.
 *  - PRECISION is an ENGINE capability decision, made from real probed
 *    hardware via the consumer-supplied catalog (`models.webgpu` / `models.wasm`).
 *
 * v0.3.0 single-EP session guarantee: a session is created with EXACTLY ONE
 * execution provider — the capability-chosen one. Never
 * `['webgpu', 'wasm']`: ONNX Runtime may silently substitute the fallback EP
 * behind a successful WebGPU promise, which is how a "webgpu" session can
 * run at WASM speed undetected (the v0.2.0 incident: ~75 s/tile). With one
 * EP requested, init failure throws into OUR explicit fallback path
 * (dispose → wasm variant if cataloged → recreate → retry → `fallback`
 * event), and `requestedEp`/`actualEp` are recorded truth, never guessed.
 */

type Quantization = 'fp32' | 'fp16' | 'int8';
/**
 * What `loadModel()` reports. Callers that ignore it are unaffected.
 *  - variant: which execution-provider family the loaded session targets.
 *  - url: the exact model URL that was selected from the catalog.
 *  - cached: true when served from the Cache API (no network was used).
 *  - reason (v0.3.0, optional): why this variant was chosen, when the
 *    choice is non-obvious (software-GPU routing, dual-GPU note).
 */
interface LoadModelResult {
    variant: 'webgpu' | 'wasm';
    url: string;
    cached: boolean;
    reason?: string;
}
/** Progress/fallback notifications relayed out of the worker by `worker.ts`. */
interface ModelManagerNotifications {
    /** Download progress in [0, 1]. Not called on cache hits. */
    onDownloadProgress(progress: number): void;
    /**
     * WebGPU → WASM fallback (session creation or inference failure).
     * `swappedTo` reports which file the new session uses.
     */
    onFallback(reason: string, swappedTo: 'wasm-variant' | 'same-file'): void;
}
/** Test seam: the ORT session factory (defaults to the real onnxruntime-web). */
type SessionFactory = (bytes: ArrayBuffer, executionProviders: readonly string[]) => Promise<ort.InferenceSession>;
/** Test seam: cache-first byte acquisition (defaults to the real Cache API path). */
type ByteAcquirer = (modelUrl: string) => Promise<ArrayBuffer>;
/**
 * The tensor conversion contract for Real-ESRGAN-family exports:
 *  - input: RGBA → RGB strip → CHW f32, normalized per the export's dtype.
 *  - output: CHW f32 → RGB → RGBA, clamped to [0,255], original alpha restored.
 * The conversion never fabricates color data: RGB channels ride an opaque
 * backing through the model and alpha is re-attached verbatim afterwards.
 */
declare class ModelManager {
    #private;
    constructor(notifications: ModelManagerNotifications, sessionFactory?: SessionFactory, byteAcquirer?: ByteAcquirer);
    /** Input tensor name, read from the live session — never hardcoded. */
    get inputName(): string;
    get outputName(): string;
    get isLoaded(): boolean;
    /** Which execution-provider family the current session targets. */
    get activeVariant(): 'webgpu' | 'wasm' | null;
    /** EP the capability decision asked for (null before any load attempt). */
    get requestedEp(): 'webgpu' | 'wasm' | null;
    /** EP the successful session was actually created with. */
    get actualEp(): 'webgpu' | 'wasm' | null;
    /**
     * Loads (cache-first) the model and creates an ORT session.
     *
     * Catalog path: `capabilities.webgpu && models.webgpu` selects the WebGPU
     * variant — EXCEPT on a software GPU adapter, which routes to
     * `models.wasm` when present (reason recorded). A missing variant throws
     * `MODEL_VARIANT_MISSING` naming exactly what is absent.
     * Simple path (`models` omitted): `modelUrl` for every EP — today's
     * behavior, unchanged.
     */
    loadModel(options: {
        modelUrl?: string;
        models?: {
            webgpu?: string;
            wasm?: string;
        };
        capabilities: Capabilities;
        ortWasmPaths?: string;
        forceReload?: boolean;
    }): Promise<LoadModelResult & {
        requestedEp: 'webgpu' | 'wasm';
        actualEp: 'webgpu' | 'wasm';
    }>;
    /**
     * Runs one inference. If the WebGPU EP fails mid-run (OOM, context loss,
     * device loss): dispose the session, recreate it on the WASM EP — with the
     * catalog's wasm variant when one exists (fetched through the same
     * cache-first path) — retry once, and emit the existing `fallback` event.
     * Only when no alternate variant exists does fallback reuse the same file,
     * and that failure surfaces honestly.
     */
    run(image: ImageData): Promise<ImageData>;
    /** Disposes the session and releases retained model bytes. */
    dispose(): void;
}

/**
 * Timeout semantics for one in-flight worker operation (v0.3.0 incident fix).
 *
 * v0.2.0 used an ABSOLUTE wall-clock timer: a healthy but slow job (4/25
 * tiles at ~75 s/tile on an iGPU) was killed mid-progress at 300 s. v0.3.0
 * changes the semantics:
 *
 *  - `idleMs` (the engine's `timeout` config) is an INACTIVITY timeout. Any
 *    worker message for the operation (tile progress, download progress,
 *    fallback, heartbeat) resets it. A silent worker dies exactly as before
 *    (same TIMEOUT error shape); a PROGRESSING worker is never killed by it.
 *  - `hardMs` (optional `hardTimeoutMs` config, default disabled) is an
 *    absolute cap that overrides idle logic — for consumers who want a
 *    guaranteed upper bound regardless of progress.
 */
type TimeoutExpireReason = 'idle' | 'hard';
interface TimeoutGovernorOptions {
    idleMs: number;
    /** Absolute cap; undefined/0/NaN disables it. */
    hardMs?: number;
    onExpire(reason: TimeoutExpireReason): void;
}
/**
 * Pure timer policy — no worker coupling, so it is unit-testable. One
 * instance per in-flight operation. Not re-startable: create a new one.
 */
declare class TimeoutGovernor {
    #private;
    constructor(options: TimeoutGovernorOptions);
    /** Arms both timers. */
    start(): void;
    /** Worker activity: resets ONLY the idle timer. Never fires twice. */
    poke(): void;
    /** Disarms everything (operation settled or worker killed for other reasons). */
    stop(): void;
    /** Which limit fired, if any ('idle' | 'hard' | null). */
    get expiredWith(): TimeoutExpireReason | null;
}

/**
 * Spawns and controls the engine's Web Worker. Runs on the MAIN THREAD only.
 *
 * The worker is referenced as the COMPILED `./worker.js` next to this bundle
 * (`src/worker.ts` is a separate tsup entry producing `dist/worker.js`), so
 * no in-browser TypeScript compilation is ever needed.
 *
 * Protocol: one operation at a time (`load-model` or `process`), each with
 * v0.3.0 timeout semantics — an INACTIVITY timeout reset by every worker
 * message (progress/fallback/heartbeat) for the operation, plus an optional
 * absolute `hardTimeoutMs` cap. A progressing worker is never killed by the
 * idle limit; a silent worker dies with the same TIMEOUT error as before.
 * Every request carries an id; the worker answers with
 * progress/fallback/heartbeat events, then exactly one terminal
 * `ready`/`done`/`error`. Image bytes cross the boundary as zero-copy
 * transferables.
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

interface UpscalerEngineConfig {
    /** Simple path: one model URL for every execution provider. */
    modelUrl?: string;
    /**
     * Catalog path (takes precedence over `modelUrl` when both are given):
     * capability-aware model selection. PRECISION is an engine decision made
     * from probed hardware; JOB and SCALE remain consumer decisions. At least
     * a `wasm` variant is required for any environment without WebGPU.
     */
    models?: {
        webgpu?: string;
        wasm?: string;
    };
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
interface ProcessOptions {
    method: Method;
    scale: 2 | 4;
    format?: 'image/png' | 'image/webp';
    quality?: number;
}
/** Synchronous truth snapshot — see {@link UpscalerEngine.getDiagnostics}. */
interface EngineDiagnostics {
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
     * Probes (and memoizes, per preference) hardware capabilities: WebGPU
     * adapter presence (honest `requestAdapter()` probe with the configured
     * `gpuPreference`), WASM availability, WASM threading (cross-origin
     * isolation), the conservative lowVram hint, and the v0.3.0 additive
     * fields (adapterInfo, dualGpu, softwareGpu, gpuTier).
     *
     * An explicit `preference` overrides the configured one for this call
     * (used by GPU pickers); results are cached per preference.
     */
    detectDevice(preference?: GpuPreference): Promise<Capabilities>;
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
    loadModel(preference?: GpuPreference): Promise<LoadModelResult>;
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
    process(buffer: ArrayBuffer, options: ProcessOptions): Promise<Blob>;
    /**
     * Synchronous truth snapshot: what hardware was probed, which variant was
     * chosen and why, which EP was requested vs actually created (the
     * single-EP guarantee makes `actualEp` recorded fact, not a guess), the
     * raw adapter info beside the tier heuristic, and the last tile duration.
     */
    getDiagnostics(): EngineDiagnostics;
    /**
     * Tears the engine down: terminates the worker (which frees the ORT
     * session and all WASM memory — they lived in the worker's heap), rejects
     * any in-flight operation, and clears every listener. The instance is
     * unusable afterwards.
     */
    destroy(): void;
}

/**
 * Tiling, overlap, feathered blending and bounded concurrency for neural
 * (Real-ESRGAN) processing. Runs INSIDE the engine worker.
 *
 * Tiling scheme
 * -------------
 * Tiles are `tile × tile` sampled with `overlap` px of extra context on
 * every interior side, so the model sees real content beyond each seam. The
 * context is what prevents seams; the blend is what hides the transition:
 *
 *  - Each tile's output covers its full rect (core + margins), scaled.
 *  - Margins on image borders have weight 1 (no neighbor to blend with).
 *  - Interior margins carry a linear feather ramp 0→1 across the overlap.
 *  - A pixel written for the first time is written at full weight; a pixel
 *    already written by an earlier tile is cross-faded: `new*w + old*(1-w)`.
 *    Because every interior margin is also covered by the neighboring tile's
 *    rect, the two contributions always cross-fade regardless of completion
 *    order, and the result is seamless.
 *
 * This keeps extra memory at O(output/8) (a written-bitset) instead of
 * O(output × float) for a sum/weight accumulator.
 *
 * v0.3.0: tile size / overlap / concurrency follow the HONESTLY-LABELED gpu
 * tier heuristic (`gpuTier` in Capabilities) — see `tilePolicyFor`. Per-tile
 * DURATION and a running ETA are reported on tile COMPLETION (additive
 * optional fields on the existing `tile_processing` event; the first tile's
 * duration includes model warmup — expected and documented).
 */

/** Default context pixels sampled beyond each interior tile edge (source px). */
declare const TILE_OVERLAP = 16;
/** Larger context budget for 'high'-tier adapters. */
declare const HIGH_TIER_OVERLAP = 24;
/**
 * Per-tile telemetry relayed out of the worker. Fired on tile COMPLETION:
 * `tileDurationMs` is the duration of the tile just completed (first tile
 * includes warmup), `etaMs` the running-average estimate for the rest.
 */
interface TileProgressInfo {
    tileIndex: number;
    totalTiles: number;
    tileDurationMs?: number;
    etaMs?: number;
}
/** Compute policy for one neural run, derived from the gpu tier heuristic. */
interface TilePolicy {
    tileSize: number;
    overlap: number;
    concurrency: number;
}
/**
 * Tier-driven tile policy (HEURISTIC — inputs are labeled in Capabilities):
 *   software/entry → 256 px, concurrency 2 (conservative)
 *   mid            → 512 px, concurrency 4
 *   high           → 512 px, concurrency 4, larger overlap budget
 * `lowVram` still overrides downward (256 px / 2 / default overlap). On the
 * WASM EP the tier concurrency is additionally clamped by hardware threads.
 * Unknown tier ⇒ 'entry' (conservative). Pure; exported for tests.
 */
declare function tilePolicyFor(capabilities: Pick<Capabilities, 'lowVram' | 'gpuTier' | 'webgpu'>, hardwareConcurrency?: number): TilePolicy;

export { type AdapterInfoSummary, type Capabilities, DeviceRouter, type EngineDiagnostics, EventEmitter, type GpuPreference, type GpuTier, HIGH_TIER_OVERLAP, type LoadModelResult, type Method, type ModelCatalog, ModelManager, type ProcessOptions, type Quantization, type SessionFactory, TIER_NEURAL_MEGAPIXELS, TILE_OVERLAP, type TilePolicy, type TileProgressInfo, type TimeoutExpireReason, TimeoutGovernor, UpscalerEngine, type UpscalerEngineConfig, UpscalerError, type UpscalerErrorCode, type UpscalerEvent, type UpscalerEventListener, type UpscalerEventType, adapterInfoKey, classifyGpuTier, isSoftwareGpuInfo, readAdapterInfo, selectModelVariant, tilePolicyFor };
