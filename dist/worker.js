// src/wasm/upscaler_wasm.js
var WasmScalerJob = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WasmScalerJobFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_wasmscalerjob_free(ptr, 0);
  }
  /**
   * Creates a job and copies `pixels` (RGBA8, `width * height * 4` bytes)
   * into the WASM heap. Does no work until [`WasmScalerJob::process`].
   * @param {Uint8Array} pixels
   * @param {number} width
   * @param {number} height
   * @param {number} scale
   * @param {boolean} lanczos
   */
  constructor(pixels, width, height, scale, lanczos) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      const ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_export);
      const len0 = WASM_VECTOR_LEN;
      wasm.wasmscalerjob_new(retptr, ptr0, len0, width, height, scale, lanczos);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
      if (r2) {
        throw takeObject(r1);
      }
      this.__wbg_ptr = r0;
      WasmScalerJobFinalization.register(this, this.__wbg_ptr, this);
      return this;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
   * Number of bytes in the processed output (`out_w * out_h * 4`), or 0
   * before `process()` has run.
   * @returns {number}
   */
  get outputByteLength() {
    const ret = wasm.wasmscalerjob_outputByteLength(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Runs the resampler and keeps the result in the heap until
   * [`WasmScalerJob::take_output`] copies it out to JS.
   */
  process() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.wasmscalerjob_process(retptr, this.__wbg_ptr);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
      if (r1) {
        throw takeObject(r0);
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
   * Copies the processed buffer out to JS as a fresh `Uint8Array` and
   * releases the internal copy. Call `free()` afterwards (see contract).
   * @returns {Uint8Array}
   */
  take_output() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.wasmscalerjob_take_output(retptr, this.__wbg_ptr);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
      if (r3) {
        throw takeObject(r2);
      }
      var v1 = getArrayU8FromWasm0(r0, r1).slice();
      wasm.__wbindgen_export2(r0, r1 * 1, 1);
      return v1;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
};
if (Symbol.dispose) WasmScalerJob.prototype[Symbol.dispose] = WasmScalerJob.prototype.free;
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg_Error_408e67f47ca7b58b: function(arg0, arg1) {
      const ret = Error(getStringFromWasm0(arg0, arg1));
      return addHeapObject(ret);
    },
    __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    }
  };
  return {
    __proto__: null,
    "./upscaler_wasm_bg.js": import0
  };
}
var WasmScalerJobFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_wasmscalerjob_free(ptr, 1));
function addHeapObject(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];
  heap[idx] = obj;
  return idx;
}
function dropObject(idx) {
  if (idx < 1028) return;
  heap[idx] = heap_next;
  heap_next = idx;
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len);
}
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function getObject(idx) {
  return heap[idx];
}
var heap = new Array(1024).fill(void 0);
heap.push(void 0, null, true, false);
var heap_next = heap.length;
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function takeObject(idx) {
  const ret = getObject(idx);
  dropObject(idx);
  return ret;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
var WASM_VECTOR_LEN = 0;
var wasmModule;
var wasmInstance;
var wasm;
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance;
  wasm = instance.exports;
  wasmModule = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  return wasm;
}
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (!module.ok) {
      throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
    }
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = expectedResponseType(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}
async function __wbg_init(module_or_path) {
  if (wasm !== void 0) return wasm;
  if (module_or_path !== void 0) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (module_or_path === void 0) {
    module_or_path = new URL("./wasm/upscaler_wasm_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}

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

// src/Codec.ts
function scope() {
  return self;
}
function assertWorkerCanvasSupport() {
  const s = scope();
  if (typeof s.OffscreenCanvas !== "function" || typeof s.createImageBitmap !== "function") {
    throw new UpscalerError(
      "DECODE_FAILED",
      "Codec requires OffscreenCanvas and createImageBitmap \u2014 this module runs inside the engine worker only.",
      { recoverable: true }
    );
  }
}
var Codec = class {
  /**
   * Decodes an encoded image (PNG/JPEG/WebP/GIF/BMP/ICO — whatever
   * `createImageBitmap` supports in the current browser) into RGBA pixels.
   */
  static async decode(buffer) {
    assertWorkerCanvasSupport();
    const s = scope();
    let bitmap;
    try {
      bitmap = await s.createImageBitmap(new Blob([buffer]));
    } catch (err) {
      throw new UpscalerError(
        "DECODE_FAILED",
        `Failed to decode image input (${err instanceof Error ? err.message : String(err)}). Supported formats are those createImageBitmap accepts (PNG, JPEG, WebP, GIF, BMP, ICO).`,
        { recoverable: true, cause: err }
      );
    }
    try {
      const canvas = new s.OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new UpscalerError("DECODE_FAILED", "OffscreenCanvas 2D context is unavailable in this browser.", {
          recoverable: true
        });
      }
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }
  /**
   * Encodes RGBA pixels into a Blob. `quality` (0..1) applies to lossy
   * formats (WebP) and is ignored for PNG.
   */
  static async encode(imageData, format = "image/png", quality) {
    assertWorkerCanvasSupport();
    const s = scope();
    const canvas = new s.OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new UpscalerError("ENCODE_FAILED", "OffscreenCanvas 2D context is unavailable in this browser.", {
        recoverable: true
      });
    }
    ctx.putImageData(imageData, 0, 0);
    try {
      return await canvas.convertToBlob({
        type: format,
        ...quality !== void 0 ? { quality } : {}
      });
    } catch (err) {
      throw new UpscalerError(
        "ENCODE_FAILED",
        `Failed to encode result as ${format} (${err instanceof Error ? err.message : String(err)}).`,
        { recoverable: true, cause: err }
      );
    }
  }
};

// src/DeviceRouter.ts
function isSecure() {
  return typeof isSecureContext !== "undefined" && isSecureContext;
}
function isCrossOriginIsolated() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}
var DeviceRouter = class {
  #capabilities = null;
  #probing = null;
  /**
   * Probes (once, then memoizes) the device capabilities. Concurrent calls
   * share a single probe.
   */
  getCapabilities() {
    this.#probing ??= this.#probe().then((caps) => {
      this.#capabilities = caps;
      return caps;
    });
    return this.#probing;
  }
  /** Previously memoized capabilities, if a probe already completed. */
  get cached() {
    return this.#capabilities;
  }
  async #probe() {
    const nav = navigator;
    let webgpu = false;
    if (isSecure() && typeof nav.gpu?.requestAdapter === "function") {
      try {
        const adapter = await nav.gpu.requestAdapter();
        webgpu = adapter != null;
      } catch {
        webgpu = false;
      }
    }
    const deviceMemory = nav.deviceMemory;
    const lowVram = typeof deviceMemory !== "number" || deviceMemory <= 4;
    const wasm2 = typeof WebAssembly === "object";
    const wasmThreads = wasm2 && isCrossOriginIsolated() && typeof SharedArrayBuffer === "function";
    return { webgpu, wasm: wasm2, wasmThreads, lowVram };
  }
};

