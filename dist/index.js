// src/DeviceRouter.ts
function isSecure() {
  return typeof isSecureContext !== "undefined" && isSecureContext;
}
function isCrossOriginIsolated() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}
async function readAdapterInfo(adapter) {
  const pick = (info) => ({
    vendor: info.vendor ?? "",
    architecture: info.architecture ?? "",
    device: info.device ?? "",
    description: info.description ?? ""
  });
  const sync = adapter.info;
  if (sync && typeof sync === "object") {
    return pick(sync);
  }
  if (typeof adapter.requestAdapterInfo === "function") {
    try {
      return pick(await adapter.requestAdapterInfo());
    } catch {
      return null;
    }
  }
  return null;
}
function adapterInfoKey(info) {
  if (!info) {
    return "";
  }
  return [info.vendor, info.architecture, info.device, info.description].join("|").toLowerCase();
}
var SOFTWARE_GPU_PATTERN = /swiftshader|lavapipe|llvmpipe|software|basic render/i;
function isSoftwareGpuInfo(info) {
  if (!info) {
    return false;
  }
  return SOFTWARE_GPU_PATTERN.test([info.vendor, info.architecture, info.device, info.description].join(" "));
}
var TIER_NEURAL_MEGAPIXELS = {
  software: 0.5,
  entry: 1,
  mid: 4,
  high: 12
};
var DGPU_PATTERN = /(rtx|radeon pro|geforce|quadro|arc (a|graphics)|rx \d{3,}|apple m\d+ (pro|max|ultra))/i;
var IGPU_PATTERN = /(uhd|iris|xe graphics|mali|adreno|apple m\d+$|intel\(r\).*graphics)/i;
function classifyGpuTier(input) {
  if (input.softwareGpu) {
    return "software";
  }
  const text = input.info ? [input.info.vendor, input.info.architecture, input.info.device, input.info.description].join(" ") : "";
  const memory = typeof input.deviceMemory === "number" ? input.deviceMemory : void 0;
  let tier;
  if (DGPU_PATTERN.test(text)) {
    tier = memory === void 0 || memory > 4 ? "high" : "mid";
  } else if (IGPU_PATTERN.test(text)) {
    tier = memory === void 0 || memory > 4 ? "mid" : "entry";
  } else if ((input.limits?.maxTextureDimension2D ?? 0) >= 8192) {
    tier = memory !== void 0 && memory <= 4 ? "entry" : "mid";
  } else {
    tier = "entry";
  }
  return tier;
}
var DeviceRouter = class {
  /** Probes are memoized PER preference (the GPU picker re-probes). */
  #probing = /* @__PURE__ */ new Map();
  #capabilities = /* @__PURE__ */ new Map();
  /**
   * Probes (once per preference, then memoizes) the device capabilities.
   * Concurrent calls for the same preference share a single probe.
   * Default preference 'high-performance': a compute engine wants the dGPU.
   */
  getCapabilities(preference = "high-performance") {
    let probing = this.#probing.get(preference);
    if (!probing) {
      probing = this.#probe(preference).then((caps) => {
        this.#capabilities.set(preference, caps);
        return caps;
      });
      this.#probing.set(preference, probing);
    }
    return probing;
  }
  /** Previously memoized capabilities for a preference, if probed already. */
  get cached() {
    const first = this.#capabilities.values().next();
    return first.done ? null : first.value ?? null;
  }
  cachedFor(preference) {
    return this.#capabilities.get(preference) ?? null;
  }
  async #probe(preference) {
    const nav = navigator;
    let webgpu = false;
    let adapterInfo = null;
    let secondaryAdapterInfo = null;
    let dualGpu = false;
    let limits;
    if (isSecure() && typeof nav.gpu?.requestAdapter === "function") {
      let primary = null;
      try {
        primary = await nav.gpu.requestAdapter(preference === "default" ? {} : { powerPreference: preference });
        webgpu = primary != null;
      } catch {
        webgpu = false;
      }
      if (primary) {
        limits = primary.limits;
        adapterInfo = await readAdapterInfo(primary);
        const opposite = preference === "high-performance" ? "low-power" : "high-performance";
        try {
          const secondary = await nav.gpu.requestAdapter({ powerPreference: opposite });
          if (secondary) {
            const secondaryInfo = await readAdapterInfo(secondary);
            if (secondaryInfo && adapterInfoKey(secondaryInfo) !== adapterInfoKey(adapterInfo)) {
              dualGpu = true;
              secondaryAdapterInfo = secondaryInfo;
            }
          }
        } catch {
          dualGpu = false;
        }
      }
    }
    const softwareGpu = isSoftwareGpuInfo(adapterInfo);
    const deviceMemory = nav.deviceMemory;
    const lowVram = typeof deviceMemory !== "number" || deviceMemory <= 4;
    const wasm = typeof WebAssembly === "object";
    const wasmThreads = wasm && isCrossOriginIsolated() && typeof SharedArrayBuffer === "function";
    const gpuTier = classifyGpuTier({ info: adapterInfo, softwareGpu, deviceMemory, limits });
    return {
      webgpu,
      wasm,
      wasmThreads,
      lowVram,
      adapterInfo,
      dualGpu,
      secondaryAdapterInfo: dualGpu ? secondaryAdapterInfo : null,
      softwareGpu,
      gpuTier
    };
  }
};

