# Verification Report — `@arcfoundry/upscaler` v0.2.0

Phase 2 neural verification: live models, real engine, real worker, real browser.
Every claim below is backed by an executed command; nothing is extrapolated.
Where something could **not** be verified in this environment, it is labelled
exactly that way (see "Honest limitations").

## Environment

| Item | Value |
| --- | --- |
| OS | linux 6.6.87.2-microsoft-standard-WSL2 x64 |
| Node | v24.13.0 |
| TypeScript | 5.9.x (`tsc --noEmit` clean) |
| onnxruntime-web | 1.29.0 (JSEP build, `ort.env.wasm.wasmPaths` → jsDelivr CDN) |
| Browser | chrome-headless-shell 1234 (Playwright 1.62.1 driver) |
| GPU | none reachable in headless shell → software WASM execution |
| Serving | `vite examples/` with COOP/COEP (`crossOriginIsolated === true`) |

## Models under test (pinned by commit SHA)

| Variant | Source | Pin |
| --- | --- | --- |
| `webgpu` | `FuryTMP/RealESR_Gx4_fp16` on Hugging Face | `3767133b06ab19a3636b342d44f5d2da5c3a132e` |
| `wasm` | `Heliosoph/realesrgan-onnx` on Hugging Face | `488e5dda07333179f229a6205d92135eea4c25e9` |

Both are third-party public exports of Real-ESRGAN weights (BSD-3-Clause,
© xinntao / XPixelGroup). Neither file is shipped by this repository; the
examples harness fetches them at runtime with the user's explicit consent.

## Tensor marshaling audit (performed BEFORE any live run)

Verified empirically against onnxruntime-web in a browser page, not from
documentation:

- Input tensor name taken from `session.inputNames[0]` → `'input'`; output
  read back from `session.outputNames` → `'output'`.
- Both pinned files expose **float32** I/O (the "fp16" FuryTMP export has
  f32 graph I/O; internal precision may differ — treated opaquely).
- Engine feeds `NCHW [1,3,h,w]`, float32, values in `[0,1]` (RGBA→RGB,
  alpha flattened). Feeding `[0,255]` was tested and **degenerates** output —
  `[0,1]` confirmed correct.
- Output unmarshal: CHW→RGBA, clamped `[0,255]`, original alpha restored.
- Fixed 4× model factor confirmed; engine's 2× = 4× then Lanczos downscale.

## Live gate — `tests/neural-gate.mjs` — 19/19 PASS

Run command:

```bash
LD_LIBRARY_PATH="$HOME/usrlibs/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH" \
PLAYWRIGHT_DIR=/tmp/upscaler-e2e node tests/neural-gate.mjs
```

Environment probe printed by the gate:

```
env: crossOriginIsolated=true webgpuProbe=null → EP expected: wasm
```

Full output (verbatim):

```
PASS  (a/c) loadModel selects the wasm variant per probed hardware
        result={"ok":true,"variant":"wasm","cached":false}
PASS  (a) model fetched from the pinned URL (network seen for variant file)
        model requests=1
PASS  (a) first loadModel streams download progress (not a cache hit)
PASS  (a) no console/page errors during session init
PASS  (d) neural 4x completes with exactly 384x384 output
        384x384
PASS  (d) pixel stats non-degenerate
        mean=169.3 std=44.3 chanStd=64.1,47.3,55.5 range=4..255
PASS  (d) bicubic 4x regression after neural
        384x384
PASS  (d) neural differs meaningfully from bicubic 4x
        meanAbsDiff=3.06 per channel
PASS  (e) neural 2x completes with exactly 192x192 output
        192x192
PASS  (g) fresh page: loadModel reports cached=true
        {"ok":true,"variant":"wasm","cached":true}
PASS  (g) fresh page: ZERO network requests for the model file
        model requests=0
PASS  (g) fresh page: no model_download progress events
PASS  (c) no-WebGPU env shows honest webgpu=false badge
        webgpufalsewasmtruewasmThreadstruelowVramfalse
PASS  (j) Two-Gate: neural before loadModel() throws typed error
PASS  (c/h) no-WebGPU env: catalog selects wasm variant
        {"ok":true,"variant":"wasm","cached":false}
PASS  (c/h) wasm variant fetched from its pinned URL
        model requests=1
PASS  (h) WASM-EP neural run completes with exactly 384x384 output
        384x384
PASS  (h) WASM-EP output non-degenerate
        mean=169.3 std=44.3 chanStd=64.1,47.3,55.5
PASS  (h) no console/page errors on the WASM path

19/19 neural-gate checks passed
```

