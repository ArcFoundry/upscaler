# Changelog

## 0.3.0 — Honest GPU routing, inactivity timeout, telemetry, diagnostics

Incident-driven release. A real-Chrome manual test on a dual-GPU machine ran a
"webgpu" session at ~75 s/tile, then an ABSOLUTE 300 s timeout killed a job that
was still progressing (4/25 tiles). Four root causes, all fixed in the engine:

### Changed — BREAKING in behavior, not in types
- **`timeout` is now an INACTIVITY timeout** (default 300_000 ms): every worker
  message (tile/download progress, fallback, internal heartbeat) resets it. A
  silent worker dies exactly as before (same non-recoverable `TIMEOUT` error);
  a progressing worker is NEVER killed by it. The worker emits a lightweight
  internal heartbeat during quiet phases (session compile, blending, encoding)
  so legitimate silence cannot false-trigger.
- **WebGPU probing now requests `powerPreference: 'high-performance'`** by
  default (`gpuPreference` config; `'low-power'` / `'default'` available). The
  unspecified browser default could pick an iGPU on dual-GPU machines — 10–50×
  slower for this compute workload.
- **ORT sessions are created with EXACTLY ONE execution provider** — the
  capability-chosen one. The engine never hands ORT `['webgpu','wasm']`, where
  silent EP substitution could run WASM behind a WebGPU promise undetected.
  Init failure goes through the engine's explicit fallback path (dispose →
  wasm variant if cataloged → recreate → retry → `fallback` event).

### Added (all additive/optional; the 5-event union is unchanged)
- `hardTimeoutMs` config: optional absolute cap overriding idle logic.
- `Capabilities` gains optional `adapterInfo` (raw adapter identity),
  `dualGpu` + `secondaryAdapterInfo` (two-preference probe comparison — the
  only enumeration stable WebGPU offers), `softwareGpu` (SwiftShader/
  LAVAPIPE/llvmpipe detection), `gpuTier` (`'software'|'entry'|'mid'|'high'`,
  a LABELED heuristic; raw adapter string always available beside it).
- Software-GPU routing: a software adapter selects `models.wasm` when the
  catalog has it (reason recorded); without a wasm variant it proceeds,
  honestly labeled. `LoadModelResult` and `fallback` gain optional
  `reason` / `swappedTo` fields.
- `tile_processing` gains optional `tileDurationMs` (first tile includes
  warmup) and `etaMs` (running average × remaining ÷ concurrency).
- `engine.getDiagnostics()`: synchronous truth snapshot — chosen variant,
  requested vs actual EP, adapter info, tier, dualGpu, last tile duration,
  sessionActive.
- Tier-driven tile policy: software/entry → 256 px tiles @ concurrency 2;
  mid/high → 512 px @ 4 (high with a larger overlap budget); `lowVram` still
  overrides downward. Advisory neural-megapixel ceiling per tier via
  `TIER_NEURAL_MEGAPIXELS`.

## 0.2.0 — Capability-aware model selection
- `models: { webgpu?, wasm? }` catalog config; `loadModel()` resolves
  `LoadModelResult` (`{ variant, url, cached }`); `MODEL_VARIANT_MISSING`
  typed error; mid-flight WebGPU→WASM fallback with variant swap; SHA-pinned
  test models; live 19-check neural verification gate.

## 0.1.0 — Initial engine
- Headless engine: WebGPU neural (Real-ESRGAN via onnxruntime-web JSEP) +
  Rust/WASM lanczos/bicubic, tiled feathered inference, worker-only codec,
  Two-Gate consent, cache-first model loading, object-URL contract.
