/**
 * Typed error type shared by the engine surface. Every rejection thrown by
 * the engine is an {@link UpscalerError}; every error surfaced through the
 * `error` event carries the same `code`-derived message.
 */

export type UpscalerErrorCode =
  /** loadModel() called without a configured modelUrl. */
  | 'MODEL_URL_REQUIRED'
  /** process({ method: 'neural' }) called before loadModel(). */
  | 'MODEL_NOT_LOADED'
  /** The model file could not be fetched from the configured URL. */
  | 'MODEL_DOWNLOAD_FAILED'
  /** process() was called with a scale other than 2 or 4. */
  | 'INVALID_SCALE'
  /** process() was called with an unknown method. */
  | 'INVALID_METHOD'
  /** Malformed or unusable input buffer (empty/detached, bad quality). */
  | 'INVALID_INPUT'
  /** Input image exceeds the configured maxDimension. */
  | 'DIMENSION_LIMIT'
  /** The operation exceeded the configured timeout; the worker was killed. */
  | 'TIMEOUT'
  /** A Rust/WASM scaler failed (e.g. OOM on a huge image). */
  | 'WASM_SCALER_FAILED'
  /** Neural inference failed and could not be recovered by fallback. */
  | 'INFERENCE_FAILED'
  /** The input could not be decoded into pixels in the worker. */
  | 'DECODE_FAILED'
  /** The result could not be encoded into a Blob in the worker. */
  | 'ENCODE_FAILED'
  /** The Web Worker crashed (uncaught error, message serialization). */
  | 'WORKER_FAILED'
  /** Another operation is already running; the engine processes serially. */
  | 'BUSY'
  /** destroy() was called; the engine instance can no longer be used. */
  | 'DESTROYED';

export interface UpscalerErrorOptions {
  /**
   * true when the consumer may retry (possibly after fixing input or calling
   * loadModel()). Defaults to false (terminal failure).
   */
  recoverable?: boolean;
  cause?: unknown;
}

export class UpscalerError extends Error {
  readonly code: UpscalerErrorCode;
  readonly recoverable: boolean;
  /**
   * true when the error was already emitted on the engine's `error` event
   * (worker → WorkerController → event). The engine uses this to emit every
   * failure exactly once while still rejecting the operation's promise.
   */
  forwarded: boolean = false;

  constructor(code: UpscalerErrorCode, message: string, options: UpscalerErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UpscalerError';
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
}

/** Rebuilds an {@link UpscalerError} from its wire form (worker → main). */
export function upscalerErrorFromWire(code: UpscalerErrorCode, message: string, recoverable: boolean): UpscalerError {
  const err = new UpscalerError(code, message, { recoverable });
  err.forwarded = true;
  return err;
}

/** Normalizes any thrown value into an {@link UpscalerError}. */
export function toUpscalerError(code: UpscalerErrorCode, message: string, err: unknown, recoverable = false): UpscalerError {
  if (err instanceof UpscalerError) {
    return err;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new UpscalerError(code, `${message}: ${detail}`, { recoverable, cause: err });
}
