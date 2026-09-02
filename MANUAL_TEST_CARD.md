# Manual Test Card — 5 minutes, real Chrome

The automated verification (see [VERIFICATION.md](./VERIFICATION.md)) ran the
full engine in headless Chromium, where no WebGPU adapter exists — so every
neural run there honestly executed on the **WASM EP**. This card exercises the
one path automation could not: **WebGPU-EP inference on real GPU hardware**.
Your visual sign-off below is the final confirmation of the `v0.2.0` tag.

## Setup (~1 min)

```bash
npm run build         # skip if dist/ already exists
npm run dev:examples  # serves examples with COOP/COEP on http://localhost:5173
```

Open **Google Chrome 113+** (not the headless shell) at
<http://localhost:5173>, DevTools console open (F12).

## Test 1 — honest WebGPU probe (30 s)

1. Click **detectDevice()**.
2. Expected badges: `webgpu true`, `wasm true`, `wasmThreads true`
   (dev server sends COOP/COEP), `lowVram true/false`.
   - If `webgpu` shows **false** on a real desktop Chrome, that is a finding,
     not a pass: check `chrome://gpu` for blocklisting and report it.

## Test 2 — Two-Gate + neural 4× on the WebGPU EP (2–3 min)

1. Drop a real photo into the file input — at least 800 px on the short side
   (a phone photo is perfect).
2. Method = **neural**, Scale = **4×** → click **Run**.
   - Expected: typed rejection in the log — `process failed: … MODEL_NOT_LOADED
     … requires a prior loadModel()`. This is the Two-Gate working: no model
     download may start without explicit consent.
3. Click **loadModel()** (this click **is** the consent).
   - Expected: `model_download` progress streaming 0→100 % exactly once
     (~2 MB, the WebGPU fp16 variant), then
     `model ready — variant=webgpu cached=false`.
4. Click **Run** again.
   - Expected: `tile_processing` ticking up (512² tiles, 16 px overlap), then
     `complete`, and a visibly sharper image. No red console lines.

## Test 3 — cache-first reload (30 s)

1. Reload the page (F5 — do not clear site data), then click **loadModel()**.
   - Expected: **no** progress bar, `model ready — variant=webgpu cached=true`,
     and (in DevTools → Network) zero requests for the `.onnx` file.

## Test 4 — bicubic A/B (30 s)

1. Drop the same photo, Method = **bicubic**, Scale = **4×** → Run.
2. Compare with the neural output: neural should show materially cleaner
   edges and recovered detail, not just a smooth resize.

## Test 5 — Firefox honest-badge check (30 s, recommended)

1. Open the same URL in **Firefox** → **detectDevice()**.
   - Expected: `webgpu false` (Firefox has no stable WebGPU — the probe must
     say so rather than lie), `wasm true`.
2. **loadModel()** → the **wasm** variant downloads instead (fp32 export,
   ~17 MB, one-time), then neural 4× still works — noticeably slower.

## Sign-off

- [ ] Test 1 — `webgpu true` on real Chrome; the WebGPU variant was selected
      (`variant=webgpu` in the load log)
- [ ] Test 2 — Two-Gate rejection appeared before consent; 4× neural output
      produced with no console errors
- [ ] Test 3 — second load: `cached=true`, no progress events, no `.onnx`
      network request
- [ ] Test 4 — neural output visibly sharper than bicubic on the same photo
- [ ] Test 5 — Firefox shows honest `webgpu=false` and completes via wasm

Checked by: ______________  Date: ______________
