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

import * as ort from 'onnxruntime-web/webgpu';

import type { Capabilities } from './DeviceRouter.js';
import { UpscalerError } from './errors.js';
import { selectModelVariant } from './ModelSelection.js';

export type { ModelCatalog } from './ModelSelection.js';
export type Quantization = 'fp32' | 'fp16' | 'int8';

/**
 * What `loadModel()` reports. Callers that ignore it are unaffected.
 *  - variant: which execution-provider family the loaded session targets.
 *  - url: the exact model URL that was selected from the catalog.
 *  - cached: true when served from the Cache API (no network was used).
 *  - reason (v0.3.0, optional): why this variant was chosen, when the
 *    choice is non-obvious (software-GPU routing, dual-GPU note).
 */
export interface LoadModelResult {
  variant: 'webgpu' | 'wasm';
  url: string;
  cached: boolean;
  reason?: string;
}

/** Progress/fallback notifications relayed out of the worker by `worker.ts`. */
export interface ModelManagerNotifications {
  /** Download progress in [0, 1]. Not called on cache hits. */
  onDownloadProgress(progress: number): void;
  /**
   * WebGPU → WASM fallback (session creation or inference failure).
   * `swappedTo` reports which file the new session uses.
   */
  onFallback(reason: string, swappedTo: 'wasm-variant' | 'same-file'): void;
}

/**
 * Default location of ORT's OWN .wasm/.mjs artifacts. These are ONNX
 * Runtime's files — completely separate from the engine's Rust scalers in
 * `dist/wasm/`. Never conflate the two file families.
 */
export const DEFAULT_ORT_WASM_PATHS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';

const CACHE_NAME = 'upscaler-models';
/** Upper bound for a worker thread pool inside ORT, matching the tile cap. */
const MAX_WASM_THREADS = 8;

/** Test seam: the ORT session factory (defaults to the real onnxruntime-web). */
export type SessionFactory = (bytes: ArrayBuffer, executionProviders: readonly string[]) => Promise<ort.InferenceSession>;
/** Test seam: cache-first byte acquisition (defaults to the real Cache API path). */
export type ByteAcquirer = (modelUrl: string) => Promise<ArrayBuffer>;

// ——— IEEE-754 binary16 conversion (round-half-to-even) ————————————————
// float16 exports carry Uint16Array BIT data; ORT does not convert Float32
// feeds silently, so the engine converts both directions explicitly.

function f32ToF16Bits(value: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0]!;

  const sign = (x >>> 16) & 0x8000;
  const absBits = x & 0x7fff_ffff;

  // NaN (canonical quiet) / Infinity.
  if (absBits > 0x7f80_0000) return sign | 0x7e00;
  if (absBits === 0x7f80_0000) return sign | 0x7c00;

  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const frac = x & 0x007f_ffff;

  if (exp >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (exp > 0) {
    const roundBit = (frac >>> 12) & 1;
    const tail = frac & 0x0fff;
    let half = sign | (exp << 10) | (frac >>> 13);
    if (roundBit === 1 && (tail !== 0 || (half & 1) === 1)) half += 1;
    return half;
  }
  // Subnormal range (or underflow to zero): keep 10 mantissa bits.
  const shift = 14 - exp; // in [15, 24+] for exp in [-1, -10...]
  if (shift > 24) return sign; // rounds to zero
  const mant = frac | 0x0080_0000; // restore implicit leading 1
  const kept = mant >>> shift;
  const roundBit = (mant >>> (shift - 1)) & 1;
  const tail = mant & ((1 << (shift - 1)) - 1);
  const half = sign | kept; // a rounding carry may flow into the exponent — correct
  if (roundBit === 1 && (tail !== 0 || (kept & 1) === 1)) return half + 1;
  return half;
}