// src/EventEmitter.ts
var EventEmitter = class {
  #listeners = /* @__PURE__ */ new Map();
  /**
   * Subscribes to an event type. Returns an unsubscribe function; calling it
   * twice is a no-op.
   */
  on(type, handler) {
    let set = this.#listeners.get(type);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.#listeners.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }
  /** Removes a previously subscribed handler. Unknown handlers are ignored. */
  off(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }
  /**
   * Dispatches an event to the current listeners of its type. The listener
   * set is snapshotted, so a handler may subscribe/unsubscribe during
   * dispatch without affecting the in-flight iteration. A throwing listener
   * is reported to the console and never breaks the engine or other listeners.
   */
  emit(event) {
    const set = this.#listeners.get(event.type);
    if (!set || set.size === 0) {
      return;
    }
    for (const handler of [...set]) {
      try {
        handler(event);
      } catch (err) {
        console.error('[upscaler] event listener threw for event type "%s"', event.type, err);
      }
    }
  }
  /** Removes every listener. Used by {@link import('./index.js').UpscalerEngine.destroy}. */
  clear() {
    this.#listeners.clear();
  }
};

// src/errors.ts
var UpscalerError = class extends Error {
  code;
  recoverable;
  /**
   * true when the error was already emitted on the engine's `error` event
   * (worker → WorkerController → event). The engine uses this to emit every
   * failure exactly once while still rejecting the operation's promise.
   */
  forwarded = false;
  constructor(code, message, options = {}) {
    super(message, options.cause !== void 0 ? { cause: options.cause } : void 0);
    this.name = "UpscalerError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
};
function upscalerErrorFromWire(code, message, recoverable) {
  const err = new UpscalerError(code, message, { recoverable });
  err.forwarded = true;
  return err;
}

// src/ModelManager.ts
import * as ort from "onnxruntime-web/webgpu";

// src/ModelSelection.ts
function selectModelVariant(catalog, capabilities) {
  if (capabilities.webgpu && catalog.webgpu) {
    if (capabilities.softwareGpu && catalog.wasm) {
      return {
        variant: "wasm",
        url: catalog.wasm,
        reason: "software GPU adapter detected (SwiftShader-like rasterizer) \u2014 routed to the wasm variant; the software WebGPU EP would run the same math on the same CPU, slower"
      };
    }
    return {
      variant: "webgpu",
      url: catalog.webgpu,
      ...capabilities.softwareGpu ? {
        reason: "software GPU adapter detected but the catalog has no wasm variant \u2014 proceeding on the software WebGPU EP (expect slow inference)"
      } : capabilities.dualGpu ? { reason: "dual-GPU device \u2014 the high-performance adapter was requested for this compute workload" } : {},
      ...catalog.wasm && catalog.wasm !== catalog.webgpu ? { wasmFallbackUrl: catalog.wasm } : {}
    };
  }
  if (catalog.wasm) {
    return { variant: "wasm", url: catalog.wasm };
  }
  throw new UpscalerError(
    "MODEL_VARIANT_MISSING",
    capabilities.webgpu ? 'The models catalog has no "wasm" variant. The WebGPU variant only runs on the WebGPU execution provider; supply models.wasm (a fp32/int8 export) for CPU/WASM execution.' : 'No WebGPU adapter was probed and the models catalog has no "wasm" variant. Supply models.wasm (a fp32/int8 export) for CPU/WASM execution.',
    { recoverable: true }
  );
}

// src/ModelManager.ts
var DEFAULT_ORT_WASM_PATHS = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";
var CACHE_NAME = "upscaler-models";
var MAX_WASM_THREADS = 8;
function f32ToF16Bits(value) {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0];
  const sign = x >>> 16 & 32768;
  const absBits = x & 2147483647;
  if (absBits > 2139095040) return sign | 32256;
  if (absBits === 2139095040) return sign | 31744;
  const exp = (x >>> 23 & 255) - 127 + 15;
  const frac = x & 8388607;
  if (exp >= 31) return sign | 31744;
  if (exp > 0) {
    const roundBit2 = frac >>> 12 & 1;
    const tail2 = frac & 4095;
    let half2 = sign | exp << 10 | frac >>> 13;
    if (roundBit2 === 1 && (tail2 !== 0 || (half2 & 1) === 1)) half2 += 1;
    return half2;
  }
  const shift = 14 - exp;
  if (shift > 24) return sign;
  const mant = frac | 8388608;
  const kept = mant >>> shift;
  const roundBit = mant >>> shift - 1 & 1;
  const tail = mant & (1 << shift - 1) - 1;
  const half = sign | kept;
  if (roundBit === 1 && (tail !== 0 || (kept & 1) === 1)) return half + 1;
  return half;
}
function f16BitsToF32(bits) {
  const sign = (bits & 32768) << 16;
  const exp = bits >>> 10 & 31;
  const frac = bits & 1023;
  const u32 = new Uint32Array(1);
  if (exp === 0) {
    if (frac === 0) {
      u32[0] = sign;
    } else {
      let e = 0;
      let f = frac;
      while ((f & 1024) === 0) {
        f <<= 1;
        e++;
      }
      u32[0] = sign | 127 - 15 - e << 23 | (f & 1023) << 13;
    }
  } else if (exp === 31) {
    u32[0] = sign | 2139095040 | frac << 13;
  } else {
    u32[0] = sign | exp - 15 + 127 << 23 | frac << 13;
  }
  return new Float32Array(u32.buffer)[0];
}
var ModelManager = class {
  #notifications;
  #sessionFactory;
  #byteAcquirer;
  #session = null;
  #activeEP = null;
  /** EP the capability decision ASKED for (single-EP guarantee ⇒ = actual on success). */
  #requestedEP = null;
  /** EP the successful session was created with — recorded truth, never guessed. */
  #actualEP = null;
  #activeUrl = null;
  /** WebGPU-precision file kept hot so the fallback can swap variants. */
  #webgpuBytes = null;
  #wasmBytes = null;
  #loadedKey = null;
  #envConfigured = false;
  #ortWasmPaths = void 0;
  #lastCached = false;
  constructor(notifications, sessionFactory, byteAcquirer) {
    this.#notifications = notifications;
    this.#sessionFactory = sessionFactory;
    this.#byteAcquirer = byteAcquirer;
  }
  /** Input tensor name, read from the live session — never hardcoded. */
  get inputName() {
    return this.#session?.inputNames[0] ?? "";
  }
  get outputName() {
    return this.#session?.outputNames[0] ?? "";
  }
  get isLoaded() {
    return this.#session !== null;
  }
  /** Which execution-provider family the current session targets. */
  get activeVariant() {
    return this.#activeEP;
  }
  /** EP the capability decision asked for (null before any load attempt). */
  get requestedEp() {
    return this.#requestedEP;
  }
  /** EP the successful session was actually created with. */
  get actualEp() {
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
  async loadModel(options) {
    const { modelUrl, models, capabilities } = options;
    let selectedUrl;
    let reason;
    let selectionEp = null;
    if (models) {
      const selection = selectModelVariant(models, capabilities);
      selectedUrl = selection.url;
      reason = selection.reason;
      selectionEp = selection.variant;
      this.#wasmFallbackUrl = selection.wasmFallbackUrl;
    } else if (modelUrl) {
      selectedUrl = modelUrl;
      reason = void 0;
      this.#wasmFallbackUrl = void 0;
    } else {
      throw new UpscalerError(
        "MODEL_URL_REQUIRED",
        "loadModel() requires either a modelUrl or a models catalog ({ webgpu?, wasm? }) in the engine config. The engine never downloads a model without the consumer explicitly configuring and calling loadModel() (Two-Gate flow).",
        { recoverable: true }
      );
    }
    const key = selectedUrl;
    if (!options.forceReload && this.#session && this.#loadedKey === key) {
      return {
        variant: this.#activeEP,
        url: this.#activeUrl,
        cached: this.#lastCached,
        ...reason !== void 0 ? { reason } : {},
        requestedEp: this.#requestedEP,
        actualEp: this.#actualEP
      };
    }
    this.#configureOrtEnv(capabilities, options.ortWasmPaths);
    const primaryBytes = await this.#getBytes(selectedUrl);
    this.#disposeSession();
    const requestedEp = selectionEp ?? (capabilities.webgpu ? "webgpu" : "wasm");
    this.#requestedEP = requestedEp;
    try {
      await this.#createSession(primaryBytes, selectedUrl, requestedEp);
    } catch (err) {
      if (requestedEp !== "webgpu") {
        throw err;
      }
      const reasonText = err instanceof Error ? err.message : String(err);
      let retryBytes;
      let swappedTo;
      if (this.#wasmFallbackUrl) {
        retryBytes = await this.#getBytes(this.#wasmFallbackUrl);
        this.#wasmBytes = retryBytes;
        this.#activeUrl = this.#wasmFallbackUrl;
        swappedTo = "wasm-variant";
      } else {
        retryBytes = primaryBytes;
        swappedTo = "same-file";
      }
      this.#notifications.onFallback(`WebGPU session creation failed: ${reasonText}`, swappedTo);
      await this.#createSession(retryBytes, this.#activeUrl ?? selectedUrl, "wasm");
    }
    this.#loadedKey = key;
    if (this.#actualEP === "webgpu") {
      this.#webgpuBytes = primaryBytes;
      this.#wasmBytes = null;
    } else {
      this.#webgpuBytes = null;
      this.#wasmBytes = primaryBytes;
    }
    return {
      variant: this.#actualEP,
      url: this.#activeUrl,
      cached: this.#lastCached,
      ...reason !== void 0 ? { reason } : {},
      requestedEp: this.#requestedEP,
      actualEp: this.#actualEP
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
  async run(image) {
    this.#assertSession();
    const inputTensor = this.#marshalInput(image);
    try {
      const output = await this.#runWithSession(this.#session, inputTensor);
      return this.#unmarshalOutput(image, output);
    } catch (err) {
      if (this.#activeEP !== "webgpu") {
        throw new UpscalerError(
          "INFERENCE_FAILED",
          `Neural inference failed (${err instanceof Error ? err.message : String(err)}).`,
          { recoverable: false, cause: err }
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.#disposeSession();
      let retryBytes = null;
      let swappedTo = "same-file";
      if (this.#wasmFallbackUrl) {
        if (this.#wasmBytes === null) {
          retryBytes = await this.#getBytes(this.#wasmFallbackUrl);
          this.#wasmBytes = retryBytes;
        } else {
          retryBytes = this.#wasmBytes;
        }
        this.#activeUrl = this.#wasmFallbackUrl;
        swappedTo = "wasm-variant";
      } else if (this.#webgpuBytes !== null) {
        retryBytes = this.#webgpuBytes;
      } else if (this.#wasmBytes !== null) {
        retryBytes = this.#wasmBytes;
      }
      if (retryBytes === null) {
        throw new UpscalerError(
          "INFERENCE_FAILED",
          `WebGPU inference failed and no WASM fallback bytes are available (${reason}).`,
          { recoverable: false, cause: err }
        );
      }
      this.#notifications.onFallback(reason, swappedTo);
      this.#requestedEP = "wasm";
      await this.#createSession(retryBytes, this.#activeUrl ?? "", "wasm");
      try {
        const output = await this.#runWithSession(this.#session, this.#marshalInput(image));
        return this.#unmarshalOutput(image, output);
      } catch (retryErr) {
        throw new UpscalerError(
          "INFERENCE_FAILED",
          `Neural inference failed on both WebGPU and WASM (${retryErr instanceof Error ? retryErr.message : String(retryErr)}).`,
          { recoverable: false, cause: retryErr }
        );
      }
    }
  }
  /** Disposes the session and releases retained model bytes. */
  dispose() {
    this.#disposeSession();
    this.#webgpuBytes = null;
    this.#wasmBytes = null;
    this.#loadedKey = null;
    this.#activeUrl = null;
  }
  // ——— Internals ————————————————————————————————————————————————————
  /** Distinct wasm-precision variant URL for a mid-flight swap, if any. */
  #wasmFallbackUrl = void 0;
  /** Byte acquisition: the injected test seam or the real cache-first path. */
  #getBytes(modelUrl) {
    return this.#byteAcquirer ? this.#byteAcquirer(modelUrl) : this.#acquireModelBytes(modelUrl);
  }
  async #runWithSession(session, input) {
    try {
      const feeds = { [session.inputNames[0] ?? "x"]: input };
      const results = await session.run(feeds);
      const outName = session.outputNames[0] ?? "";
      const output = results[outName];
      if (!output) {
        throw new Error(`model produced no output named "${outName}"`);
      }
      return output;
    } finally {
      input.dispose();
    }
  }
  #assertSession() {
    if (!this.#session) {
      throw new UpscalerError(
        "MODEL_NOT_LOADED",
        "No neural model session in the worker \u2014 loadModel() must run before neural inference.",
        { recoverable: true }
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
  #configureOrtEnv(capabilities, ortWasmPaths) {
    if (this.#envConfigured) {
      return;
    }
    this.#ortWasmPaths = ortWasmPaths;
    ort.env.wasm.wasmPaths = this.#ortWasmPaths ?? DEFAULT_ORT_WASM_PATHS;
    const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
    ort.env.wasm.numThreads = capabilities.wasmThreads ? Math.min(hw, MAX_WASM_THREADS) : 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.jsep = capabilities.webgpu;
    this.#envConfigured = true;
  }
  /**
   * Cache-first model acquisition: on a Cache API hit, the bytes are served
   * locally and NO download progress is emitted (`cached: true`). On a miss,
   * the response is streamed with per-chunk progress, stored in the cache,
   * and returned.
   */
  async #acquireModelBytes(modelUrl) {
    let cache = null;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      cache = null;
    }
    if (cache) {
      const hit = await cache.match(modelUrl);
      if (hit) {
        this.#lastCached = true;
        return hit.arrayBuffer();
      }
    }
    let response;
    try {
      response = await fetch(modelUrl, { mode: "cors" });
    } catch (err) {
      throw new UpscalerError(
        "MODEL_DOWNLOAD_FAILED",
        `Could not fetch model from ${modelUrl} (${err instanceof Error ? err.message : String(err)}). The host must be CORS-enabled.`,
        { recoverable: true, cause: err }
      );
    }
    if (!response.ok) {
      throw new UpscalerError(
        "MODEL_DOWNLOAD_FAILED",
        `Model download failed: HTTP ${response.status} ${response.statusText} for ${modelUrl}`,
        { recoverable: true }
      );
    }
    const total = Number(response.headers.get("Content-Length") ?? "0");
    let bytes;
    if (!response.body) {
      bytes = await response.arrayBuffer();
    } else {
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (; ; ) {
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
      try {
        await cache.put(modelUrl, new Response(bytes));
      } catch (err) {
        console.warn("[upscaler] could not cache model bytes", err);
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
  async #createSession(modelBytes, url, ep) {
    const create = this.#sessionFactory ?? ((bytes, providers) => ort.InferenceSession.create(bytes.slice(0), {
      executionProviders: providers,
      graphOptimizationLevel: "all"
    }));
    this.#session = await create(modelBytes, [ep]);
    this.#activeEP = ep;
    this.#actualEP = ep;
    this.#activeUrl = url;
  }
  #disposeSession() {
    this.#session?.release().catch(() => void 0);
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
  #marshalInput(image) {
    const { width, height, data } = image;
    const n = width * height;
    const meta = this.#session.inputMetadata?.[0];
    const isF16 = meta?.isTensor === true && meta.type === "float16";
    const planar = isF16 ? new Uint16Array(3 * n) : new Float32Array(3 * n);
    for (let px = 0; px < n; px++) {
      const i = px * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
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
    const inputName = this.#session.inputNames[0] ?? "x";
    void inputName;
    return new ort.Tensor(isF16 ? "float16" : "float32", planar, [1, 3, height, width]);
  }
  /**
   * CHW model output → RGBA ImageData: clamp [0,255], restore the ORIGINAL
   * alpha channel (the model is RGB and never sees alpha). Output dtype is
   * read from the session metadata — float16 outputs carry bit data that is
   * converted back to f32 before de-normalization.
   */
  #unmarshalOutput(original, output) {
    const dims = output.dims;
    const outH = dims[dims.length - 2];
    const outW = dims[dims.length - 1];
    const n = outW * outH;
    const isF16 = output.type === "float16";
    const raw = output.data;
    const sample = (i) => isF16 ? f16BitsToF32(raw[i]) : raw[i];
    const result = new Uint8ClampedArray(n * 4);
    for (let px = 0; px < n; px++) {
      const o = px * 4;
      result[o] = Math.min(Math.max(sample(px), 0), 1) * 255;
      result[o + 1] = Math.min(Math.max(sample(px + n), 0), 1) * 255;
      result[o + 2] = Math.min(Math.max(sample(px + 2 * n), 0), 1) * 255;
      const sx = Math.min(px % outW, original.width - 1);
      const sy = Math.min(Math.floor(px / outW), original.height - 1);
      result[o + 3] = original.data[(sy * original.width + sx) * 4 + 3];
    }
    output.dispose();
    return new ImageData(result, outW, outH);
  }
};

// src/Timeouts.ts
var TimeoutGovernor = class {
  #idleMs;
  #hardMs;
  #onExpire;
  #idleTimer = null;
  #hardTimer = null;
  #stopped = false;
  #expiredWith = null;
  constructor(options) {
    if (!Number.isFinite(options.idleMs) || options.idleMs <= 0) {
      throw new Error(`TimeoutGovernor: idleMs must be a positive number, got ${String(options.idleMs)}`);
    }
    if (options.hardMs !== void 0 && (!Number.isFinite(options.hardMs) || options.hardMs <= 0)) {
      throw new Error(`TimeoutGovernor: hardMs must be a positive number or undefined, got ${String(options.hardMs)}`);
    }
    this.#idleMs = options.idleMs;
    this.#hardMs = options.hardMs;
    this.#onExpire = options.onExpire;
  }
  /** Arms both timers. */
  start() {
    this.#armIdle();
    if (this.#hardMs !== void 0) {
      this.#hardTimer = setTimeout(() => this.#fire("hard"), this.#hardMs);
    }
  }
  /** Worker activity: resets ONLY the idle timer. Never fires twice. */
  poke() {
    if (this.#stopped || this.#expiredWith) {
      return;
    }
    this.#armIdle();
  }
  /** Disarms everything (operation settled or worker killed for other reasons). */
  stop() {
    this.#stopped = true;
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#hardTimer) {
      clearTimeout(this.#hardTimer);
      this.#hardTimer = null;
    }
  }
  /** Which limit fired, if any ('idle' | 'hard' | null). */
  get expiredWith() {
    return this.#expiredWith;
  }
  #armIdle() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
    }
    this.#idleTimer = setTimeout(() => this.#fire("idle"), this.#idleMs);
  }
  #fire(reason) {
    if (this.#stopped || this.#expiredWith) {
      return;
    }
    this.#expiredWith = reason;
    this.stop();
    this.#onExpire(reason);
  }
};

