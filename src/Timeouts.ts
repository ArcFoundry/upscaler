/**
 * Timeout semantics for one in-flight worker operation (v0.3.0 incident fix).
 *
 * v0.2.0 used an ABSOLUTE wall-clock timer: a healthy but slow job (4/25
 * tiles at ~75 s/tile on an iGPU) was killed mid-progress at 300 s. v0.3.0
 * changes the semantics:
 *
 *  - `idleMs` (the engine's `timeout` config) is an INACTIVITY timeout. Any
 *    worker message for the operation (tile progress, download progress,
 *    fallback, heartbeat) resets it. A silent worker dies exactly as before
 *    (same TIMEOUT error shape); a PROGRESSING worker is never killed by it.
 *  - `hardMs` (optional `hardTimeoutMs` config, default disabled) is an
 *    absolute cap that overrides idle logic — for consumers who want a
 *    guaranteed upper bound regardless of progress.
 */

export type TimeoutExpireReason = 'idle' | 'hard';

export interface TimeoutGovernorOptions {
  idleMs: number;
  /** Absolute cap; undefined/0/NaN disables it. */
  hardMs?: number;
  onExpire(reason: TimeoutExpireReason): void;
}

/**
 * Pure timer policy — no worker coupling, so it is unit-testable. One
 * instance per in-flight operation. Not re-startable: create a new one.
 */
export class TimeoutGovernor {
  readonly #idleMs: number;
  readonly #hardMs: number | undefined;
  readonly #onExpire: (reason: TimeoutExpireReason) => void;

  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #hardTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #expiredWith: TimeoutExpireReason | null = null;

  constructor(options: TimeoutGovernorOptions) {
    if (!Number.isFinite(options.idleMs) || options.idleMs <= 0) {
      throw new Error(`TimeoutGovernor: idleMs must be a positive number, got ${String(options.idleMs)}`);
    }
    if (options.hardMs !== undefined && (!Number.isFinite(options.hardMs) || options.hardMs <= 0)) {
      throw new Error(`TimeoutGovernor: hardMs must be a positive number or undefined, got ${String(options.hardMs)}`);
    }
    this.#idleMs = options.idleMs;
    this.#hardMs = options.hardMs;
    this.#onExpire = options.onExpire;
  }

  /** Arms both timers. */
  start(): void {
    this.#armIdle();
    if (this.#hardMs !== undefined) {
      this.#hardTimer = setTimeout(() => this.#fire('hard'), this.#hardMs);
    }
  }

  /** Worker activity: resets ONLY the idle timer. Never fires twice. */
  poke(): void {
    if (this.#stopped || this.#expiredWith) {
      return;
    }
    this.#armIdle();
  }

  /** Disarms everything (operation settled or worker killed for other reasons). */
  stop(): void {
    this.#stopped = true;
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#hardTimer) {
      clearTimeout(this.#hardTimer);
      this.#hardTimer = null;
    }
  }

  /** Which limit fired, if any ('idle' | 'hard' | null). */
  get expiredWith(): TimeoutExpireReason | null {
    return this.#expiredWith;
  }

  #armIdle(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
    }
    this.#idleTimer = setTimeout(() => this.#fire('idle'), this.#idleMs);
  }

  #fire(reason: TimeoutExpireReason): void {
    if (this.#stopped || this.#expiredWith) {
      return;
    }
    this.#expiredWith = reason;
    this.stop();
    this.#onExpire(reason);
  }
}