function f16BitsToF32(bits: number): number {
  const sign = (bits & 0x8000) << 16;
  const exp = (bits >>> 10) & 0x1f;
  const frac = bits & 0x03ff;

  const u32 = new Uint32Array(1);
  if (exp === 0) {
    if (frac === 0) {
      u32[0] = sign;
    } else {
      // Subnormal: normalize the implicit leading 1.
      let e = 0;
      let f = frac;
      while ((f & 0x0400) === 0) {
        f <<= 1;
        e++;
      }
      u32[0] = sign | ((127 - 15 - e) << 23) | ((f & 0x03ff) << 13);
    }
  } else if (exp === 0x1f) {
    u32[0] = sign | 0x7f80_0000 | (frac << 13);
  } else {
    u32[0] = sign | ((exp - 15 + 127) << 23) | (frac << 13);
  }
  return new Float32Array(u32.buffer)[0]!;
}

/**
 * The tensor conversion contract for Real-ESRGAN-family exports:
 *  - input: RGBA → RGB strip → CHW f32, normalized per the export's dtype.
 *  - output: CHW f32 → RGB → RGBA, clamped to [0,255], original alpha restored.
 * The conversion never fabricates color data: RGB channels ride an opaque
 * backing through the model and alpha is re-attached verbatim afterwards.
 */
export class ModelManager {
  readonly #notifications: ModelManagerNotifications;
  readonly #sessionFactory: SessionFactory | undefined;
  readonly #byteAcquirer: ByteAcquirer | undefined;

  #session: ort.InferenceSession | null = null;
  #activeEP: 'webgpu' | 'wasm' | null = null;
  /** EP the capability decision ASKED for (single-EP guarantee ⇒ = actual on success). */
  #requestedEP: 'webgpu' | 'wasm' | null = null;
  /** EP the successful session was created with — recorded truth, never guessed. */
  #actualEP: 'webgpu' | 'wasm' | null = null;
  #activeUrl: string | null = null;
  /** WebGPU-precision file kept hot so the fallback can swap variants. */
  #webgpuBytes: ArrayBuffer | null = null;
  #wasmBytes: ArrayBuffer | null = null;
  #loadedKey: string | null = null;
  #envConfigured = false;
  #ortWasmPaths: string | undefined = undefined;
  #lastCached = false;

  constructor(notifications: ModelManagerNotifications, sessionFactory?: SessionFactory, byteAcquirer?: ByteAcquirer) {
    this.#notifications = notifications;
    this.#sessionFactory = sessionFactory;
    this.#byteAcquirer = byteAcquirer;
  }

  /** Input tensor name, read from the live session — never hardcoded. */
  get inputName(): string {
    return this.#session?.inputNames[0] ?? '';
  }

  get outputName(): string {
    return this.#session?.outputNames[0] ?? '';
  }

  get isLoaded(): boolean {
    return this.#session !== null;
  }

  /** Which execution-provider family the current session targets. */
  get activeVariant(): 'webgpu' | 'wasm' | null {
    return this.#activeEP;
  }

  /** EP the capability decision asked for (null before any load attempt). */
  get requestedEp(): 'webgpu' | 'wasm' | null {
    return this.#requestedEP;
  }

