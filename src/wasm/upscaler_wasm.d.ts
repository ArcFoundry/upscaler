/* tslint:disable */
/* eslint-disable */

/**
 * Resampling job that keeps its buffers in the WASM heap.
 *
 * # Memory-safety contract (IMPORTANT)
 *
 * The job holds the input copy and (after [`WasmScalerJob::process`]) the
 * output buffer in WASM-linear memory. `wasm-bindgen` generates a `free()`
 * method on the JS wrapper class: **the JS side MUST call `job.free()` once
 * it has taken the output** (typically in a `finally` block). Failing to do
 * so leaks the input and output buffers in the WASM heap. Using the job in
 * any way after `free()` throws a JS exception.
 */
export class WasmScalerJob {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Creates a job and copies `pixels` (RGBA8, `width * height * 4` bytes)
     * into the WASM heap. Does no work until [`WasmScalerJob::process`].
     */
    constructor(pixels: Uint8Array, width: number, height: number, scale: number, lanczos: boolean);
    /**
     * Runs the resampler and keeps the result in the heap until
     * [`WasmScalerJob::take_output`] copies it out to JS.
     */
    process(): void;
    /**
     * Copies the processed buffer out to JS as a fresh `Uint8Array` and
     * releases the internal copy. Call `free()` afterwards (see contract).
     */
    take_output(): Uint8Array;
    /**
     * Number of bytes in the processed output (`out_w * out_h * 4`), or 0
     * before `process()` has run.
     */
    readonly outputByteLength: number;
}

/**
 * Bicubic (Catmull-Rom, a = -0.5) resampling of RGBA8 pixels.
 *
 * # Memory safety
 * Pure function: the input `Uint8Array` is copied, every intermediate
 * allocation is freed on return, and the result is a fresh `Uint8Array`.
 * Nothing to free on the JS side.
 */
export function resample_bicubic(pixels: Uint8Array, width: number, height: number, scale: number): Uint8Array;

/**
 * Lanczos3 resampling of RGBA8 pixels.
 *
 * # Memory safety
 * Pure function: the input `Uint8Array` is copied, every intermediate
 * allocation is freed on return, and the result is a fresh `Uint8Array`.
 * Nothing to free on the JS side.
 */
export function resample_lanczos(pixels: Uint8Array, width: number, height: number, scale: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmscalerjob_free: (a: number, b: number) => void;
    readonly resample_bicubic: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly resample_lanczos: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasmscalerjob_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly wasmscalerjob_outputByteLength: (a: number) => number;
    readonly wasmscalerjob_process: (a: number, b: number) => void;
    readonly wasmscalerjob_take_output: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
