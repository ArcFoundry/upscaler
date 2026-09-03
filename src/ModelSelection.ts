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

import type { Capabilities } from './DeviceRouter.js';
import { UpscalerError } from './errors.js';

/**
 * Consumer-supplied catalog of precision variants. URLs are used verbatim —
 * no filename synthesis, no default hosts.
 */
export interface ModelCatalog {
  /** Variant for the WebGPU execution provider (typically fp16). */
  webgpu?: string;
  /** Variant for the CPU/WASM execution provider (typically fp32 or int8). */
  wasm?: string;
}

export interface ModelSelection {
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
export function selectModelVariant(
  catalog: ModelCatalog,
  capabilities: Pick<Capabilities, 'webgpu'> & { softwareGpu?: boolean; dualGpu?: boolean },
): ModelSelection {
  if (capabilities.webgpu && catalog.webgpu) {
    if (capabilities.softwareGpu && catalog.wasm) {
      return {
        variant: 'wasm',
        url: catalog.wasm,
        reason:
          'software GPU adapter detected (SwiftShader-like rasterizer) — routed to the wasm variant; the software WebGPU EP would run the same math on the same CPU, slower',
      };
    }
    return {
      variant: 'webgpu',
      url: catalog.webgpu,
      ...(capabilities.softwareGpu
        ? {
            reason:
              'software GPU adapter detected but the catalog has no wasm variant — proceeding on the software WebGPU EP (expect slow inference)',
          }
        : capabilities.dualGpu
          ? { reason: 'dual-GPU device — the high-performance adapter was requested for this compute workload' }
          : {}),
      ...(catalog.wasm && catalog.wasm !== catalog.webgpu ? { wasmFallbackUrl: catalog.wasm } : {}),
    };
  }
  if (catalog.wasm) {
    return { variant: 'wasm', url: catalog.wasm };
  }
  throw new UpscalerError(
    'MODEL_VARIANT_MISSING',
    capabilities.webgpu
      ? 'The models catalog has no "wasm" variant. The WebGPU variant only runs on the WebGPU execution provider; supply models.wasm (a fp32/int8 export) for CPU/WASM execution.'
      : 'No WebGPU adapter was probed and the models catalog has no "wasm" variant. Supply models.wasm (a fp32/int8 export) for CPU/WASM execution.',
    { recoverable: true },
  );
}