  /** EP the successful session was actually created with. */
  get actualEp(): 'webgpu' | 'wasm' | null {
    return this.#actualEP;
  }

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
  async loadModel(options: {
    modelUrl?: string;
    models?: { webgpu?: string; wasm?: string };
    capabilities: Capabilities;
    ortWasmPaths?: string;
    forceReload?: boolean;
  }): Promise<LoadModelResult & { requestedEp: 'webgpu' | 'wasm'; actualEp: 'webgpu' | 'wasm' }> {
    const { modelUrl, models, capabilities } = options;

    // ——— Selection (capability decision from a consumer-supplied catalog) ——
    let selectedUrl: string;
    let reason: string | undefined;
    /** EP implied by the selection — a software-GPU-routed wasm variant runs on the WASM EP, not the software WebGPU adapter. */
    let selectionEp: 'webgpu' | 'wasm' | null = null;
    if (models) {
      // Throws MODEL_VARIANT_MISSING (typed, names what's missing) when the
      // catalog cannot serve the probed hardware.
      const selection = selectModelVariant(models, capabilities);
      selectedUrl = selection.url;
      reason = selection.reason;
      selectionEp = selection.variant;
      this.#wasmFallbackUrl = selection.wasmFallbackUrl;
    } else if (modelUrl) {
      // Simple path: one file for every EP. Fallback reuses the same file —
      // the consumer's informed choice (may legitimately fail for fp16).
      selectedUrl = modelUrl;
      reason = undefined;
      this.#wasmFallbackUrl = undefined;
    } else {
      throw new UpscalerError(
        'MODEL_URL_REQUIRED',
        'loadModel() requires either a modelUrl or a models catalog ({ webgpu?, wasm? }) in the engine config. The engine never downloads a model without the consumer explicitly configuring and calling loadModel() (Two-Gate flow).',
        { recoverable: true },
      );
    }

    const key = selectedUrl;
    if (!options.forceReload && this.#session && this.#loadedKey === key) {
      return {
        variant: this.#activeEP!,
        url: this.#activeUrl!,
        cached: this.#lastCached,
        ...(reason !== undefined ? { reason } : {}),
        requestedEp: this.#requestedEP!,
        actualEp: this.#actualEP!,
      };
    }

    this.#configureOrtEnv(capabilities, options.ortWasmPaths);

    const primaryBytes = await this.#getBytes(selectedUrl);

    // Drop any previous session BEFORE creating the new one so the old
    // graph's memory is released while we still hold the new bytes.
    this.#disposeSession();

    // ——— Single-EP session creation with OUR explicit fallback path ——————
    // The capability-chosen EP is requested alone; if IT fails to create a
    // session, we dispose, (optionally swap to the catalog's wasm variant),
    // recreate on the WASM EP and emit the existing `fallback` event. ORT is
    // never handed a two-EP list it could silently substitute.
    // Catalog path: the EP follows the SELECTION (a software-GPU-routed wasm
    // variant runs on the WASM EP — the software WebGPU adapter is exactly
    // what routing avoids). Simple path: probed hardware decides.
    const requestedEp: 'webgpu' | 'wasm' = selectionEp ?? (capabilities.webgpu ? 'webgpu' : 'wasm');
    this.#requestedEP = requestedEp;
    try {
      await this.#createSession(primaryBytes, selectedUrl, requestedEp);
    } catch (err) {
      if (requestedEp !== 'webgpu') {
        throw err; // WASM was the choice; there is nothing to fall back to.
      }
      const reasonText = err instanceof Error ? err.message : String(err);
      // Fallback target FIRST, then emit the event so it always reports what
      // the retrying session actually uses. Always acquire through the
      // cache-first path — #wasmBytes may hold a PREVIOUS model's bytes.
      let retryBytes: ArrayBuffer;
      let swappedTo: 'wasm-variant' | 'same-file';
      if (this.#wasmFallbackUrl) {
        retryBytes = await this.#getBytes(this.#wasmFallbackUrl);
        this.#wasmBytes = retryBytes;
        this.#activeUrl = this.#wasmFallbackUrl;
        swappedTo = 'wasm-variant';
      } else {
        retryBytes = primaryBytes;
        swappedTo = 'same-file';
      }
      this.#notifications.onFallback(`WebGPU session creation failed: ${reasonText}`, swappedTo);
      await this.#createSession(retryBytes, this.#activeUrl ?? selectedUrl, 'wasm');
    }
    this.#loadedKey = key;

    // Track which file a mid-flight WebGPU→WASM fallback should use. Always
    // keyed to THIS load — never retain a previous model's bytes.
    if (this.#actualEP === 'webgpu') {
      this.#webgpuBytes = primaryBytes;
      this.#wasmBytes = null; // wasm-variant bytes are fetched lazily via the cache-first path
    } else {
      this.#webgpuBytes = null;
      this.#wasmBytes = primaryBytes;
    }

    return {
      variant: this.#actualEP!,
      url: this.#activeUrl!,
      cached: this.#lastCached,
      ...(reason !== undefined ? { reason } : {}),
      requestedEp: this.#requestedEP!,
      actualEp: this.#actualEP!,
    };
  }