// src/WorkerController.ts
var WorkerController = class {
  #callbacks;
  #timeout;
  #worker = null;
  #nextId = 1;
  #pending = null;
  constructor(callbacks, timeout) {
    if (!Number.isFinite(timeout.idleMs) || timeout.idleMs <= 0) {
      throw new UpscalerError("INVALID_INPUT", `idle timeout must be a positive number of milliseconds, got ${timeout.idleMs}.`);
    }
    if (timeout.hardMs !== void 0 && (!Number.isFinite(timeout.hardMs) || timeout.hardMs <= 0)) {
      throw new UpscalerError("INVALID_INPUT", `hardTimeoutMs must be a positive number of milliseconds or undefined, got ${String(timeout.hardMs)}.`);
    }
    this.#callbacks = callbacks;
    this.#timeout = timeout;
  }
  /** True while a load-model/process operation is in flight. */
  get busy() {
    return this.#pending !== null;
  }
  loadModel(params) {
    return this.#run((id) => [{ id, kind: "load-model", ...params }, []]);
  }
  process(params) {
    return this.#run((id) => {
      if (params.buffer.byteLength === 0) {
        throw new UpscalerError(
          "INVALID_INPUT",
          "Input ArrayBuffer is empty or already detached (it may have been transferred by a previous process() call).",
          { recoverable: true }
        );
      }
      return [{ id, kind: "process", ...params }, [params.buffer]];
    });
  }
  /**
   * Terminates the worker. This reclaims EVERYTHING the worker owned in one
   * stroke — the ORT session and the WASM (scaler + model) memory all live
   * in the worker's heap and are freed when it dies.
   */
  dispose() {
    if (this.#pending) {
      const pending = this.#pending;
      pending.governor.stop();
      this.#pending = null;
      pending.reject(
        new UpscalerError("DESTROYED", "The engine was destroyed while an operation was in progress.", {
          recoverable: false
        })
      );
    }
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
  }
  #run(build) {
    if (this.#pending) {
      return Promise.reject(
        new UpscalerError(
          "BUSY",
          "The engine is already processing an operation; it handles one at a time. Wait for the current promise to settle.",
          { recoverable: true }
        )
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const governor = new TimeoutGovernor({
        idleMs: this.#timeout.idleMs,
        hardMs: this.#timeout.hardMs,
        onExpire: (reason) => this.#onTimeout(id, reason)
      });
      const pending = { id, resolve, reject, governor };
      this.#pending = pending;
      governor.start();
      let worker;
      try {
        worker = this.#ensureWorker();
        const [message, transfer] = build(id);
        worker.postMessage(message, transfer);
      } catch (err) {
        const error = err instanceof UpscalerError ? err : new UpscalerError("WORKER_FAILED", `Could not dispatch work to the worker: ${String(err)}.`, {
          recoverable: false,
          cause: err
        });
        this.#settle(id, void 0, error);
      }
    });
  }
  #ensureWorker() {
    if (this.#worker) {
      return this.#worker;
    }
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      this.#onMessage(event.data);
    };
    worker.onerror = (event) => {
      this.#onCrash(`worker crashed: ${event.message || "uncaught error"}`);
    };
    worker.onmessageerror = () => {
      this.#onCrash("worker message could not be deserialized");
    };
    this.#worker = worker;
    return worker;
  }
  #onMessage(message) {
    if (this.#pending && message.id === this.#pending.id) {
      this.#pending.governor.poke();
    }
    if (!this.#pending || message.id !== this.#pending.id) {
      return;
    }
    switch (message.kind) {
      case "heartbeat":
        return;
      // proof of life only — not forwarded, not the public union
      case "model_download":
      case "tile_processing":
      case "fallback":
        this.#callbacks.onEvent(message);
        return;
      case "ready":
        this.#settle(message.id, {
          variant: message.variant,
          url: message.url,
          cached: message.cached,
          ...message.reason !== void 0 ? { reason: message.reason } : {},
          requestedEp: message.requestedEp,
          actualEp: message.actualEp
        });
        return;
      case "done":
        this.#settle(message.id, message.blob);
        return;
      case "error":
        this.#callbacks.onEvent(message);
        this.#settle(message.id, void 0, upscalerErrorFromWire(message.code, message.message, message.recoverable));
        return;
    }
  }
  #onTimeout(id, reason) {
    const pending = this.#pending;
    if (!pending || pending.id !== id) {
      return;
    }
    this.#killWorker();
    const message = reason === "hard" ? `Operation exceeded the absolute hardTimeoutMs cap (${this.#timeout.hardMs} ms) and the worker was terminated, despite making progress. Raise hardTimeoutMs or reduce the input size.` : `No worker activity for ${this.#timeout.idleMs} ms (inactivity timeout) and the worker was terminated. If a single inference step is legitimately slower than this, raise the timeout \u2014 progress resets it.`;
    const error = upscalerErrorFromWire("TIMEOUT", message, false);
    this.#callbacks.onEvent({ kind: "error", id, code: "TIMEOUT", message: error.message, recoverable: false });
    this.#settle(id, void 0, error);
  }
  #onCrash(message) {
    const pending = this.#pending;
    this.#killWorker();
    const error = upscalerErrorFromWire("WORKER_FAILED", message, false);
    this.#callbacks.onEvent({
      kind: "error",
      id: pending?.id ?? -1,
      code: "WORKER_FAILED",
      message,
      recoverable: false
    });
    if (pending) {
      this.#settle(pending.id, void 0, error);
    }
  }
  #killWorker() {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
      this.#callbacks.onWorkerDied();
    }
  }
  #settle(id, value, error) {
    const pending = this.#pending;
    if (!pending || pending.id !== id) {
      return;
    }
    pending.governor.stop();
    this.#pending = null;
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve(value);
    }
  }
};