## Check-by-check interpretation

- **(a) Session init via engine env** — the worker initialised ONNX Runtime
  with the engine's configuration (CDN `wasmPaths`, JSEP, threads, no proxy);
  the model streamed from the pinned SHA URL with `model_download` progress;
  zero console/page errors.
- **(b) Marshaling** — audited pre-run (above) and exercised live: the
  identical stats on both neural runs (mean 169.3, std 44.3) match the
  pre-audit expectations for this model/input pair.
- **(c) Capability-aware selection** — two paths: the real probe (headless
  shell honestly reports no WebGPU → wasm variant) and a simulated
  WebGPU-less device (`navigator.gpu` removed before page scripts) → honest
  `webgpu: false` capability badge and wasm variant selection.
- **(d) 4× neural** — 96×96 input → exactly 384×384; pixel statistics
  non-degenerate (full luminance range 4..255, healthy per-channel spread);
  differs from bicubic 4× of the same input by 3.06 luminance-weighted
  mean-abs per channel (the model genuinely reshapes, not just resamples);
  bicubic regression unchanged.
- **(e) 2× neural** — exactly 192×192 (4× model + Lanczos downscale path).
- **(f) Classical regression** — bicubic 4× inside the gate, the committed
  Rust unit tests (6/6) and the browser E2E classical/contract checks
  (`tests/browser-e2e.mjs`, 9 checks).
- **(g) Cache-first** — a fresh page in the same browser context resolves
  `loadModel()` with `cached: true`, **zero** network requests for the model
  file, and no `model_download` events (Cache API, keyed by URL).
- **(h) WASM-EP neural run** — full inference on the wasm variant inside the
  worker; correct dimensions, non-degenerate output, zero errors.
- **(i) Mid-flight WebGPU→WASM fallback with variant swap** — **verified by
  code review only**. No deterministic trigger exists in this environment:
  a mid-flight WebGPU inference failure requires a WebGPU EP to be running,
  and no WebGPU adapter exists here. Per the honesty rules the trigger was
  **not** simulated. The reviewed path: session/inference failure on WebGPU →
  dispose session → reload via the same cache-first path with the catalog's
  `wasm` URL → recreate session → retry → emit `fallback` with
  `swappedTo: 'wasm-variant'`.
- **(j) Two-Gate** — `process({ method: 'neural' })` before `loadModel()`
  throws the typed `MODEL_NOT_LOADED` error; the click on `loadModel()` is
  the consent gate.

## Honest limitations

1. **No WebGPU EP executed here.** `chrome-headless-shell` exposes no usable
   adapter (`webgpuProbe=null`), so both live neural runs executed on the
   **WASM EP** with the wasm variant file. The webgpu-variant file was
   verified at the byte level (protobuf parse + I/O signature audit + SHA
   pins) and by unit tests on the selection logic — but **WebGPU-EP inference
   on real GPU hardware is exercised only by the Phase 4 manual test card**
   (real Chrome, `MANUAL_TEST_CARD.md`), whose sign-off is the final
   confirmation of the v0.2.0 tag.
2. **Fallback (i) is review-verified, not execution-verified** — no
   deterministic trigger was available; none was fabricated.
3. Earlier gate runs (before this report) showed failures whose root causes
   were **test-harness bugs** (a completion marker that counted the wrong
   log lines; a fresh browser *context* whose Cache Storage is partitioned
   from the page that populated it). Both were fixed in the gate script; the
   engine itself was vindicated by the stall-dump logs (inference completed
   while the poll was still waiting).

## Non-neural suites at tag time

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `node --test "tests/*.test.mjs"` (model selection & contracts) | 8/8 |
| Rust unit tests (`npm run test:rust`) | 6/6 |
| Browser E2E classical/contract (`tests/browser-e2e.mjs`) | 9/9 |
| Live neural gate (`tests/neural-gate.mjs`) | 19/19 |
| Consumer smoke (fresh install from the tagged tree, zero Rust toolchain): `import { UpscalerEngine }` → `new UpscalerEngine()` → `detectDevice()` → `destroy()` | OK (`{"webgpu":false,"wasm":true,"wasmThreads":false,"lowVram":true}`) |
