# @arcfoundry/upscaler

**Headless, local-first image upscaling engine for the browser. WebGPU neural + Rust/WASM classical. Zero uploads. Zero servers.**

---

## Philosophy

- **Local-first.** Images never leave the device. Decode, inference, and encoding all run inside the engine's Web Worker on your origin. There is no server, no telemetry, no upload path — by construction, not by policy.
- **Multi-method.** Instant, download-free classical upscaling (Lanczos, Bicubic) for everything; opt-in neural upscaling (Real-ESRGAN via ONNX Runtime Web) for when the quality bar demands it. The consumer decides when — and whether — a ~16–64 MB model is ever downloaded.
- **Honest device routing.** Capabilities are *probed*, not guessed: a real `navigator.gpu.requestAdapter()` call (a present-but-blocklisted GPU correctly reports "no WebGPU"), and conservative memory assumptions for browsers that don't expose `navigator.deviceMemory`.
- **Memory-safe tiling.** Neural inference runs on 512×512 tiles (256×256 on low-memory devices) with 16px overlap and linear feathered blending, under hard concurrency caps, so a huge photo doesn't OOM the GPU.

**This is an engine, not an app. No UI. Build your own, or use ours at image.arcfoundry.dev.**

---

## Installation

```bash
npm install github:arcfoundry/upscaler
```

Prebuilt `dist/` is **committed to this repository**, so installation requires no Rust toolchain and no build step. The two export paths point at the same bundle:

```ts
// Main entry (also available as '@arcfoundry/upscaler/core'):
import { UpscalerEngine } from '@arcfoundry/upscaler';

// If you installed from GitHub and map the folder directly:
import { UpscalerEngine } from '@arcfoundry/upscaler/dist/index.js';
```

Requirements: a browser with WebAssembly (2017+) and a secure context (HTTPS or `localhost`) for the Cache API. WebGPU is optional — everything degrades honestly.

---

## Quick Start

```ts
import { UpscalerEngine } from '@arcfoundry/upscaler';

const engine = new UpscalerEngine();

// 1. Probe the device (memoized; a real requestAdapter() call).
const caps = await engine.detectDevice();
console.log(caps); // { webgpu, wasm, wasmThreads, lowVram }

// 2. Instant classical upscale — no model, no download, works everywhere.
const buffer = await file.arrayBuffer(); // e.g. an <input type="file">
const blob = await engine.process(buffer, { method: 'lanczos', scale: 4 });

// 3. Neural upscaling is OPT-IN. After the user consents to a model
//    download (the "Two-Gate" flow — the engine never downloads
//    anything implicitly):
const neuralEngine = new UpscalerEngine({
  modelUrl: 'https://cdn.example.com/models/realesrgan-x4-fp16.onnx',
});
neuralEngine.on('model_download', (e) => showProgress(e.progress)); // 0..1
await neuralEngine.loadModel(); // cache-first; silent on cache hits

// 4. Neural 4x (fixed by Real-ESRGAN). scale: 2 = 4x then Lanczos-downscale.
const result = await neuralEngine.process(sameFileBuffer, { method: 'neural', scale: 4 });

// 5. The engine hands you an object URL on 'complete'; YOU revoke it.
neuralEngine.on('complete', (e) => {
  img.src = e.blobUrl;
  // later, when done with it:
  URL.revokeObjectURL(e.blobUrl);
});

engine.destroy(); // terminates the worker, frees WASM + session memory
```

> **Note:** `process()` *transfers* the input `ArrayBuffer` to the worker (zero-copy). The buffer is detached afterwards — don't reuse it. Pass a fresh buffer (or re-read the file) for each call.

---

## API Reference

