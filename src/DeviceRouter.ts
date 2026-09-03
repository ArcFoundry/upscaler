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
export interface AdapterInfoSummary {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

/** Coarse compute-performance tier. HEURISTIC — see `classifyGpuTier`. */
export type GpuTier = 'software' | 'entry' | 'mid' | 'high';

/** Adapter preference for the compute probe. Default 'high-performance'. */
export type GpuPreference = 'high-performance' | 'low-power' | 'default';

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
  // ——— v0.3.0: additive optional fields (old consumers compile unchanged) ——
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

interface NavigatorWithProbes {
  gpu?: {
    requestAdapter(options?: GPURequestAdapterOptions): Promise<MinimalGPUAdapter | null>;
  };
  deviceMemory?: number;
}

interface GPUAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface MinimalGPUAdapter {
  info?: GPUAdapterInfoLike;
  limits?: { maxTextureDimension2D?: number; maxBufferSize?: number };
  requestAdapterInfo?: () => Promise<GPUAdapterInfoLike>;
}

type GPURequestAdapterOptions = { powerPreference?: 'low-power' | 'high-performance' };

function isSecure(): boolean {
  return typeof isSecureContext !== 'undefined' && isSecureContext;
}

function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

/**
 * Reads adapter identity: `adapter.info` is a sync property on current
 * Chrome; `requestAdapterInfo()` is the legacy async fallback. Returns null
 * when neither exists (nothing is invented).
 */
export async function readAdapterInfo(adapter: MinimalGPUAdapter): Promise<AdapterInfoSummary | null> {
  const pick = (info: GPUAdapterInfoLike): AdapterInfoSummary => ({
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
  });
  const sync = adapter.info;
  if (sync && typeof sync === 'object') {
    return pick(sync);
  }
  if (typeof adapter.requestAdapterInfo === 'function') {
    try {
      return pick(await adapter.requestAdapterInfo());
    } catch {
      return null;
    }
  }
  return null;
}

/** Stable comparison key for "did two probes return the same adapter". */
export function adapterInfoKey(info: AdapterInfoSummary | null): string {
  if (!info) {
    return '';
  }
  return [info.vendor, info.architecture, info.device, info.description].join('|').toLowerCase();
}

const SOFTWARE_GPU_PATTERN = /swiftshader|lavapipe|llvmpipe|software|basic render/i;

/**
 * Software-rasterizer detection from raw adapter info. Pure; exported for
 * tests. Matching is deliberately on the JOINED info string — vendors put
 * the tell-tale in different fields (description vs architecture).
 */
export function isSoftwareGpuInfo(info: AdapterInfoSummary | null | undefined): boolean {
  if (!info) {
    return false;
  }
  return SOFTWARE_GPU_PATTERN.test([info.vendor, info.architecture, info.device, info.description].join(' '));
}

/** Advisory neural input ceiling (megapixels) per tier. Heuristic, surfaced via getDiagnostics(). */
export const TIER_NEURAL_MEGAPIXELS: Readonly<Record<GpuTier, number>> = {
  software: 0.5,
  entry: 1,
  mid: 4,
  high: 12,
};

const DGPU_PATTERN = /(rtx|radeon pro|geforce|quadro|arc (a|graphics)|rx \d{3,}|apple m\d+ (pro|max|ultra))/i;
const IGPU_PATTERN = /(uhd|iris|xe graphics|mali|adreno|apple m\d+$|intel\(r\).*graphics)/i;

export interface GpuTierInput {
  info: AdapterInfoSummary | null;
  softwareGpu: boolean;
  /** navigator.deviceMemory (GiB), Chromium-only — undefined elsewhere. */
  deviceMemory?: number;
  limits?: { maxTextureDimension2D?: number; maxBufferSize?: number };
}

/**
 * Tier heuristic — LABELED AS SUCH everywhere it surfaces; the raw adapter
 * string is always available beside it. Inputs: the software flag, iGPU /
 * dGPU name patterns, deviceMemory, adapter limits. Unknown ⇒ 'entry'
 * (conservative: smaller tiles, lower concurrency). Pure; exported for tests.
 */
export function classifyGpuTier(input: GpuTierInput): GpuTier {
  if (input.softwareGpu) {
    return 'software';
  }
  const text = input.info ? [input.info.vendor, input.info.architecture, input.info.device, input.info.description].join(' ') : '';
  const memory = typeof input.deviceMemory === 'number' ? input.deviceMemory : undefined;
  // NOTE: navigator.deviceMemory is SYSTEM RAM (Chromium-only), not VRAM —
  // it nudges, it does not override name patterns.

  let tier: GpuTier;
  if (DGPU_PATTERN.test(text)) {
    tier = memory === undefined || memory > 4 ? 'high' : 'mid';
  } else if (IGPU_PATTERN.test(text)) {
    tier = memory === undefined || memory > 4 ? 'mid' : 'entry';
  } else if ((input.limits?.maxTextureDimension2D ?? 0) >= 8192) {
    // No recognizable name but a full-featured adapter: mid, not optimistic —
    // unless the machine itself is tiny.
    tier = memory !== undefined && memory <= 4 ? 'entry' : 'mid';
  } else {
    tier = 'entry';
  }
  return tier;
}

export class DeviceRouter {
  /** Probes are memoized PER preference (the GPU picker re-probes). */
  #probing = new Map<GpuPreference, Promise<Capabilities>>();
  #capabilities = new Map<GpuPreference, Capabilities>();

