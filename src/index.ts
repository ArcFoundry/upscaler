/**
 * @arcfoundry/upscaler — headless, local-first image upscaling engine for
 * the browser. WebGPU neural + Rust/WASM classical. Zero uploads. Zero
 * servers. This is an ENGINE, not an app: no UI framework code, no DOM
 * access, no global state.
 *
 * Main-thread entry. The heavy lifting (decode/encode, tiling, ONNX
 * inference, WASM scalers) happens inside the spawned worker
 * (`dist/worker.js`); {@link UpscalerEngine} owns the event stream, the
 * capability probe, timeouts, and the object-URL lifecycle contract.
 */

import {
  DeviceRouter,
  type AdapterInfoSummary,
  type Capabilities,
  type GpuPreference,
  type GpuTier,
  TIER_NEURAL_MEGAPIXELS,
} from './DeviceRouter.js';
import { EventEmitter, type UpscalerEvent, type UpscalerEventListener, type UpscalerEventType } from './EventEmitter.js';
import { UpscalerError, type UpscalerErrorCode } from './errors.js';
import type { LoadModelResult, Quantization } from './ModelManager.js';
import type { ModelCatalog } from './ModelSelection.js';
import { ModelManager, type SessionFactory } from './ModelManager.js';
import { TimeoutGovernor, type TimeoutExpireReason } from './Timeouts.js';
import { UpscalerEngine, type EngineDiagnostics } from './UpscalerEngine.js';
import type { Method } from './WorkerController.js';

// ——— Public surface ————————————————————————————————————————————————
export { UpscalerEngine };
export { DeviceRouter };
export { EventEmitter };
export { UpscalerError };
/** Timeout policy for one in-flight operation (idle + optional hard cap). */
export { TimeoutGovernor };
/**
 * Model lifecycle manager (cache-first fetch, single-EP session creation,
 * fallback). Advanced consumers may drive it directly; the engine owns one
 * inside its worker.
 */
export { ModelManager };
/** Advisory neural input ceiling (megapixels) per gpu tier. HEURISTIC. */
export { TIER_NEURAL_MEGAPIXELS };
export { classifyGpuTier, isSoftwareGpuInfo, readAdapterInfo, adapterInfoKey } from './DeviceRouter.js';
/** Tier-driven neural compute policy (tile size / overlap / concurrency). */
export { tilePolicyFor, TILE_OVERLAP, HIGH_TIER_OVERLAP } from './TileProcessor.js';
export type { TilePolicy, TileProgressInfo } from './TileProcessor.js';

export type {
  AdapterInfoSummary,
  SessionFactory,
  TimeoutExpireReason,
  Capabilities,
  EngineDiagnostics,
  GpuPreference,
  GpuTier,
  UpscalerEvent,
  UpscalerEventType,
  UpscalerEventListener,
  UpscalerErrorCode,
  Quantization,
  ModelCatalog,
  LoadModelResult,
  Method,
};

// The configuration and options interfaces are declared in UpscalerEngine.ts
// and re-exported here under their canonical names.
export type { UpscalerEngineConfig, ProcessOptions } from './UpscalerEngine.js';

// Pure capability→variant selection (same rules loadModel() applies) — handy
// for showing which variant a consent dialog WOULD fetch, before consent.
export { selectModelVariant } from './ModelSelection.js';