### `new UpscalerEngine(config?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `modelUrl` | `string` | — | URL of a single Real-ESRGAN `.onnx` file used on **every** device. Mutually exclusive with `models` (configuring both throws `INVALID_INPUT`). If it ends with `/`, the variant filename `realesrgan-x4-<quantization>.onnx` is appended automatically. |
| `models` | `{ webgpu?: string; wasm?: string }` | — | Capability-aware model catalog. `loadModel()` probes the device and loads `models.webgpu` on WebGPU-capable hardware, otherwise `models.wasm`. A catalog missing the variant the probed device needs throws a descriptive `MODEL_VARIANT_MISSING` error. Mutually exclusive with `modelUrl`. See [Model Hosting](#model-hosting). |
| `timeout` | `number` | `300_000` | Per-operation timeout (ms) for `loadModel()`/`process()`. On expiry the worker is terminated and a non-recoverable `TIMEOUT` error is emitted. |
| `maxDimension` | `number` | `16384` | Maximum allowed input width/height in px. Exceeding it emits a non-recoverable `DIMENSION_LIMIT` error. Neural inference additionally refuses inputs whose 4× intermediate would exceed this limit. |
| `ortWasmPaths` | `string` | jsDelivr CDN for the pinned ORT version | Directory for **ONNX Runtime's own** `.wasm`/`.mjs` artifacts (including the JSEP binary). Self-host by copying ORT's `dist/` files. This is unrelated to the Rust scaler binary shipped in `dist/wasm/`. |
| `quantization` | `'fp32' \| 'fp16' \| 'int8'` | `'fp16'` | Which model variant to request when `modelUrl` is a base directory. fp32 ≈ 64 MB, fp16 ≈ 32 MB, int8 ≈ 16 MB. |

### Methods

| Method | Signature | Throws / emits |
| --- | --- | --- |
| `detectDevice` | `(): Promise<Capabilities>` | Memoized hardware probe → `{ webgpu, wasm, wasmThreads, lowVram }`. |
| `loadModel` | `(): Promise<LoadModelResult>` | Cache-first model download + ORT session creation. Resolves `{ variant: 'webgpu' \| 'wasm'; url: string; cached: boolean }` — which file was actually selected and whether it came from cache. Throws `MODEL_URL_REQUIRED` if neither `modelUrl` nor `models` was configured, `MODEL_VARIANT_MISSING` if the catalog lacks the variant the probed device needs. Emits `model_download` while streaming (nothing on cache hits). Idempotent. |
| `process` | `(buffer: ArrayBuffer, options: ProcessOptions): Promise<Blob>` | Resolves with the encoded Blob **and** emits `complete` with a blob URL (consumer revokes). Throws/see errors below. |
| `on` | `<K>(type: K, handler): () => void` | Typed subscription; returns an unsubscribe function. |
| `off` | `<K>(type: K, handler): void` | Removes a handler. |
| `destroy` | `(): void` | Terminates the worker (freeing the ORT session and all WASM memory — they lived in the worker's heap), rejects in-flight operations with `DESTROYED`, clears listeners. The instance is unusable afterwards. |

### `process` options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `method` | `'lanczos' \| 'bicubic' \| 'neural'` | — | `lanczos`/`bicubic` run the Rust/WASM scalers (no model). `neural` requires a prior `loadModel()`. |
| `scale` | `2 \| 4` | — | Any other value throws a typed `INVALID_SCALE` error. Neural `2` = fixed-4× Real-ESRGAN followed by a Lanczos downscale. |
| `format` | `'image/png' \| 'image/webp'` | `'image/png'` | Output encoding. |
| `quality` | `number` | — | 0..1, applies to WebP; ignored for PNG. |

### Error cases

All operational failures are emitted on the `error` event **and** rejected on the operation's promise as an `UpscalerError` (`err.code`, `err.recoverable`):

| Code | Meaning | Recoverable? |
| --- | --- | --- |
| `MODEL_URL_REQUIRED` | `loadModel()` without a configured `modelUrl`/`models`. | Yes — configure and retry |
| `MODEL_VARIANT_MISSING` | The `models` catalog lacks the variant the probed device needs (e.g. no `models.wasm` on a WebGPU-less device). The error names exactly what's missing. | Yes — add the missing variant or use `modelUrl` |
| `MODEL_NOT_LOADED` | `process({ method: 'neural' })` before `loadModel()`. | Yes — call `loadModel()` |
| `MODEL_DOWNLOAD_FAILED` | Fetch failed (network, non-2xx, CORS). | Yes — retry |
| `INVALID_SCALE` / `INVALID_METHOD` / `INVALID_INPUT` | Usage errors (scale ∉ {2,4}, bad format/quality, empty/detached buffer). | Yes — fix input |
| `DIMENSION_LIMIT` | Input exceeds `maxDimension` (default 16384×16384). | No (per spec) — use a smaller input |
| `TIMEOUT` | Operation exceeded `timeout`; worker killed. | No |
| `WASM_SCALER_FAILED` | Rust scaler threw (e.g. OOM on a huge image). | No |
| `INFERENCE_FAILED` | Neural inference failed and was not recoverable via fallback. | No |
| `DECODE_FAILED` / `ENCODE_FAILED` | Input undecodable / result unencodable in the worker. | Yes — fix input |
| `WORKER_FAILED` | Worker crashed (uncaught error, serialization). | No |
| `BUSY` | A second operation was started while one was in flight (the engine processes one at a time). | Yes — retry later |
| `DESTROYED` | Instance used after `destroy()`. | No — new instance |

Pure usage errors (`INVALID_*`, `MODEL_URL_REQUIRED`, `MODEL_NOT_LOADED`, `DESTROYED`) throw without emitting an `error` event, so accidental misuse doesn't pollute your event stream.

---

## Events

```ts
engine.on(type, handler) // returns unsubscribe
```

| Event | Payload | Notes |
| --- | --- | --- |
| `model_download` | `{ progress: number }` | 0..1, streamed during model fetch. **Never emitted on cache hits.** |
| `tile_processing` | `{ tileIndex: number; totalTiles: number }` | Zero-based index of each tile as it *starts*. Classical methods are not tiled — exactly one event, `{ tileIndex: 0, totalTiles: 1 }`. |
| `fallback` | `{ from: 'webgpu'; to: 'wasm'; reason: string; swappedTo?: 'wasm-variant' \| 'same-file' }` | WebGPU failed at session creation **or** mid-inference (OOM, context/device loss): the session is disposed, recreated on WASM, and the same inference retried. With a `models` catalog this swaps to the `wasm` variant file (`swappedTo: 'wasm-variant'`, loaded through the same cache-first path); with a single `modelUrl` the same file is reloaded on the WASM EP (`swappedTo: 'same-file'`). Not an error. |
| `complete` | `{ blobUrl: string }` | Object URL created by the engine for the result Blob. |
| `error` | `{ message: string; recoverable: boolean }` | See the error table above. |

**Object-URL lifecycle contract:** the engine creates the Blob URL and emits it in `complete`. The **consumer** is responsible for calling `URL.revokeObjectURL(blobUrl)` when the URL is no longer needed. The engine deliberately does not revoke it — the URL may still be in use (e.g. assigned to an `<img>`) after `process()` resolves.

---

## Methods & Quality

| Method | Quality | Speed | Download | Notes |
| --- | --- | --- | --- | --- |
| Bicubic | Low | Fastest (ms) | None | Catmull-Rom kernel, premultiplied alpha, runs fully in Rust/WASM. |
| Lanczos | Medium | Fast (ms–100ms) | None | Lanczos3 kernel, premultiplied alpha, runs fully in Rust/WASM. |
| Real-ESRGAN | High | Slow (seconds) | ~16–64 MB once, then cached | WebGPU EP when honestly available; WASM fallback otherwise. 512² tiles (256² on lowVram), 16px overlap, feathered blending. |

**The 2× neural behavior, explicitly:** Real-ESRGAN is a *fixed 4×* model. Requesting `scale: 2` runs the full 4× neural upscale first, then downscales to 2× with the Lanczos WASM scaler (premultiplied-alpha aware). You cannot "half-run" the model — this is the honest way to get 2× neural output, and any scale other than 2 or 4 is rejected with a typed error. Consequence: a `scale: 2` neural run temporarily allocates a 4× intermediate, so very large inputs are refused when that intermediate would exceed `maxDimension`.

**Transparency:** classical methods resample alpha correctly (premultiplied). The neural model is RGB — transparent inputs are flattened (result is opaque).

---

## Device Routing & Compatibility

### Capability probing (`detectDevice()`)

| Capability | How it's decided |
| --- | --- |
| `webgpu` | `await navigator.gpu.requestAdapter()` inside a secure context. **Never** a mere API-presence check. A rejecting promise (blocklisted GPU) or `null` result ⇒ `false`. |
| `wasm` | `typeof WebAssembly === 'object'`. |
| `wasmThreads` | `crossOriginIsolated === true` (⇒ `SharedArrayBuffer` available). Gates **only** multi-threaded WASM. |
| `lowVram` | `navigator.deviceMemory === undefined` (Firefox/Safari) ⇒ `true` (conservative). `deviceMemory <= 4` ⇒ `true`. Drives 256² tiles. |

Key routing rule: **WebGPU does not require `crossOriginIsolated`** — only a secure context. Missing COOP/COEP headers disable multi-threaded WASM, *not* WebGPU.

### Browser matrix

| Feature | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| WebGPU | 113+ | — (probe honestly reports `false`) | — / behind flags |
| WASM (single-thread) | everywhere | everywhere | everywhere |
| WASM threads | COOP/COEP required | COOP/COEP required | COOP/COEP required |
| `navigator.deviceMemory` | yes | **undefined → lowVram: true** | **undefined → lowVram: true** |

### COOP/COEP for multi-threaded WASM

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Any resource you load on such a page must send CORS headers (or `Cross-Origin-Resource-Policy: cross-origin`). Model hosts: see [Model Hosting](#model-hosting).

### ⚠️ GitHub Pages warning

GitHub Pages does **not** let you set custom response headers. Deploying there means:
- `crossOriginIsolated === false` → the engine automatically uses **single-threaded WASM** (slower neural fallback, but fully functional), and
- **WebGPU still works** — it never needed those headers in the first place.

---

## Model Hosting

The engine is model-agnostic: it never ships weights, never hardcodes a model, and never auto-discovers one. You point it at a Real-ESRGAN `.onnx` file — any CORS-enabled HTTPS URL works: Hugging Face Hub, your own Cloudflare R2 bucket, or any static host. (File sizes vary by export and precision; the pinned test models below are ~2 MB and ~17 MB.)

**Ownership of the decision:** *job* (which upscaler method) and *scale* (2×/4×) are **consumer** decisions made in `process()`. *Precision variant* (which file runs) is an **engine capability** decision made from probed hardware. The engine never selects a model by job type and never infers one from the scale — you give it URLs, it picks the file that matches the device.

Two ways to configure a model:

### 1. Single URL (`modelUrl`) — one file for every device

```ts
new UpscalerEngine({ modelUrl: 'https://models.example.com/realesrgan-x4-fp16.onnx' });
// or directory-style + quantization variant selection:
new UpscalerEngine({ modelUrl: 'https://models.example.com/', quantization: 'fp16' });
```

One download; the same file runs on the WebGPU EP and the WASM fallback EP.

### 2. Capability-aware catalog (`models`) — one file per precision path

```ts
const engine = new UpscalerEngine({
  models: {
    // WebGPU-capable devices (Chrome/Edge with a working adapter):
    webgpu: 'https://huggingface.co/FuryTMP/RealESR_Gx4_fp16/resolve/3767133b06ab19a3636b342d44f5d2da5c3a132e/RealESR_Gx4_fp16.onnx',
    // Everything else (Firefox, Safari, software-GL Chrome, headless):
    wasm: 'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/488e5dda07333179f229a6205d92135eea4c25e9/realesr-general-x4v3.onnx',
  },
});
const result = await engine.loadModel();
// → { variant: 'webgpu' | 'wasm', url: string, cached: boolean }
```

`loadModel()` probes the hardware and loads `models.webgpu` where an adapter exists, `models.wasm` otherwise — `LoadModelResult.variant` tells you which file actually ran. If a mid-flight WebGPU inference fails (OOM, device loss) and the catalog has a `wasm` entry, the session is disposed and rebuilt on the wasm variant automatically; the `fallback` event reports the swap. A catalog missing the variant a device needs throws a descriptive `MODEL_VARIANT_MISSING` error rather than guessing.

The URLs above are public third-party Hugging Face uploads of Real-ESRGAN exports, **pinned by commit SHA** — they are what this repo's examples and automated browser verification use. They are convenient for testing; read the next part before shipping to production.

### Pinning and production hosting

- **Always pin by revision.** `https://huggingface.co/<org>/<repo>/resolve/main/<file>.onnx` is a moving target — `main` can be updated, moved, or deleted under you. Use `/resolve/<commit-sha>/<file>.onnx` (the commit SHA is on any HF file page's history). The engine's cache is keyed by the full URL, so a changed URL is simply a new cache entry.
- **Third-party Hugging Face hosting is a valid production strategy**, not just a test convenience: the Hub is CDN-backed and CORS-enabled, and it works from cross-origin-isolated pages (verified with this repo's examples under COOP/COEP). Attribute the model authors when the export you serve requires it — see [Attribution](#attribution). If your license terms or scale demand it, mirror the pinned file to your own bucket instead.
- **Self-hosting (Cloudflare R2 or any static host), minimum configuration:**
  1. Bucket → Settings → CORS policy allowing `GET` from your origin (or `*`) with headers `Content-Type`, `Content-Length`.
  2. Add the object metadata header **`Cross-Origin-Resource-Policy: cross-origin`** on the model object — pages deployed with `Cross-Origin-Embedder-Policy: require-corp` refuse to consume it otherwise.
  3. Point the engine at the pinned URL with `modelUrl` or `models` as above.

The model is fetched once, streamed with `model_download` progress, and stored in the browser Cache API (`upscaler-models`), keyed by URL. Subsequent loads — including on a fresh page — are served **silently** from cache: no progress events, zero model network requests, and `loadModel()` resolves with `cached: true`.

### Attribution

Real-ESRGAN — © xinntao / the XPixelGroup community ([github.com/xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)), licensed **BSD-3-Clause**. The `.onnx` files you host are exports of their trained weights; respect the code and model licenses of the export source you obtain them from.

---

## Building from Source

Prerequisites:

- **Rust** stable via [rustup](https://rustup.rs)
- `rustup target add wasm32-unknown-unknown`
- `cargo install wasm-bindgen-cli` (the crate pins `wasm-bindgen = 0.2.127`; the CLI must match)
- **Node 20.19+**

```bash
npm run build
```

The chain: `cargo build --target wasm32-unknown-unknown --release` → `wasm-bindgen --target web` (glue generated into the **committed** `src/wasm/`, then its default binary path is patched to `./wasm/`) → `tsup` (ESM + `.d.ts` into `dist/`) → `scripts/copy-wasm.mjs` (`src/wasm/*.wasm` → `dist/wasm/`).

Notes:

- `dist/` **is committed**, so end users installing from GitHub never build anything; `npm prepare` (`scripts/prepare.mjs`) skips silently when `dist/index.js` exists and only builds from source when it's missing.
- Rust unit tests: `npm run test:rust` (identity invariance, constant-image stability, alpha premultiplication, minification, validation).
- There are two separate WASM file families — never conflate them: the Rust scalers committed at `src/wasm/` → `dist/wasm/` (loaded via `new URL('./wasm/…', import.meta.url)` from the worker bundle), and ONNX Runtime's own artifacts (fetched via `ort.env.wasm.wasmPaths`, CDN by default).

---

## Examples

```bash
npm run build        # once, so src/wasm/*.wasm exists (and dist/ for the import)
npm run dev:examples # vite examples/
```

The dev server sets COOP/COEP headers, so `crossOriginIsolated === true` and multi-threaded WASM is exercised during local testing. `examples/test.ts` is a vanilla harness: `detectDevice()` → `process()` with lanczos → consent-gated `loadModel()` → `process()` with neural, with every event logged.

---

## Deployment Notes for Consumers

To get multi-threaded WASM in production, serve your app cross-origin isolated:

**Vercel** — `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**Netlify** — `_headers`:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

**Cloudflare Pages** — `_headers` (same file format as Netlify, at your output root):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

Without these headers everything still works — WebGPU is unaffected and WASM simply runs single-threaded.

---

## License

MIT — see [LICENSE](./LICENSE).