// src/UpscalerEngine.ts
var DEFAULT_TIMEOUT_MS = 3e5;
var DEFAULT_MAX_DIMENSION = 16384;
var DEFAULT_QUANTIZATION = "fp16";
var DEFAULT_GPU_PREFERENCE = "high-performance";
var VALID_QUANTIZATIONS = ["fp32", "fp16", "int8"];
var VALID_METHODS = ["lanczos", "bicubic", "neural"];
var VALID_FORMATS = ["image/png", "image/webp"];
var VALID_PREFERENCES = ["high-performance", "low-power", "default"];
var UpscalerEngine = class {
  #events = new EventEmitter();
  #device = new DeviceRouter();
  #config;
  #controller;
  #capabilities = /* @__PURE__ */ new Map();
  #activePreference;
  #loadResult = null;
  #modelLoaded = false;
  #destroyed = false;
  #lastTileDurationMs = void 0;
  constructor(config = {}) {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxDimension = config.maxDimension ?? DEFAULT_MAX_DIMENSION;
    const quantization = config.quantization ?? DEFAULT_QUANTIZATION;
    const gpuPreference = config.gpuPreference ?? DEFAULT_GPU_PREFERENCE;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new UpscalerError("INVALID_INPUT", `config.timeout must be a positive number (ms), got ${String(timeout)}.`);
    }
    if (config.hardTimeoutMs !== void 0 && (!Number.isFinite(config.hardTimeoutMs) || config.hardTimeoutMs <= 0)) {
      throw new UpscalerError("INVALID_INPUT", `config.hardTimeoutMs must be a positive number (ms) or undefined, got ${String(config.hardTimeoutMs)}.`);
    }
    if (!Number.isInteger(maxDimension) || maxDimension <= 0) {
      throw new UpscalerError("INVALID_INPUT", `config.maxDimension must be a positive integer, got ${String(maxDimension)}.`);
    }
    if (!VALID_QUANTIZATIONS.includes(quantization)) {
      throw new UpscalerError("INVALID_INPUT", `config.quantization must be one of ${VALID_QUANTIZATIONS.join(", ")}, got ${String(quantization)}.`);
    }
    if (!VALID_PREFERENCES.includes(gpuPreference)) {
      throw new UpscalerError("INVALID_INPUT", `config.gpuPreference must be one of ${VALID_PREFERENCES.join(", ")}, got ${String(gpuPreference)}.`);
    }
    this.#config = { ...config, timeout, maxDimension, quantization };
    this.#activePreference = gpuPreference;
    this.#controller = new WorkerController(
      {
        onEvent: (event) => this.#forwardWorkerEvent(event),
        onWorkerDied: () => {
          this.#modelLoaded = false;
          this.#loadResult = null;
        }
      },
      {
        idleMs: timeout,
        ...config.hardTimeoutMs !== void 0 ? { hardMs: config.hardTimeoutMs } : {}
      }
    );
  }
  /**
   * Subscribes to a typed engine event. Returns an unsubscribe function.
   * Events: `model_download`, `tile_processing`, `fallback`, `complete`,
   * `error` — see the README for exact payload shapes.
   */
  on(type, handler) {
    return this.#events.on(type, handler);
  }
  /** Removes a previously subscribed handler. */
  off(type, handler) {
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
  async detectDevice(preference) {
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
  async loadModel(preference) {
    this.#assertAlive();
    if (preference) {
      this.#assertValidPreference(preference);
      this.#activePreference = preference;
    }
    if (this.#config.models && this.#config.modelUrl) {
      throw new UpscalerError(
        "INVALID_INPUT",
        "Pass EITHER modelUrl OR models \u2014 the models catalog takes precedence, so a simultaneously configured modelUrl is almost certainly a mistake.",
        { recoverable: true }
      );
    }
    const capabilities = await this.detectDevice(this.#activePreference);
    const forceReload = preference !== void 0 && this.#modelLoaded;
    let result;
    try {
      result = await this.#controller.loadModel({
        // Simple path: expand dir-style URL here (quantization is an
        // engine-config concern). Catalog URLs are used verbatim.
        modelUrl: this.#config.modelUrl ? this.#resolveModelUrl() : void 0,
        models: this.#config.models,
        capabilities,
        ortWasmPaths: this.#config.ortWasmPaths,
        forceReload
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
      ...result.reason !== void 0 ? { reason: result.reason } : {}
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
  async process(buffer, options) {
    this.#assertAlive();
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
      throw new UpscalerError(
        "INVALID_INPUT",
        "process() requires a non-empty ArrayBuffer. Note: the engine transfers it (zero-copy), so a buffer from a previous process() call is detached and cannot be reused.",
        { recoverable: true }
      );
    }
    if (!VALID_METHODS.includes(options.method)) {
      throw new UpscalerError("INVALID_METHOD", `options.method must be one of ${VALID_METHODS.join(", ")}, got ${String(options.method)}.`, {
        recoverable: true
      });
    }
    if (options.scale !== 2 && options.scale !== 4) {
      throw new UpscalerError("INVALID_SCALE", `options.scale must be 2 or 4, got ${String(options.scale)}.`, { recoverable: true });
    }
    if (options.format !== void 0 && !VALID_FORMATS.includes(options.format)) {
      throw new UpscalerError("INVALID_INPUT", `options.format must be 'image/png' or 'image/webp', got ${String(options.format)}.`, {
        recoverable: true
      });
    }
    if (options.quality !== void 0 && !(Number.isFinite(options.quality) && options.quality >= 0 && options.quality <= 1)) {
      throw new UpscalerError("INVALID_INPUT", `options.quality must be within [0, 1], got ${String(options.quality)}.`, {
        recoverable: true
      });
    }
    if (options.method === "neural" && !this.#modelLoaded) {
      throw new UpscalerError(
        "MODEL_NOT_LOADED",
        'process({ method: "neural" }) requires a prior loadModel() call \u2014 the engine never downloads the model implicitly. Use lanczos or bicubic for instant, download-free upscaling.',
        { recoverable: true }
      );
    }
    const capabilities = await this.detectDevice(this.#activePreference);
    const params = {
      buffer,
      method: options.method,
      scale: options.scale,
      format: options.format ?? "image/png",
      ...options.quality !== void 0 ? { quality: options.quality } : {},
      capabilities,
      maxDimension: this.#config.maxDimension
    };
    let blob;
    try {
      blob = await this.#controller.process(params);
    } catch (err) {
      throw this.#asEmitted(err);
    }
    const blobUrl = URL.createObjectURL(blob);
    this.#events.emit({ type: "complete", blobUrl });
    return blob;
  }
  /**
   * Synchronous truth snapshot: what hardware was probed, which variant was
   * chosen and why, which EP was requested vs actually created (the
   * single-EP guarantee makes `actualEp` recorded fact, not a guess), the
   * raw adapter info beside the tier heuristic, and the last tile duration.
   */
  getDiagnostics() {
    const capabilities = this.#capabilities.get(this.#activePreference) ?? null;
    return {
      capabilities,
      ...this.#loadResult ? {
        chosenVariant: this.#loadResult.variant,
        requestedEp: this.#loadResult.requestedEp,
        actualEp: this.#loadResult.actualEp
      } : {},
      ...capabilities?.adapterInfo !== void 0 ? { adapterInfo: capabilities.adapterInfo } : {},
      ...capabilities?.gpuTier !== void 0 ? { gpuTier: capabilities.gpuTier } : {},
      ...capabilities?.dualGpu !== void 0 ? { dualGpu: capabilities.dualGpu } : {},
      ...this.#lastTileDurationMs !== void 0 ? { lastTileDurationMs: this.#lastTileDurationMs } : {},
      sessionActive: this.#modelLoaded && !this.#destroyed
    };
  }
  /**
   * Tears the engine down: terminates the worker (which frees the ORT
   * session and all WASM memory — they lived in the worker's heap), rejects
   * any in-flight operation, and clears every listener. The instance is
   * unusable afterwards.
   */
  destroy() {
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
  #assertAlive() {
    if (this.#destroyed) {
      throw new UpscalerError("DESTROYED", "This UpscalerEngine instance has been destroyed. Create a new instance.", {
        recoverable: false
      });
    }
  }
  #assertValidPreference(preference) {
    if (!VALID_PREFERENCES.includes(preference)) {
      throw new UpscalerError("INVALID_INPUT", `gpu preference must be one of ${VALID_PREFERENCES.join(", ")}, got ${String(preference)}.`, {
        recoverable: true
      });
    }
  }
  /**
   * Two-Gate support (simple path): a directory-style `modelUrl` gets the
   * quantization-variant filename appended. The catalog path never touches
   * this — its URLs are used verbatim. No default remote host is invented —
   * a missing modelUrl/models throws.
   */
  #resolveModelUrl() {
    const url = this.#config.modelUrl;
    if (!url) {
      throw new UpscalerError(
        "MODEL_URL_REQUIRED",
        "loadModel() requires either a modelUrl or a models catalog ({ webgpu?, wasm? }) in the engine config. The engine never downloads a model without the consumer explicitly configuring and calling loadModel() (Two-Gate flow).",
        { recoverable: true }
      );
    }
    if (url.endsWith("/")) {
      return `${url}realesrgan-x4-${this.#config.quantization}.onnx`;
    }
    return url;
  }
  /**
   * Worker events become engine events. Errors are forwarded for the event
   * stream; the controller already rejected the operation's promise with
   * the same error.
   */
  #forwardWorkerEvent(event) {
    switch (event.kind) {
      case "model_download":
        this.#events.emit({ type: "model_download", progress: event.progress });
        return;
      case "tile_processing":
        if (event.tileDurationMs !== void 0) {
          this.#lastTileDurationMs = event.tileDurationMs;
        }
        this.#events.emit({
          type: "tile_processing",
          tileIndex: event.tileIndex,
          totalTiles: event.totalTiles,
          ...event.tileDurationMs !== void 0 ? { tileDurationMs: event.tileDurationMs } : {},
          ...event.etaMs !== void 0 ? { etaMs: event.etaMs } : {}
        });
        return;
      case "fallback":
        this.#events.emit({
          type: "fallback",
          from: "webgpu",
          to: "wasm",
          reason: event.swappedTo === "wasm-variant" ? `${event.reason} (swapped to the wasm variant)` : event.reason,
          ...event.swappedTo !== void 0 ? { swappedTo: event.swappedTo } : {}
        });
        return;
      case "error":
        this.#events.emit({ type: "error", message: event.message, recoverable: event.recoverable });
        return;
    }
  }
  /**
   * Emits an `error` event for operational failures and returns the error
   * so the caller can throw it (single source of truth, two channels).
   * Usage errors that never reached the worker are NOT re-emitted here.
   */
  #asEmitted(err) {
    const error = err instanceof UpscalerError ? err : new UpscalerError("WORKER_FAILED", err instanceof Error ? err.message : String(err), {
      recoverable: false,
      cause: err
    });
    if (!error.forwarded) {
      this.#events.emit({ type: "error", message: error.message, recoverable: error.recoverable });
    }
    return error;
  }
};

