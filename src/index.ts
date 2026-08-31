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

import { DeviceRouter, type Capabilities } from './DeviceRouter.js';
import { EventEmitter, type UpscalerEvent, type UpscalerEventListener, type UpscalerEventType } from './EventEmitter.js';
import { UpscalerError, type UpscalerErrorCode } from './errors.js';
import type { Quantization } from './ModelManager.js';
import { UpscalerEngine } from './UpscalerEngine.js';
import type { Method } from './WorkerController.js';

// ——— Public surface ————————————————————————————————————————————————
export { UpscalerEngine };
export { DeviceRouter };
export { EventEmitter };
export { UpscalerError };

export type {
  Capabilities,
  UpscalerEvent,
  UpscalerEventType,
  UpscalerEventListener,
  UpscalerErrorCode,
  Quantization,
  Method,
};

// The configuration and options interfaces are declared in UpscalerEngine.ts
// and re-exported here under their canonical names.
export type { UpscalerEngineConfig, ProcessOptions } from './UpscalerEngine.js';
