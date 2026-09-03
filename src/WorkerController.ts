/**
 * Spawns and controls the engine's Web Worker. Runs on the MAIN THREAD only.
 *
 * The worker is referenced as the COMPILED `./worker.js` next to this bundle
 * (`src/worker.ts` is a separate tsup entry producing `dist/worker.js`), so
 * no in-browser TypeScript compilation is ever needed.
 *
 * Protocol: one operation at a time (`load-model` or `process`), each with
 * v0.3.0 timeout semantics — an INACTIVITY timeout reset by every worker
 * message (progress/fallback/heartbeat) for the operation, plus an optional
 * absolute `hardTimeoutMs` cap. A progressing worker is never killed by the
 * idle limit; a silent worker dies with the same TIMEOUT error as before.
 * Every request carries an id; the worker answers with
 * progress/fallback/heartbeat events, then exactly one terminal
 * `ready`/`done`/`error`. Image bytes cross the boundary as zero-copy
 * transferables.
 */

import type { OutputFormat } from './Codec.js';
import type { Capabilities } from './DeviceRouter.js';
import { UpscalerError, upscalerErrorFromWire, type UpscalerErrorCode } from './errors.js';
import { TimeoutGovernor, type TimeoutExpireReason } from './Timeouts.js';

/** The processing methods the engine supports. */
export type Method = 'lanczos' | 'bicubic' | 'neural';

export interface LoadModelParams {
  /** Simple path (mutually exclusive with `models`). */
  modelUrl?: string;
  /** Catalog path: capability-aware variants; selection happens in the worker. */
  models?: { webgpu?: string; wasm?: string };
  capabilities: Capabilities;
  ortWasmPaths?: string;
  /** Rebuild the session even when the selected URL is unchanged (GPU picker). */
  forceReload?: boolean;
}

export interface ProcessParams {
  /** Transferable image bytes; detached after postMessage (zero-copy). */
  buffer: ArrayBuffer;
  method: Method;
  scale: 2 | 4;
  format: OutputFormat;
  quality?: number;
  capabilities: Capabilities;
  maxDimension: number;
}

export type WorkerRequest =
  | ({ id: number; kind: 'load-model' } & LoadModelParams)
  | ({ id: number; kind: 'process' } & ProcessParams);

/**
 * Internal main↔worker protocol. NOT the public event union (that is frozen;
 * see EventEmitter.ts) — these fields are plumbing.
 */
export type WorkerResponse =
  | { kind: 'heartbeat'; id: number }
  | { kind: 'model_download'; id: number; progress: number }
  | { kind: 'tile_processing'; id: number; tileIndex: number; totalTiles: number; tileDurationMs?: number; etaMs?: number }
  | { kind: 'fallback'; id: number; reason: string; swappedTo?: 'wasm-variant' | 'same-file' }
  | {
      kind: 'ready';
      id: number;
      variant: 'webgpu' | 'wasm';
      url: string;
      cached: boolean;
      reason?: string;
      requestedEp: 'webgpu' | 'wasm';
      actualEp: 'webgpu' | 'wasm';
    }
  | { kind: 'done'; id: number; blob: Blob }
  | { kind: 'error'; id: number; code: UpscalerErrorCode; message: string; recoverable: boolean };

/** Events the engine re-emits; lifecycle results and heartbeats stay internal. */
export type ForwardableWorkerEvent = Extract<
  WorkerResponse,
  { kind: 'model_download' | 'tile_processing' | 'fallback' | 'error' }
>;

export interface WorkerControllerCallbacks {
  /** Progress, fallback and error events, for the engine to re-emit. */
  onEvent(event: ForwardableWorkerEvent): void;
  /** Called after the worker is terminated or crashes (session state lost). */
  onWorkerDied(): void;
}

export interface WorkerTimeoutOptions {
  /** INACTIVITY limit in ms — reset by every worker message for the op. */
  idleMs: number;
  /** Optional absolute cap overriding idle logic. Undefined = disabled. */
  hardMs?: number;
}

interface Pending {
  id: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  governor: TimeoutGovernor;
}

export class WorkerController {
  readonly #callbacks: WorkerControllerCallbacks;
  readonly #timeout: WorkerTimeoutOptions;
  #worker: Worker | null = null;
  #nextId = 1;
  #pending: Pending | null = null;

  constructor(callbacks: WorkerControllerCallbacks, timeout: WorkerTimeoutOptions) {
    if (!Number.isFinite(timeout.idleMs) || timeout.idleMs <= 0) {
      throw new UpscalerError('INVALID_INPUT', `idle timeout must be a positive number of milliseconds, got ${timeout.idleMs}.`);
    }
    if (timeout.hardMs !== undefined && (!Number.isFinite(timeout.hardMs) || timeout.hardMs <= 0)) {
      throw new UpscalerError('INVALID_INPUT', `hardTimeoutMs must be a positive number of milliseconds or undefined, got ${String(timeout.hardMs)}.`);
    }
    this.#callbacks = callbacks;
    this.#timeout = timeout;
  }

  /** True while a load-model/process operation is in flight. */
  get busy(): boolean {
    return this.#pending !== null;
  }