// src/TileProcessor.ts
var TILE_OVERLAP = 16;
var HIGH_TIER_OVERLAP = 24;
var TILE_SIZE = 512;
var TILE_SIZE_LOW_VRAM = 256;
function tilePolicyFor(capabilities, hardwareConcurrency = 4) {
  const tier = capabilities.gpuTier ?? "entry";
  let policy;
  switch (tier) {
    case "high":
      policy = { tileSize: TILE_SIZE, overlap: HIGH_TIER_OVERLAP, concurrency: 4 };
      break;
    case "mid":
      policy = { tileSize: TILE_SIZE, overlap: TILE_OVERLAP, concurrency: 4 };
      break;
    default:
      policy = { tileSize: TILE_SIZE_LOW_VRAM, overlap: TILE_OVERLAP, concurrency: 2 };
      break;
  }
  if (capabilities.lowVram) {
    policy = {
      tileSize: Math.min(policy.tileSize, TILE_SIZE_LOW_VRAM),
      overlap: Math.min(policy.overlap, TILE_OVERLAP),
      concurrency: Math.min(policy.concurrency, 2)
    };
  }
  if (!capabilities.webgpu) {
    policy = { ...policy, concurrency: Math.min(policy.concurrency, Math.max(1, hardwareConcurrency)) };
  }
  return policy;
}
export {
  DeviceRouter,
  EventEmitter,
  HIGH_TIER_OVERLAP,
  ModelManager,
  TIER_NEURAL_MEGAPIXELS,
  TILE_OVERLAP,
  TimeoutGovernor,
  UpscalerEngine,
  UpscalerError,
  adapterInfoKey,
  classifyGpuTier,
  isSoftwareGpuInfo,
  readAdapterInfo,
  selectModelVariant,
  tilePolicyFor
};
//# sourceMappingURL=index.js.map