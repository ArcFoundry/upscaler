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
var TileProcessor = class {
  #onTile;
  constructor(onTile) {
    this.#onTile = onTile;
  }
  /**
   * Processes `image` with the tiled Real-ESRGAN pipeline at the model's
   * fixed 4x. Returns the full upscaled image. One `tile_processing`
   * notification fires PER COMPLETED TILE with its duration and the running
   * ETA (average over completed tiles × remaining ÷ concurrency).
   */
  async processNeural(image, capabilities, model) {
    const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
    const { tileSize, overlap, concurrency } = tilePolicyFor(capabilities, hw);
    const core = tileSize - 2 * overlap;
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
    const durations = [];
    const emitComplete = (index, durationMs) => {
      durations.push(durationMs);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const remaining = total - durations.length;
      this.#onTile({
        tileIndex: index,
        totalTiles: total,
        tileDurationMs: Math.round(durationMs),
        etaMs: remaining > 0 ? Math.round(avg * remaining / concurrency) : 0
      });
    };
    const worker = async () => {
      for (; ; ) {
        const i = next++;
        if (i >= jobs.length) {
          return;
        }
        const job = jobs[i];
        const t0 = performance.now();
        const tile = this.#extractTile(image, job.x0, job.y0, tileSize, overlap);
        const upscaled = await this.#inferTile(tile, model);
        this.#composite(out, written, upscaled, job.x0, job.y0, W, H, core, scale, overlap);
        emitComplete(job.index, performance.now() - t0);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    return new ImageData(out, outW, outH);
  }
  /**
   * Extracts a `tileSize × tileSize` source rect centered on the core at
   * (`x0`, `y0`), with `overlap` context on interior sides, clamped to the
   * image. Interior edges keep full context; image-border edges are clamped
   * away (no fabricated pixels).
   */
  #extractTile(image, x0, y0, tileSize, overlap) {
    const rectX = Math.max(0, x0 - overlap);
    const rectY = Math.max(0, y0 - overlap);
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
  /**
   * Runs one tile through the model. Tensor marshaling lives in
   * ModelManager (export-true dtype, alpha restored there); this method
   * only feeds and reads tiles.
   */
  async #inferTile(tile, model) {
    return model.run(tile);
  }
  /**
   * Blends one upscaled tile into the output (see class doc for the
   * first-write / cross-fade rule and the feather weights).
   */
  #composite(out, written, tile, x0, y0, srcW, srcH, core, scale, overlap) {
    const outW = srcW * scale;
    const outH = srcH * scale;
    const rectX = Math.max(0, x0 - overlap);
    const rectY = Math.max(0, y0 - overlap);
    const rectW = Math.min(tile.width, srcW - rectX);
    const rectH = Math.min(tile.height, srcH - rectY);
    const destX = rectX * scale;
    const destY = rectY * scale;
    const destW = rectW * scale;
    const destH = rectH * scale;
    const feather = overlap * scale;
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
var state = null;
var currentId = 0;
function getState() {
  if (!state) {
    const model = new ModelManager({
      onDownloadProgress: (progress) => emit({ kind: "model_download", id: currentId, progress }),
      onFallback: (reason, swappedTo) => emit({ kind: "fallback", id: currentId, reason, swappedTo })
    });
    const tiles = new TileProcessor(
      (info) => emit({
        kind: "tile_processing",
        id: currentId,
        tileIndex: info.tileIndex,
        totalTiles: info.totalTiles,
        ...info.tileDurationMs !== void 0 ? { tileDurationMs: info.tileDurationMs } : {},
        ...info.etaMs !== void 0 ? { etaMs: info.etaMs } : {}
      })
    );
    state = { model, tiles };
  }
  return state;
}
function emit(message) {
  self.postMessage(message);
}
var HEARTBEAT_MS = 1e4;
var heartbeatTimer = null;
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => emit({ kind: "heartbeat", id: currentId }), HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
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
async function runNeural(image, scale, format, capabilities, quality) {
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
  const upscaled = await tiles.processNeural(image, capabilities, model);
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
    case "bicubic": {
      const t0 = performance.now();
      const blob = await runClassical(image, message.method, message.scale, message.format, message.quality);
      emit({
        kind: "tile_processing",
        id: currentId,
        tileIndex: 0,
        totalTiles: 1,
        tileDurationMs: Math.round(performance.now() - t0)
      });
      return blob;
    }
    case "neural": {
      runningMaxDimension = message.maxDimension;
      return runNeural(image, message.scale, message.format, message.capabilities, message.quality);
    }
  }
}
async function handle(message) {
  switch (message.kind) {
    case "load-model": {
      const result = await getState().model.loadModel({
        modelUrl: message.modelUrl,
        models: message.models,
        capabilities: message.capabilities,
        ortWasmPaths: message.ortWasmPaths,
        ...message.forceReload ? { forceReload: true } : {}
      });
      emit({ kind: "ready", id: message.id, ...result });
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
  startHeartbeat();
  void handle(message).catch((err) => {
    const upscalerError = err instanceof UpscalerError ? err : null;
    emit({
      kind: "error",
      id: currentId,
      code: upscalerError?.code ?? "WORKER_FAILED",
      message: upscalerError?.message ?? (err instanceof Error ? err.message : String(err)),
      recoverable: upscalerError?.recoverable ?? false
    });
  }).finally(() => stopHeartbeat());
};
//# sourceMappingURL=worker.js.map