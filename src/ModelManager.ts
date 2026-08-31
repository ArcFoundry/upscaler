/**
 * Model lifecycle for the upscaler engine: cache-first fetching of the
 * Real-ESRGAN ONNX file, onnxruntime-web runtime configuration, session
 * creation per device capabilities, and WebGPU→WASM fallback recovery.
 *
 * This module runs INSIDE the engine worker (it creates ORT sessions, which
 * must live in the same context that runs inference).
 */

import * as ort from 'onnxruntime-web/webgpu';

import type { Capabilities } from './DeviceRouter.js';
import { UpscalerError } from './errors.js';

export type Quantization = 'fp32' | 'fp16' | 'int8';

/** Progress/fallback notifications relayed out of the worker by `worker.ts`. */
export interface ModelManagerNotifications {
  /** Download progress in [0, 1]. Not called on cache hits. */
  onDownloadProgress(progress: number): void;
  /** WebGPU → WASM fallback (session creation or inference failure). */
  onFallback(reason: string): void;
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

export class ModelManager {
  readonly #notifications: ModelManagerNotifications;

  #session: ort.InferenceSession | null = null;
  #activeEP: 'webgpu' | 'wasm' | null = null;
  #modelBytes: ArrayBuffer | null = null;
  #loadedKey: string | null = null;
  #envConfigured = false;
  #ortWasmPaths: string | undefined = undefined;

  constructor(notifications: ModelManagerNotifications) {
    this.#notifications = notifications;
  }

  /** Names of the session's single input/output (Real-ESRGAN: NCHW RGB). */
  get inputName(): string {
    this.#assertSession();
    return this.#session!.inputNames[0] ?? '';
  }

  get outputName(): string {
    this.#assertSession();
    return this.#session!.outputNames[0] ?? '';
  }

  get isLoaded(): boolean {
    return this.#session !== null;
  }

  /**
   * Loads (cache-first) the model and creates an ORT session. Idempotent for
   * the same URL + quantization: a second call is a no-op.
   */
  async loadModel(
    modelUrl: string,
    quantization: Quantization,
    capabilities: Capabilities,
    ortWasmPaths?: string,
  ): Promise<void> {
    const key = `${quantization}:${modelUrl}`;
    if (this.#session && this.#loadedKey === key) {
      return;
    }

    this.#configureOrtEnv(capabilities, ortWasmPaths);
    const bytes = await this.#acquireModelBytes(modelUrl, quantization);
    this.#modelBytes = bytes;

    // Drop any previous session BEFORE creating the new one so the old
    // graph's memory is released while we still hold the bytes.
    this.#disposeSession();
    await this.#createSession(bytes, capabilities);
    this.#loadedKey = key;
  }

  /**
   * Runs one inference. If the WebGPU EP fails mid-run (OOM, context loss,
   * device loss), the session is disposed, recreated on the WASM EP, and the
   * SAME inference is retried once — the fallback is emitted as an event, not
   * a crash. Disposes `input`; the caller disposes the returned output tensor
   * after reading it.
   */
  async run(input: ort.Tensor): Promise<ort.Tensor> {
    this.#assertSession();
    try {
      return await this.#runWithSession(this.#session!, input);
    } catch (err) {
      if (this.#activeEP !== 'webgpu') {
        throw new UpscalerError(
          'INFERENCE_FAILED',
          `Neural inference failed (${err instanceof Error ? err.message : String(err)}).`,
          { recoverable: false, cause: err },
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.#notifications.onFallback(reason);
      this.#disposeSession();
      await this.#createSession(this.#modelBytes!, { webgpu: false } as Capabilities, 'wasm');
      try {
        return await this.#runWithSession(this.#session!, input);
      } catch (retryErr) {
        throw new UpscalerError(
          'INFERENCE_FAILED',
          `Neural inference failed on both WebGPU and WASM (${retryErr instanceof Error ? retryErr.message : String(retryErr)}).`,
          { recoverable: false, cause: retryErr },
        );
      }
    }
  }

  /** Disposes the ORT session and releases the retained model bytes. */
  dispose(): void {
    this.#disposeSession();
    this.#modelBytes = null;
    this.#loadedKey = null;
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
    const hw = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
    ort.env.wasm.numThreads = capabilities.wasmThreads ? Math.min(hw, MAX_WASM_THREADS) : 1;
    ort.env.wasm.proxy = false;
    (ort.env.wasm as { jsep?: boolean }).jsep = capabilities.webgpu;
    ort.env.wasm.wasmPaths = this.#ortWasmPaths ?? DEFAULT_ORT_WASM_PATHS;
    this.#envConfigured = true;
  }

  /**
   * Cache-first model acquisition: on a Cache API hit, the bytes are served
   * locally and NO download progress is emitted. On a miss, the response is
   * streamed with per-chunk progress, stored in the cache, and returned.
   */
  async #acquireModelBytes(modelUrl: string, quantization: Quantization): Promise<ArrayBuffer> {
    const cacheKey = `${quantization}:${modelUrl}`;
    let cache: Cache | null = null;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      // Cache API unavailable (e.g. insecure context) — proceed uncached.
      cache = null;
    }

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        // Cache hit: serve silently, exactly as the contract requires.
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

    this.#notifications.onDownloadProgress(1);

    if (cache) {
      // Cache for next time; a quota failure must not fail the run.
      try {
        await cache.put(cacheKey, new Response(bytes));
      } catch (err) {
        console.warn('[upscaler] could not cache model bytes', err);
      }
    }
    return bytes;
  }

  /**
   * Creates the ORT session. Prefers the WebGPU EP (with WASM partition
   * fallback inside the graph); falls back to a WASM-only session if WebGPU
   * cannot create one, emitting the fallback event.
   */
  async #createSession(
    modelBytes: ArrayBuffer,
    capabilities: Pick<Capabilities, 'webgpu'>,
    forceEP?: 'wasm',
  ): Promise<void> {
    if (!forceEP && capabilities.webgpu) {
      try {
        this.#session = await ort.InferenceSession.create(modelBytes.slice(0), {
          executionProviders: ['webgpu', 'wasm'],
          graphOptimizationLevel: 'all',
        });
        this.#activeEP = 'webgpu';
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#notifications.onFallback(`WebGPU session creation failed: ${reason}`);
      }
    }
    this.#session = await ort.InferenceSession.create(modelBytes.slice(0), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    this.#activeEP = 'wasm';
  }

  #disposeSession(): void {
    this.#session?.release().catch(() => undefined);
    this.#session = null;
    this.#activeEP = null;
  }
}
