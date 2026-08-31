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
export interface Capabilities {
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

interface NavigatorWithProbes {
  gpu?: {
    requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUSupported | null>;
  };
  deviceMemory?: number;
}

interface MinimalGPUAdapter {
  // Intentionally opaque: existence alone proves the adapter is usable.
}

type GPURequestAdapterOptions = { powerPreference?: 'low-power' | 'high-performance' };
type GPUSupported = MinimalGPUAdapter;

function isSecure(): boolean {
  return typeof isSecureContext !== 'undefined' && isSecureContext;
}

function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

export class DeviceRouter {
  #capabilities: Capabilities | null = null;
  #probing: Promise<Capabilities> | null = null;

  /**
   * Probes (once, then memoizes) the device capabilities. Concurrent calls
   * share a single probe.
   */
  getCapabilities(): Promise<Capabilities> {
    this.#probing ??= this.#probe().then((caps) => {
      this.#capabilities = caps;
      return caps;
    });
    return this.#probing;
  }

  /** Previously memoized capabilities, if a probe already completed. */
  get cached(): Capabilities | null {
    return this.#capabilities;
  }

  async #probe(): Promise<Capabilities> {
    const nav = navigator as Navigator & NavigatorWithProbes;

    // --- WebGPU: real adapter request, never a presence check. -------------
    let webgpu = false;
    if (isSecure() && typeof nav.gpu?.requestAdapter === 'function') {
      try {
        const adapter = await nav.gpu.requestAdapter();
        webgpu = adapter != null;
      } catch {
        // Blocklisted GPUs and policy-disabled contexts REJECT. That is a
        // definitive "no WebGPU", not an error to surface.
        webgpu = false;
      }
    }

    // --- deviceMemory: undefined on Firefox/Safari → assume low. -----------
    const deviceMemory = nav.deviceMemory;
    const lowVram = typeof deviceMemory !== 'number' || deviceMemory <= 4;

    // --- WASM baseline + threading gate. -----------------------------------
    const wasm = typeof WebAssembly === 'object';
    // Multi-threaded WASM needs SharedArrayBuffer, which browsers only fully
    // enable under cross-origin isolation (COOP/COEP). WebGPU is unaffected.
    const wasmThreads = wasm && isCrossOriginIsolated() && typeof SharedArrayBuffer === 'function';

    return { webgpu, wasm, wasmThreads, lowVram };
  }
}