  /**
   * Runs one inference. If the WebGPU EP fails mid-run (OOM, context loss,
   * device loss): dispose the session, recreate it on the WASM EP — with the
   * catalog's wasm variant when one exists (fetched through the same
   * cache-first path) — retry once, and emit the existing `fallback` event.
   * Only when no alternate variant exists does fallback reuse the same file,
   * and that failure surfaces honestly.
   */
  async run(image: ImageData): Promise<ImageData> {
    this.#assertSession();

    const inputTensor = this.#marshalInput(image);
    try {
      const output = await this.#runWithSession(this.#session!, inputTensor);
      return this.#unmarshalOutput(image, output);
    } catch (err) {
      if (this.#activeEP !== 'webgpu') {
        throw new UpscalerError(
          'INFERENCE_FAILED',
          `Neural inference failed (${err instanceof Error ? err.message : String(err)}).`,
          { recoverable: false, cause: err },
        );
      }

      const reason = err instanceof Error ? err.message : String(err);
      this.#disposeSession();

      // Determine the swap target FIRST, then emit the fallback event so it
      // always reports what the retrying session actually uses.
      let retryBytes: ArrayBuffer | null = null;
      let swappedTo: 'wasm-variant' | 'same-file' = 'same-file';
      if (this.#wasmFallbackUrl) {
        if (this.#wasmBytes === null) {
          retryBytes = await this.#getBytes(this.#wasmFallbackUrl);
          this.#wasmBytes = retryBytes;
        } else {
          retryBytes = this.#wasmBytes;
        }
        this.#activeUrl = this.#wasmFallbackUrl;
        swappedTo = 'wasm-variant';
      } else if (this.#webgpuBytes !== null) {
        retryBytes = this.#webgpuBytes;
      } else if (this.#wasmBytes !== null) {
        retryBytes = this.#wasmBytes;
      }

      if (retryBytes === null) {
        throw new UpscalerError(
          'INFERENCE_FAILED',
          `WebGPU inference failed and no WASM fallback bytes are available (${reason}).`,
          { recoverable: false, cause: err },
        );
      }

      this.#notifications.onFallback(reason, swappedTo);
      this.#requestedEP = 'wasm';

      await this.#createSession(retryBytes, this.#activeUrl ?? '', 'wasm');
      try {
        const output = await this.#runWithSession(this.#session!, this.#marshalInput(image));
        return this.#unmarshalOutput(image, output);
      } catch (retryErr) {
        throw new UpscalerError(
          'INFERENCE_FAILED',
          `Neural inference failed on both WebGPU and WASM (${retryErr instanceof Error ? retryErr.message : String(retryErr)}).`,
          { recoverable: false, cause: retryErr },
        );
      }
    }
  }

  /** Disposes the session and releases retained model bytes. */
  dispose(): void {
    this.#disposeSession();
    this.#webgpuBytes = null;
    this.#wasmBytes = null;
    this.#loadedKey = null;
    this.#activeUrl = null;
  }

  // ——— Internals ————————————————————————————————————————————————————

  /** Distinct wasm-precision variant URL for a mid-flight swap, if any. */
  #wasmFallbackUrl: string | undefined = undefined;

