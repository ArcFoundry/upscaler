# Manual Test Card — 5 minutes, real Chrome

The automated verification (see [VERIFICATION.md](./VERIFICATION.md)) covers the
engine end-to-end headlessly; this card is the human confirmation on real GPU
hardware. **One click runs the whole job** — consent, model load and processing
are one chain on the Run button.

## Setup (~1 min)

```bash
npm run build         # skip if dist/ already exists
npm run dev:examples  # serves examples with COOP/COEP on http://localhost:5173
```

Open **Google Chrome 113+** at <http://localhost:5173>. DevTools console open
(F12) is useful but not required.

## Test 1 — read the diagnostics FIRST (30 s)

1. Click **detectDevice()**.
2. The panel names your hardware: `adapter: …`, `gpuTier (HEURISTIC): …`,
   `softwareGpu`, `dualGpu`. On a healthy desktop GPU expect `webgpu: true`
   and a named adapter (not SwiftShader/llvmpipe).
3. If a dGPU exists but the panel shows the iGPU only, note it — that's a
   one-target bug report (include the panel text).

## Test 2 — ONE click through the neural path (2–3 min)

1. Drop a real photo (≥800 px short side) — or click the tile and browse.
2. Pick **High · Real-ESRGAN**, Scale **4×** → click **Run** once.
3. The consent dialog appears immediately → **Use AI**.
   - First run: `model download NN%` lines (one-time, ~2 MB webgpu / ~17 MB
     wasm), then `model ready — variant=…` — **and the very next line is
     `tile 1/N`** (auto-continue; no second click exists).
   - Later runs: `model ready — cached · 0 MB downloaded`.
4. Watch the tile lines: per-tile seconds + running ETA. On a real dGPU a
   720×1280 photo is typically ~1–4 s/tile at 512 px tiles (~25–60 s total).
5. The result card appears with dims · size · method · format.

**Decision rules**

- Job completes, diagnostics named the expected adapter, result visibly
  sharper, no amber fallback banner → **v0.3.x confirmed on your hardware**.
- iGPU/software picked despite a healthy dGPU, or an unexplained fallback
  banner → paste the diagnostics panel back verbatim (one-target bug).
- Garbage/noise output or a crash → screenshot + the telemetry block.

## Test 3 — the honest comparison at 1× (1 min)

This is the step that makes quality differences visible at all: at FIT the
browser shrinks a 1440×2560 result into a small panel and ERASES every
difference — even AI vs bicubic looks "the same". The harness ships a zoom
slider for exactly this reason.

1. In the result card set zoom to **1×** (or **2×**).
2. Drag the divider over **text** or a hard edge in the image — text edges are
   where classical softness vs neural reconstruction is starkest.
3. Compare **High** vs **Medium · Lanczos** runs at the same zoom:
   - High: reconstructed detail — text crisp, edges clean.
   - Medium/Low: geometry only — smooth but no detail gain (the method card
     says so up front; that's physics, not a bug).

## Test 4 — cache check (30 s)

1. Reload the page (F5), drop the same photo, High · Run · Use AI.
2. Expect `model ready — … · cached · 0 MB downloaded` and **no** percentage
   lines — zero re-download. DevTools → Network shows no `.onnx` request.

## Test 5 — Firefox honest badge (30 s, recommended)

1. Same URL in Firefox → **detectDevice()**: `webgpu: false` (honest probe,
   never a lie), `wasm: true`.
2. High · Run → the **wasm** variant downloads once (fp32, ~17 MB), runs on
   CPU — noticeably slower, same one-click flow.

## Sign-off

- [ ] Test 1 — diagnostics names the expected adapter before any run
- [ ] Test 2 — ONE click did consent → load → tiles → result; no error-red
      lines on the happy path
- [ ] Test 3 — at 1×/2× the divider shows real differences between methods
- [ ] Test 4 — reload + rerun: cached, 0 MB, no `.onnx` request
- [ ] Test 5 — Firefox: honest `webgpu: false`, wasm path completes

Checked by: ______________  Date: ______________