  loadModel(params: LoadModelParams): Promise<{
    variant: 'webgpu' | 'wasm';
    url: string;
    cached: boolean;
    reason?: string;
    requestedEp: 'webgpu' | 'wasm';
    actualEp: 'webgpu' | 'wasm';
  }> {
    return this.#run((id) => [{ id, kind: 'load-model', ...params }, [] as Transferable[]]) as Promise<{
      variant: 'webgpu' | 'wasm';
      url: string;
      cached: boolean;
      reason?: string;
      requestedEp: 'webgpu' | 'wasm';
      actualEp: 'webgpu' | 'wasm';
    }>;
  }

  process(params: ProcessParams): Promise<Blob> {
    return this.#run((id) => {
      if (params.buffer.byteLength === 0) {
        throw new UpscalerError(
          'INVALID_INPUT',
          'Input ArrayBuffer is empty or already detached (it may have been transferred by a previous process() call).',
          { recoverable: true },
        );
      }
      return [{ id, kind: 'process', ...params }, [params.buffer]];
    }) as Promise<Blob>;
  }

  /**
   * Terminates the worker. This reclaims EVERYTHING the worker owned in one
   * stroke — the ORT session and the WASM (scaler + model) memory all live
   * in the worker's heap and are freed when it dies.
   */
  dispose(): void {
    if (this.#pending) {
      const pending = this.#pending;
      pending.governor.stop();
      this.#pending = null;
      pending.reject(
        new UpscalerError('DESTROYED', 'The engine was destroyed while an operation was in progress.', {
          recoverable: false,
        }),
      );
    }
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
  }

  #run(build: (id: number) => [WorkerRequest, Transferable[]]): Promise<unknown> {
    if (this.#pending) {
      return Promise.reject(
        new UpscalerError(
          'BUSY',
          'The engine is already processing an operation; it handles one at a time. Wait for the current promise to settle.',
          { recoverable: true },
        ),
      );
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const governor = new TimeoutGovernor({
        idleMs: this.#timeout.idleMs,
        hardMs: this.#timeout.hardMs,
        onExpire: (reason) => this.#onTimeout(id, reason),
      });
      const pending: Pending = { id, resolve, reject, governor };
      this.#pending = pending;
      governor.start();
      let worker: Worker;
      try {
        worker = this.#ensureWorker();
        const [message, transfer] = build(id);
        worker.postMessage(message, transfer);
      } catch (err) {
        // #ensureWorker can fail if the environment forbids workers; postMessage
        // can fail if the transfer list is invalid. Surface either as input err.
        const error =
          err instanceof UpscalerError
            ? err
            : new UpscalerError('WORKER_FAILED', `Could not dispatch work to the worker: ${String(err)}.`, {
                recoverable: false,
                cause: err,
              });
        this.#settle(id, undefined, error);
      }
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker) {
      return this.#worker;
    }
    // COMPILED worker, referenced relatively to this bundle — never the .ts source.
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.#onMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      this.#onCrash(`worker crashed: ${event.message || 'uncaught error'}`);
    };
    worker.onmessageerror = () => {
      this.#onCrash('worker message could not be deserialized');
    };
    this.#worker = worker;
    return worker;
  }

  #onMessage(message: WorkerResponse): void {
    // ANY message for the pending operation is proof of life — reset the
    // idle timer before anything else (v0.3.0 timeout semantics).
    if (this.#pending && message.id === this.#pending.id) {
      this.#pending.governor.poke();
    }
    if (!this.#pending || message.id !== this.#pending.id) {
      return; // stale response from a previous (timed-out) operation
    }
    switch (message.kind) {
      case 'heartbeat':
        return; // proof of life only — not forwarded, not the public union
      case 'model_download':
      case 'tile_processing':
      case 'fallback':
        this.#callbacks.onEvent(message);
        return;
      case 'ready':
        this.#settle(message.id, {
          variant: message.variant,
          url: message.url,
          cached: message.cached,
          ...(message.reason !== undefined ? { reason: message.reason } : {}),
          requestedEp: message.requestedEp,
          actualEp: message.actualEp,
        });
        return;
      case 'done':
        this.#settle(message.id, message.blob);
        return;
      case 'error':
        this.#callbacks.onEvent(message);
        this.#settle(message.id, undefined, upscalerErrorFromWire(message.code, message.message, message.recoverable));
        return;
    }
  }

  #onTimeout(id: number, reason: TimeoutExpireReason): void {
    const pending = this.#pending;
    if (!pending || pending.id !== id) {
      return;
    }
    this.#killWorker();
    const message =
      reason === 'hard'
        ? `Operation exceeded the absolute hardTimeoutMs cap (${this.#timeout.hardMs} ms) and the worker was terminated, despite making progress. Raise hardTimeoutMs or reduce the input size.`
        : `No worker activity for ${this.#timeout.idleMs} ms (inactivity timeout) and the worker was terminated. ` +
          'If a single inference step is legitimately slower than this, raise the timeout — progress resets it.';
    const error = upscalerErrorFromWire('TIMEOUT', message, false);
    this.#callbacks.onEvent({ kind: 'error', id, code: 'TIMEOUT', message: error.message, recoverable: false });
    this.#settle(id, undefined, error);
  }

  #onCrash(message: string): void {
    const pending = this.#pending;
    this.#killWorker();
    const error = upscalerErrorFromWire('WORKER_FAILED', message, false);
    this.#callbacks.onEvent({
      kind: 'error',
      id: pending?.id ?? -1,
      code: 'WORKER_FAILED',
      message,
      recoverable: false,
    });
    if (pending) {
      this.#settle(pending.id, undefined, error);
    }
  }

  #killWorker(): void {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
      this.#callbacks.onWorkerDied();
    }
  }

  #settle(id: number, value: unknown, error?: Error): void {
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
}