  /** Byte acquisition: the injected test seam or the real cache-first path. */
  #getBytes(modelUrl: string): Promise<ArrayBuffer> {
    return this.#byteAcquirer ? this.#byteAcquirer(modelUrl) : this.#acquireModelBytes(modelUrl);
  }

  async #runWithSession(session: ort.InferenceSession, input: ort.Tensor): Promise<ort.Tensor> {
    try {
      const feeds: Record<string, ort.Tensor> = { [session.inputNames[0] ?? 'x']: input };
      const results = await session.run(feeds);
      const outName = session.outputNames[0] ?? '';
      const output = results[outName];
      if (!output) {
        throw new Error(`model produced no output named "${outName}"`);
      }
      return output;
    } finally {
      input.dispose();
    }
  }

  #assertSession(): void {
    if (!this.#session) {
      throw new UpscalerError(
        'MODEL_NOT_LOADED',
        'No neural model session in the worker — loadModel() must run before neural inference.',
        { recoverable: true },
      );
    }
  }

  /**
   * onnxruntime-web runtime configuration. ALL of these matter:
   *  - wasmPaths: where ORT fetches ITS OWN .wasm/.mjs artifacts (the JSEP
   *    binary included). Distinct from our Rust scalers in dist/wasm/.
   *  - numThreads: 1 unless cross-origin isolation allows workers.
   *  - proxy: false — inference already runs inside OUR worker; ORT's
   *    internal proxy would nest workers redundantly and break here.
   *  - jsep: true when WebGPU will be used, so ORT loads the JSEP WASM
   *    binary. Without it, session creation may succeed but WebGPU
   *    inference fails at runtime. (Not part of the public typings in all
   *    ORT releases, hence the widening cast — the runtime honors it.)
   */
  #configureOrtEnv(capabilities: Capabilities, ortWasmPaths?: string): void {
    if (this.#envConfigured) {
      return;
    }
    this.#ortWasmPaths = ortWasmPaths;
    ort.env.wasm.wasmPaths = this.#ortWasmPaths ?? DEFAULT_ORT_WASM_PATHS;
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    ort.env.wasm.numThreads = capabilities.wasmThreads ? Math.min(hw, MAX_WASM_THREADS) : 1;
    ort.env.wasm.proxy = false;
    (ort.env.wasm as { jsep?: boolean }).jsep = capabilities.webgpu;
    this.#envConfigured = true;
  }

  /**
   * Cache-first model acquisition: on a Cache API hit, the bytes are served
   * locally and NO download progress is emitted (`cached: true`). On a miss,
   * the response is streamed with per-chunk progress, stored in the cache,
   * and returned.
   */
  async #acquireModelBytes(modelUrl: string): Promise<ArrayBuffer> {
    let cache: Cache | null = null;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      // Cache API unavailable (e.g. insecure context) — proceed uncached.
      cache = null;
    }

    if (cache) {
      const hit = await cache.match(modelUrl);
      if (hit) {
        this.#lastCached = true;
        return hit.arrayBuffer();
      }
    }

    let response: Response;
    try {
      response = await fetch(modelUrl, { mode: 'cors' });
    } catch (err) {
      throw new UpscalerError(
        'MODEL_DOWNLOAD_FAILED',
        `Could not fetch model from ${modelUrl} (${err instanceof Error ? err.message : String(err)}). ` +
          'The host must be CORS-enabled.',
        { recoverable: true, cause: err },
      );
    }
    if (!response.ok) {
      throw new UpscalerError(
        'MODEL_DOWNLOAD_FAILED',
        `Model download failed: HTTP ${response.status} ${response.statusText} for ${modelUrl}`,
        { recoverable: true },
      );
    }

    const total = Number(response.headers.get('Content-Length') ?? '0');
    let bytes: ArrayBuffer;
    if (!response.body) {
      bytes = await response.arrayBuffer();
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
        received += value.byteLength;
        if (total > 0) {
          this.#notifications.onDownloadProgress(Math.min(received / total, 1));
        }
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bytes = merged.buffer;
    }

    if (cache) {
      // Cache for next time; a quota failure must not fail the run.
      try {
        await cache.put(modelUrl, new Response(bytes));
      } catch (err) {
        console.warn('[upscaler] could not cache model bytes', err);
      }
    }
    this.#lastCached = false;
    return bytes;
  }

  /**
   * Creates the ORT session with EXACTLY ONE execution provider (see class
   * doc — the single-EP guarantee). The caller owns the fallback policy:
   * here a failure simply throws, so init failures surface into OUR
   * explicit fallback path in loadModel()/run() instead of ORT silently
   * substituting an EP behind a two-element list.
   */
  async #createSession(modelBytes: ArrayBuffer, url: string, ep: 'webgpu' | 'wasm'): Promise<void> {
    const create = this.#sessionFactory ?? ((bytes, providers) => ort.InferenceSession.create(bytes.slice(0), {
      executionProviders: providers as ('webgpu' | 'wasm')[],
      graphOptimizationLevel: 'all',
    }));
    this.#session = await create(modelBytes, [ep]);
    this.#activeEP = ep;
    this.#actualEP = ep;
    this.#activeUrl = url;
  }

  #disposeSession(): void {
    this.#session?.release().catch(() => undefined);
    this.#session = null;
    this.#activeEP = null;
    this.#actualEP = null;
  }

  /**
   * RGBA → CHW RGB tensor with [0,1] normalization, shaped [1,3,H,W].
   * DTYPE comes from the live session's declared input metadata: float16
   * exports receive Uint16Array BIT data (converted here, round-half-even);
   * float32 exports receive Float32Array. The input NAME comes from the
   * session too — never hardcoded (`input`, `lq`, … vary by export).
   */
  #marshalInput(image: ImageData): ort.Tensor {
    const { width, height, data } = image;
    const n = width * height;
    const meta = this.#session!.inputMetadata?.[0];
    const isF16 = meta?.isTensor === true && meta.type === 'float16';

    const planar = isF16 ? new Uint16Array(3 * n) : new Float32Array(3 * n);
    for (let px = 0; px < n; px++) {
      const i = px * 4;
      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;
      if (isF16) {
        planar[px] = f32ToF16Bits(r);
        planar[px + n] = f32ToF16Bits(g);
        planar[px + 2 * n] = f32ToF16Bits(b);
      } else {
        planar[px] = r;
        planar[px + n] = g;
        planar[px + 2 * n] = b;
      }
    }

    const inputName = this.#session!.inputNames[0] ?? 'x';
    void inputName; // consumed as the feeds key in #runWithSession
    return new ort.Tensor(isF16 ? 'float16' : 'float32', planar, [1, 3, height, width]);
  }

  /**
   * CHW model output → RGBA ImageData: clamp [0,255], restore the ORIGINAL
   * alpha channel (the model is RGB and never sees alpha). Output dtype is
   * read from the session metadata — float16 outputs carry bit data that is
   * converted back to f32 before de-normalization.
   */
  #unmarshalOutput(original: ImageData, output: ort.Tensor): ImageData {
    const dims = output.dims as readonly number[];
    const outH = dims[dims.length - 2]!;
    const outW = dims[dims.length - 1]!;
    const n = outW * outH;

    const isF16 = output.type === 'float16';
    const raw = output.data as Float32Array | Uint16Array;
    const sample = (i: number): number => (isF16 ? f16BitsToF32(raw[i] as number) : (raw[i] as number));

    const result = new Uint8ClampedArray(n * 4);
    for (let px = 0; px < n; px++) {
      const o = px * 4;
      result[o] = Math.min(Math.max(sample(px), 0), 1) * 255;
      result[o + 1] = Math.min(Math.max(sample(px + n), 0), 1) * 255;
      result[o + 2] = Math.min(Math.max(sample(px + 2 * n), 0), 1) * 255;
      const sx = Math.min(px % outW, original.width - 1);
      const sy = Math.min(Math.floor(px / outW), original.height - 1);
      result[o + 3] = original.data[(sy * original.width + sx) * 4 + 3]!;
    }
    output.dispose();
    return new ImageData(result, outW, outH);
  }
}