// src/ModelManager.ts
import * as ort from "onnxruntime-web/webgpu";
var DEFAULT_ORT_WASM_PATHS = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";
var CACHE_NAME = "upscaler-models";
var MAX_WASM_THREADS = 8;
var ModelManager = class {
  #notifications;
  #session = null;
  #activeEP = null;
  #modelBytes = null;
  #loadedKey = null;
  #envConfigured = false;
  #ortWasmPaths = void 0;
  constructor(notifications) {
    this.#notifications = notifications;
  }
  /** Names of the session's single input/output (Real-ESRGAN: NCHW RGB). */
  get inputName() {
    this.#assertSession();
    return this.#session.inputNames[0] ?? "";
  }
  get outputName() {
    this.#assertSession();
    return this.#session.outputNames[0] ?? "";
  }
  get isLoaded() {
    return this.#session !== null;
  }
  /**
   * Loads (cache-first) the model and creates an ORT session. Idempotent for
   * the same URL + quantization: a second call is a no-op.
   */
  async loadModel(modelUrl, quantization, capabilities2, ortWasmPaths) {
    const key = `${quantization}:${modelUrl}`;
    if (this.#session && this.#loadedKey === key) {
      return;
    }
    this.#configureOrtEnv(capabilities2, ortWasmPaths);
    const bytes = await this.#acquireModelBytes(modelUrl, quantization);
    this.#modelBytes = bytes;
    this.#disposeSession();
    await this.#createSession(bytes, capabilities2);
    this.#loadedKey = key;
  }
  /**
   * Runs one inference. If the WebGPU EP fails mid-run (OOM, context loss,
   * device loss), the session is disposed, recreated on the WASM EP, and the
   * SAME inference is retried once — the fallback is emitted as an event, not
   * a crash. Disposes `input`; the caller disposes the returned output tensor
   * after reading it.
   */
  async run(input) {
    this.#assertSession();
    try {
      return await this.#runWithSession(this.#session, input);
    } catch (err) {
      if (this.#activeEP !== "webgpu") {
        throw new UpscalerError(
          "INFERENCE_FAILED",
          `Neural inference failed (${err instanceof Error ? err.message : String(err)}).`,
          { recoverable: false, cause: err }
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.#notifications.onFallback(reason);
      this.#disposeSession();
      await this.#createSession(this.#modelBytes, { webgpu: false }, "wasm");
      try {
        return await this.#runWithSession(this.#session, input);
      } catch (retryErr) {
        throw new UpscalerError(
          "INFERENCE_FAILED",
          `Neural inference failed on both WebGPU and WASM (${retryErr instanceof Error ? retryErr.message : String(retryErr)}).`,
          { recoverable: false, cause: retryErr }
        );
      }
    }
  }
  /** Disposes the ORT session and releases the retained model bytes. */
  dispose() {
    this.#disposeSession();
    this.#modelBytes = null;
    this.#loadedKey = null;
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
  #configureOrtEnv(capabilities2, ortWasmPaths) {
    if (this.#envConfigured) {
      return;
    }
    this.#ortWasmPaths = ortWasmPaths;
    const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
    ort.env.wasm.numThreads = capabilities2.wasmThreads ? Math.min(hw, MAX_WASM_THREADS) : 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.jsep = capabilities2.webgpu;
    ort.env.wasm.wasmPaths = this.#ortWasmPaths ?? DEFAULT_ORT_WASM_PATHS;
    this.#envConfigured = true;
  }
  /**
   * Cache-first model acquisition: on a Cache API hit, the bytes are served
   * locally and NO download progress is emitted. On a miss, the response is
   * streamed with per-chunk progress, stored in the cache, and returned.
   */
  async #acquireModelBytes(modelUrl, quantization) {
    const cacheKey = `${quantization}:${modelUrl}`;
    let cache = null;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      cache = null;
    }
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
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
    this.#notifications.onDownloadProgress(1);
    if (cache) {
      try {
        await cache.put(cacheKey, new Response(bytes));
      } catch (err) {
        console.warn("[upscaler] could not cache model bytes", err);
      }
    }
    return bytes;
  }
  /**
   * Creates the ORT session. Prefers the WebGPU EP (with WASM partition
   * fallback inside the graph); falls back to a WASM-only session if WebGPU
   * cannot create one, emitting the fallback event.
   */
  async #createSession(modelBytes, capabilities2, forceEP) {
    if (!forceEP && capabilities2.webgpu) {
      try {
        this.#session = await ort.InferenceSession.create(modelBytes.slice(0), {
          executionProviders: ["webgpu", "wasm"],
          graphOptimizationLevel: "all"
        });
        this.#activeEP = "webgpu";
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#notifications.onFallback(`WebGPU session creation failed: ${reason}`);
      }
    }
    this.#session = await ort.InferenceSession.create(modelBytes.slice(0), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    this.#activeEP = "wasm";
  }
  #disposeSession() {
    this.#session?.release().catch(() => void 0);
    this.#session = null;
    this.#activeEP = null;
  }
};