  /**
   * Probes (once per preference, then memoizes) the device capabilities.
   * Concurrent calls for the same preference share a single probe.
   * Default preference 'high-performance': a compute engine wants the dGPU.
   */
  getCapabilities(preference: GpuPreference = 'high-performance'): Promise<Capabilities> {
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
  get cached(): Capabilities | null {
    const first = this.#capabilities.values().next();
    return first.done ? null : (first.value ?? null);
  }

  cachedFor(preference: GpuPreference): Capabilities | null {
    return this.#capabilities.get(preference) ?? null;
  }

  async #probe(preference: GpuPreference): Promise<Capabilities> {
    const nav = navigator as Navigator & NavigatorWithProbes;

    // --- WebGPU: real adapter request, never a presence check. -------------
    let webgpu = false;
    let adapterInfo: AdapterInfoSummary | null = null;
    let secondaryAdapterInfo: AdapterInfoSummary | null = null;
    let dualGpu = false;
    let limits: MinimalGPUAdapter['limits'] | undefined;

    if (isSecure() && typeof nav.gpu?.requestAdapter === 'function') {
      let primary: MinimalGPUAdapter | null = null;
      try {
        primary = await nav.gpu.requestAdapter(preference === 'default' ? {} : { powerPreference: preference });
        webgpu = primary != null;
      } catch {
        // Blocklisted GPUs and policy-disabled contexts REJECT. That is a
        // definitive "no WebGPU", not an error to surface.
        webgpu = false;
      }

      if (primary) {
        limits = primary.limits;
        adapterInfo = await readAdapterInfo(primary);

        // Dual-GPU detection: probe with the OPPOSITE preference and compare
        // identities. Same adapter or any probe failure ⇒ single GPU. This
        // two-probe comparison is the only enumeration stable WebGPU offers.
        const opposite: GpuPreference = preference === 'high-performance' ? 'low-power' : 'high-performance';
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

    // --- deviceMemory: undefined on Firefox/Safari → assume low. -----------
    const deviceMemory = nav.deviceMemory;
    const lowVram = typeof deviceMemory !== 'number' || deviceMemory <= 4;

    // --- WASM baseline + threading gate. -----------------------------------
    const wasm = typeof WebAssembly === 'object';
    // Multi-threaded WASM needs SharedArrayBuffer, which browsers only fully
    // enable under cross-origin isolation (COOP/COEP). WebGPU is unaffected.
    const wasmThreads = wasm && isCrossOriginIsolated() && typeof SharedArrayBuffer === 'function';

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
      gpuTier,
    };
  }
}
