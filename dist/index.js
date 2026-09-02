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
    const wasm = typeof WebAssembly === "object";
    const wasmThreads = wasm && isCrossOriginIsolated() && typeof SharedArrayBuffer === "function";
    return { webgpu, wasm, wasmThreads, lowVram };
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

// src/WorkerController.ts
var WorkerController = class {
  #callbacks;
  #timeout;
  #worker = null;
  #nextId = 1;
  #pending = null;
  constructor(callbacks, timeout) {
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new UpscalerError("INVALID_INPUT", `timeout must be a positive number of milliseconds, got ${timeout}.`);
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
      clearTimeout(pending.timer);
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
      const pending = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => this.#onTimeout(id), this.#timeout)
      };
      this.#pending = pending;
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
    if (!this.#pending || message.id !== this.#pending.id) {
      return;
    }
    switch (message.kind) {
      case "model_download":
      case "tile_processing":
      case "fallback":
        this.#callbacks.onEvent(message);
        return;
      case "ready":
        this.#settle(message.id, { variant: message.variant, url: message.url, cached: message.cached });
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
  #onTimeout(id) {
    const pending = this.#pending;
    if (!pending || pending.id !== id) {
      return;
    }
    this.#killWorker();
    const error = upscalerErrorFromWire(
      "TIMEOUT",
      `Operation timed out after ${this.#timeout} ms and the worker was terminated. If the input is very large, raise the timeout or lower the input size.`,
      false
    );
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
    clearTimeout(pending.timer);
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
var VALID_QUANTIZATIONS = ["fp32", "fp16", "int8"];
var VALID_METHODS = ["lanczos", "bicubic", "neural"];
var VALID_FORMATS = ["image/png", "image/webp"];
var UpscalerEngine = class {
  #events = new EventEmitter();
  #device = new DeviceRouter();
  #config;
  #controller;
  #capabilities = null;
  #modelLoaded = false;
  #destroyed = false;
  constructor(config = {}) {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxDimension = config.maxDimension ?? DEFAULT_MAX_DIMENSION;
    const quantization = config.quantization ?? DEFAULT_QUANTIZATION;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new UpscalerError("INVALID_INPUT", `config.timeout must be a positive number (ms), got ${String(timeout)}.`);
    }
    if (!Number.isInteger(maxDimension) || maxDimension <= 0) {
      throw new UpscalerError("INVALID_INPUT", `config.maxDimension must be a positive integer, got ${String(maxDimension)}.`);
    }
    if (!VALID_QUANTIZATIONS.includes(quantization)) {
      throw new UpscalerError("INVALID_INPUT", `config.quantization must be one of ${VALID_QUANTIZATIONS.join(", ")}, got ${String(quantization)}.`);
    }
    this.#config = { ...config, timeout, maxDimension, quantization };
    this.#controller = new WorkerController(
      {
        onEvent: (event) => this.#forwardWorkerEvent(event),
        onWorkerDied: () => {
          this.#modelLoaded = false;
        }
      },
      timeout
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
   * Probes (and memoizes) hardware capabilities: WebGPU adapter presence
   * (honest `requestAdapter()` probe), WASM availability, WASM threading
   * (cross-origin isolation), and the conservative lowVram hint.
   */
  async detectDevice() {
    this.#assertAlive();
    if (!this.#capabilities) {
      this.#capabilities = await this.#device.getCapabilities();
    }
    return this.#capabilities;
  }
  /**
   * Downloads (cache-first) the selected model and creates the ORT session.
   * Consumer-triggered ONLY — call this after the user has consented to the
   * download (Two-Gate flow). Emits `model_download` progress while
   * streaming; emits nothing and reports `cached: true` on cache hits.
   *
   * Catalog path: selection happens HERE against freshly probed hardware —
   * `capabilities.webgpu && models.webgpu` → the webgpu variant; else
   * `models.wasm` (missing variant ⇒ typed `MODEL_VARIANT_MISSING` error).
   * The returned {@link LoadModelResult}-shaped object reports which variant
   * and URL were selected; callers that ignore it are unaffected.
   */
  async loadModel() {
    this.#assertAlive();
    if (this.#config.models && this.#config.modelUrl) {
      throw new UpscalerError(
        "INVALID_INPUT",
        "Pass EITHER modelUrl OR models \u2014 the models catalog takes precedence, so a simultaneously configured modelUrl is almost certainly a mistake.",
        { recoverable: true }
      );
    }
    const capabilities = await this.detectDevice();
    let result;
    try {
      result = await this.#controller.loadModel({
        // Simple path: expand dir-style URL here (quantization is an
        // engine-config concern). Catalog URLs are used verbatim.
        modelUrl: this.#config.modelUrl ? this.#resolveModelUrl() : void 0,
        models: this.#config.models,
        capabilities,
        ortWasmPaths: this.#config.ortWasmPaths
      });
    } catch (err) {
      throw this.#asEmitted(err);
    }
    this.#modelLoaded = true;
    return result;
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
    const capabilities = await this.detectDevice();
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
    this.#capabilities = null;
    this.#events.clear();
  }
  #assertAlive() {
    if (this.#destroyed) {
      throw new UpscalerError("DESTROYED", "This UpscalerEngine instance has been destroyed. Create a new instance.", {
        recoverable: false
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
        this.#events.emit({ type: "tile_processing", tileIndex: event.tileIndex, totalTiles: event.totalTiles });
        return;
      case "fallback":
        this.#events.emit({
          type: "fallback",
          from: "webgpu",
          to: "wasm",
          reason: event.swappedTo === "wasm-variant" ? `${event.reason} (swapped to the wasm variant)` : event.reason
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

// src/ModelSelection.ts
function selectModelVariant(catalog, capabilities) {
  if (capabilities.webgpu && catalog.webgpu) {
    return {
      variant: "webgpu",
      url: catalog.webgpu,
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
export {
  DeviceRouter,
  EventEmitter,
  UpscalerEngine,
  UpscalerError,
  selectModelVariant
};
//# sourceMappingURL=index.js.map