/**
 * Framework-agnostic typed event stream for the upscaler engine.
 *
 * No DOM, no framework imports: the engine exposes `on()`/`off()`/`emit()`
 * and the exact event payload union below. All events are also relayed from
 * the Web Worker through {@link import('./WorkerController.js').WorkerController}.
 */

export type ModelDownloadEvent = {
  type: 'model_download';
  /** Download progress in [0, 1]. Never emitted on a cache hit. */
  progress: number;
};

export type TileProcessingEvent = {
  type: 'tile_processing';
  /**
   * Zero-based index of the tile this event reports. v0.3.0: neural events
   * fire when a tile COMPLETES (so duration/ETA refer to it); classical
   * methods fire once, on their single completion step.
   */
  tileIndex: number;
  totalTiles: number;
  /**
   * v0.3.0, additive optional: duration of the tile just completed (ms).
   * The first tile's duration includes model warmup — expected.
   */
  tileDurationMs?: number;
  /**
   * v0.3.0, additive optional: running-average estimate for the remaining
   * tiles (average completed duration × remaining ÷ concurrency), in ms.
   */
  etaMs?: number;
};

export type FallbackEvent = {
  type: 'fallback';
  from: 'webgpu';
  to: 'wasm';
  reason: string;
  /**
   * v0.3.0, additive optional: which file the retrying session uses — the
   * catalog's wasm variant, or the same file when no variant exists.
   */
  swappedTo?: 'wasm-variant' | 'same-file';
};

export type CompleteEvent = {
  type: 'complete';
  /**
   * Object URL of the processed Blob, created by the engine on the main
   * thread. The CONSUMER must call `URL.revokeObjectURL(blobUrl)` when the
   * URL is no longer needed — the engine intentionally does not revoke it
   * because the consumer may still be rendering it.
   */
  blobUrl: string;
};

export type ErrorEvent = {
  type: 'error';
  message: string;
  /**
   * true when the engine itself is still healthy and the consumer may retry
   * (bad input, busy, download failure). false when the failure is terminal
   * for the operation (timeout, dimension limit, unrecovered inference or
   * scaler failure) or for the worker.
   */
  recoverable: boolean;
};

/** The exact event payload union emitted by the engine. */
export type UpscalerEvent =
  | ModelDownloadEvent
  | TileProcessingEvent
  | FallbackEvent
  | CompleteEvent
  | ErrorEvent;

export type UpscalerEventType = UpscalerEvent['type'];

export type UpscalerEventListener<K extends UpscalerEventType> = (
  event: Extract<UpscalerEvent, { type: K }>,
) => void;

type AnyListener = (event: UpscalerEvent) => void;

export class EventEmitter {
  readonly #listeners = new Map<UpscalerEventType, Set<AnyListener>>();

  /**
   * Subscribes to an event type. Returns an unsubscribe function; calling it
   * twice is a no-op.
   */
  on<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set<AnyListener>();
      this.#listeners.set(type, set);
    }
    set.add(handler as AnyListener);
    return () => this.off(type, handler);
  }

  /** Removes a previously subscribed handler. Unknown handlers are ignored. */
  off<K extends UpscalerEventType>(type: K, handler: UpscalerEventListener<K>): void {
    this.#listeners.get(type)?.delete(handler as AnyListener);
  }

  /**
   * Dispatches an event to the current listeners of its type. The listener
   * set is snapshotted, so a handler may subscribe/unsubscribe during
   * dispatch without affecting the in-flight iteration. A throwing listener
   * is reported to the console and never breaks the engine or other listeners.
   */
  emit(event: UpscalerEvent): void {
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
  clear(): void {
    this.#listeners.clear();
  }
}
