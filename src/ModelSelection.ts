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
}

/**
 * Selects the variant to load. `capabilities.webgpu && catalog.webgpu` →
 * the webgpu variant; otherwise `catalog.wasm`. A missing variant throws a
 * typed, descriptive error naming exactly what is absent.
 */
export function selectModelVariant(catalog: ModelCatalog, capabilities: Pick<Capabilities, 'webgpu'>): ModelSelection {
  if (capabilities.webgpu && catalog.webgpu) {
    return {
      variant: 'webgpu',
      url: catalog.webgpu,
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