// src/TileProcessor.ts
import * as ort2 from "onnxruntime-web/webgpu";
var TILE_OVERLAP = 16;
var TILE_SIZE = 512;
var TILE_SIZE_LOW_VRAM = 256;
var MAX_CONCURRENT_TILES_WEBGPU = 4;
var MAX_CONCURRENT_TILES_WASM = 8;
var TileProcessor = class {
  #onTileStart;
  constructor(onTileStart) {
    this.#onTileStart = onTileStart;
  }
  /**
   * Processes `image` with the tiled Real-ESRGAN pipeline at the model's
   * fixed 4x. Returns the full upscaled image.
   */
  async processNeural(image, capabilities2, model) {
    const tileSize = capabilities2.lowVram ? TILE_SIZE_LOW_VRAM : TILE_SIZE;
    const core = tileSize - 2 * TILE_OVERLAP;
    const scale = 4;
    const { width: W, height: H } = image;
    const cols = Math.ceil(W / core);
    const rows = Math.ceil(H / core);
    const total = cols * rows;
    const outW = W * scale;
    const outH = H * scale;
    const out = new Uint8ClampedArray(outW * outH * 4);
    const written = new Uint8Array(outW * outH + 7 >> 3);
    const jobs = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        jobs.push({ index: jobs.length, x0: c * core, y0: r * core });
      }
    }
    let next = 0;
    const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
    const concurrency = capabilities2.webgpu ? MAX_CONCURRENT_TILES_WEBGPU : Math.min(hw, MAX_CONCURRENT_TILES_WASM);
    const worker = async () => {
      for (; ; ) {
        const i = next++;
        if (i >= jobs.length) {
          return;
        }
        const job = jobs[i];
        this.#onTileStart(job.index, total);
        const tile = this.#extractTile(image, job.x0, job.y0, tileSize);
        const upscaled = await this.#inferTile(tile, model);
        this.#composite(out, written, upscaled, job.x0, job.y0, W, H, core, scale);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    return new ImageData(out, outW, outH);
  }
  /**
   * Extracts a `tileSize × tileSize` source rect centered on the core at
   * (`x0`, `y0`), with `TILE_OVERLAP` context on interior sides, clamped to
   * the image. Interior edges keep full context; image-border edges are
   * clamped away (no fabricated pixels).
   */
  #extractTile(image, x0, y0, tileSize) {
    const rectX = Math.max(0, x0 - TILE_OVERLAP);
    const rectY = Math.max(0, y0 - TILE_OVERLAP);
    const rectW = Math.min(tileSize, image.width - rectX);
    const rectH = Math.min(tileSize, image.height - rectY);
    const tile = new ImageData(rectW, rectH);
    const src = image.data;
    const dst = tile.data;
    for (let y = 0; y < rectH; y++) {
      const srcRow = ((rectY + y) * image.width + rectX) * 4;
      dst.set(src.subarray(srcRow, srcRow + rectW * 4), y * rectW * 4);
    }
    return tile;
  }
  /** Runs one tile through ORT: RGBA → NCHW f32 RGB [0,1] → model → RGBA. */
  async #inferTile(tile, model) {
    const { width, height, data } = tile;
    const planar = new Float32Array(3 * width * height);
    for (let px = 0, n = width * height; px < n; px++) {
      const i = px * 4;
      planar[px] = data[i] / 255;
      planar[px + n] = data[i + 1] / 255;
      planar[px + 2 * n] = data[i + 2] / 255;
    }
    const input = new ort2.Tensor("float32", planar, [1, 3, height, width]);
    const output = await model.run(input);
    try {
      const dims = output.dims;
      const outH = dims[2];
      const outW = dims[3];
      const outData = output.data;
      const result = new Uint8ClampedArray(outW * outH * 4);
      const n = outW * outH;
      for (let px = 0; px < n; px++) {
        const o = px * 4;
        result[o] = Math.round(Math.min(Math.max(outData[px], 0), 1) * 255);
        result[o + 1] = Math.round(Math.min(Math.max(outData[px + n], 0), 1) * 255);
        result[o + 2] = Math.round(Math.min(Math.max(outData[px + 2 * n], 0), 1) * 255);
        result[o + 3] = 255;
      }
      return new ImageData(result, outW, outH);
    } finally {
      output.dispose();
    }
  }
  /**
   * Blends one upscaled tile into the output (see class doc for the
   * first-write / cross-fade rule and the feather weights).
   */
  #composite(out, written, tile, x0, y0, srcW, srcH, core, scale) {
    const outW = srcW * scale;
    const outH = srcH * scale;
    const rectX = Math.max(0, x0 - TILE_OVERLAP);
    const rectY = Math.max(0, y0 - TILE_OVERLAP);
    const rectW = Math.min(tile.width, srcW - rectX);
    const rectH = Math.min(tile.height, srcH - rectY);
    const destX = rectX * scale;
    const destY = rectY * scale;
    const destW = rectW * scale;
    const destH = rectH * scale;
    const feather = TILE_OVERLAP * scale;
    const hasLeft = x0 > 0;
    const hasTop = y0 > 0;
    const hasRight = x0 + core < srcW;
    const hasBottom = y0 + core < srcH;
    for (let dy = 0; dy < destH; dy++) {
      const oy = destY + dy;
      if (oy >= outH) {
        break;
      }
      const wTop = hasTop ? Math.min((oy - destY + 1) / feather, 1) : 1;
      const wBottom = hasBottom ? Math.min((destY + destH - oy) / feather, 1) : 1;
      for (let dx = 0; dx < destW; dx++) {
        const ox = destX + dx;
        if (ox >= outW) {
          break;
        }
        const wLeft = hasLeft ? Math.min((ox - destX + 1) / feather, 1) : 1;
        const wRight = hasRight ? Math.min((destX + destW - ox) / feather, 1) : 1;
        const w = wLeft * wRight * wTop * wBottom;
        const dstIdx = (oy * outW + ox) * 4;
        const srcIdx = (dy * tile.width + dx) * 4;
        if (!this.#isWritten(written, oy * outW + ox)) {
          out[dstIdx] = tile.data[srcIdx];
          out[dstIdx + 1] = tile.data[srcIdx + 1];
          out[dstIdx + 2] = tile.data[srcIdx + 2];
          out[dstIdx + 3] = tile.data[srcIdx + 3];
          this.#markWritten(written, oy * outW + ox);
          continue;
        }
        if (w >= 1) {
          out[dstIdx] = tile.data[srcIdx];
          out[dstIdx + 1] = tile.data[srcIdx + 1];
          out[dstIdx + 2] = tile.data[srcIdx + 2];
          out[dstIdx + 3] = tile.data[srcIdx + 3];
          continue;
        }
        out[dstIdx] = Math.round(tile.data[srcIdx] * w + out[dstIdx] * (1 - w));
        out[dstIdx + 1] = Math.round(tile.data[srcIdx + 1] * w + out[dstIdx + 1] * (1 - w));
        out[dstIdx + 2] = Math.round(tile.data[srcIdx + 2] * w + out[dstIdx + 2] * (1 - w));
        out[dstIdx + 3] = Math.round(tile.data[srcIdx + 3] * w + out[dstIdx + 3] * (1 - w));
      }
    }
  }
  #isWritten(bits, px) {
    return (bits[px >> 3] & 1 << (px & 7)) !== 0;
  }
  #markWritten(bits, px) {
    bits[px >> 3] = bits[px >> 3] | 1 << (px & 7);
  }
};

// src/worker.ts
var wasmReady = null;
function initWasm() {
  wasmReady ??= __wbg_init().then(() => void 0);
  return wasmReady;
}
var capabilities = null;
async function getCapabilities() {
  capabilities ??= await new DeviceRouter().getCapabilities();
  return capabilities;
}
var state = null;
var currentId = 0;
function getState() {
  if (!state) {
    const model = new ModelManager({
      onDownloadProgress: (progress) => emit({ kind: "model_download", id: currentId, progress }),
      onFallback: (reason) => emit({ kind: "fallback", id: currentId, reason })
    });
    const tiles = new TileProcessor(
      (tileIndex, totalTiles) => emit({ kind: "tile_processing", id: currentId, tileIndex, totalTiles })
    );
    state = { model, tiles };
  }
  return state;
}
function emit(message) {
  self.postMessage(message);
}
function toImageData(bytes, width, height) {
  return new ImageData(
    new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width,
    height
  );
}
async function runClassical(image, method, scale, format, quality) {
  await initWasm();
  let job = null;
  try {
    job = new WasmScalerJob(
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width,
      image.height,
      scale,
      method === "lanczos"
    );
    job.process();
    const outBytes = job.take_output();
    const out = toImageData(outBytes, Math.round(image.width * scale), Math.round(image.height * scale));
    return await Codec.encode(out, format, quality);
  } finally {
    job?.free();
  }
}
async function runNeural(image, scale, format, quality) {
  const { model, tiles } = getState();
  if (!model.isLoaded) {
    throw new UpscalerError(
      "MODEL_NOT_LOADED",
      'process({ method: "neural" }) requires a prior loadModel() call \u2014 the engine never downloads the model implicitly.',
      { recoverable: true }
    );
  }
  const outW4 = image.width * 4;
  const outH4 = image.height * 4;
  if (outW4 > maxDimensionOf() || outH4 > maxDimensionOf()) {
    throw new UpscalerError(
      "DIMENSION_LIMIT",
      `Neural 4x intermediate ${outW4}x${outH4} exceeds maxDimension. Reduce the input size or raise maxDimension.`,
      { recoverable: false }
    );
  }
  const upscaled = await tiles.processNeural(image, await getCapabilities(), model);
  if (scale === 2) {
    await initWasm();
    let job = null;
    try {
      job = new WasmScalerJob(
        new Uint8Array(upscaled.data.buffer, upscaled.data.byteOffset, upscaled.data.byteLength),
        upscaled.width,
        upscaled.height,
        0.5,
        true
      );
      job.process();
      const outBytes = job.take_output();
      const down = toImageData(outBytes, upscaled.width >> 1, upscaled.height >> 1);
      return await Codec.encode(down, format, quality);
    } finally {
      job?.free();
    }
  }
  return Codec.encode(upscaled, format, quality);
}
var runningMaxDimension = Number.POSITIVE_INFINITY;
function maxDimensionOf() {
  return runningMaxDimension;
}
async function runProcess(message) {
  const image = await Codec.decode(message.buffer);
  if (image.width > message.maxDimension || image.height > message.maxDimension) {
    throw new UpscalerError(
      "DIMENSION_LIMIT",
      `Input ${image.width}x${image.height} exceeds maxDimension ${message.maxDimension} (default 16384).`,
      { recoverable: false }
    );
  }
  switch (message.method) {
    case "lanczos":
    case "bicubic":
      emit({ kind: "tile_processing", id: currentId, tileIndex: 0, totalTiles: 1 });
      return runClassical(image, message.method, message.scale, message.format, message.quality);
    case "neural":
      runningMaxDimension = message.maxDimension;
      return runNeural(image, message.scale, message.format, message.quality);
  }
}
async function handle(message) {
  switch (message.kind) {
    case "load-model": {
      const caps = await getCapabilities();
      await getState().model.loadModel(message.modelUrl, message.quantization, caps, message.ortWasmPaths);
      emit({ kind: "ready", id: message.id });
      return;
    }
    case "process": {
      const blob = await runProcess(message);
      emit({ kind: "done", id: message.id, blob });
      return;
    }
  }
}
self.onmessage = (event) => {
  const message = event.data;
  currentId = message.id;
  void handle(message).catch(() => void 0);
};
//# sourceMappingURL=worker.js.map