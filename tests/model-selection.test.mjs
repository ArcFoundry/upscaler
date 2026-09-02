/**
 * Unit tests for the pure capability→variant selection logic
 * (run: npm run test:node — uses Node's built-in test runner, no browser).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectModelVariant, UpscalerError } from '../dist/index.js';

const CAPS_WEBGPU = { webgpu: true, wasm: true, wasmThreads: true, lowVram: false };
const CAPS_NO_WEBGPU = { webgpu: false, wasm: true, wasmThreads: false, lowVram: true };

test('webgpu capability + webgpu variant → webgpu variant selected', () => {
  const sel = selectModelVariant({ webgpu: 'https://m/fp16.onnx', wasm: 'https://m/fp32.onnx' }, CAPS_WEBGPU);
  assert.equal(sel.variant, 'webgpu');
  assert.equal(sel.url, 'https://m/fp16.onnx');
  assert.equal(sel.wasmFallbackUrl, 'https://m/fp32.onnx');
});

test('webgpu capability but NO webgpu variant → falls back to wasm variant', () => {
  const sel = selectModelVariant({ wasm: 'https://m/fp32.onnx' }, CAPS_WEBGPU);
  assert.equal(sel.variant, 'wasm');
  assert.equal(sel.url, 'https://m/fp32.onnx');
  assert.equal(sel.wasmFallbackUrl, undefined);
});

test('no webgpu capability → wasm variant selected', () => {
  const sel = selectModelVariant({ webgpu: 'https://m/fp16.onnx', wasm: 'https://m/int8.onnx' }, CAPS_NO_WEBGPU);
  assert.equal(sel.variant, 'wasm');
  assert.equal(sel.url, 'https://m/int8.onnx');
});

test('no webgpu capability + wasm-only catalog → wasm variant (typed, no error)', () => {
  const sel = selectModelVariant({ wasm: 'https://m/fp32.onnx' }, CAPS_NO_WEBGPU);
  assert.equal(sel.variant, 'wasm');
});

test('no webgpu capability + webgpu-only catalog → MODEL_VARIANT_MISSING naming models.wasm', () => {
  assert.throws(
    () => selectModelVariant({ webgpu: 'https://m/fp16.onnx' }, CAPS_NO_WEBGPU),
    (err) => {
      assert.ok(err instanceof UpscalerError);
      assert.equal(err.code, 'MODEL_VARIANT_MISSING');
      assert.ok(err.recoverable);
      assert.match(err.message, /models\.wasm/);
      assert.match(err.message, /WebGPU/);
      return true;
    },
  );
});

test('webgpu capability + webgpu-only catalog → MODEL_VARIANT_MISSING (wasm needed for fallback? no — wasm only missing for…)', () => {
  // Per spec rule: `webgpu && models.webgpu` → webgpu; ELSE models.wasm.
  // webgpu-capable + webgpu-only catalog selects the webgpu variant fine.
  const sel = selectModelVariant({ webgpu: 'https://m/fp16.onnx' }, CAPS_WEBGPU);
  assert.equal(sel.variant, 'webgpu');
  assert.equal(sel.url, 'https://m/fp16.onnx');
});

test('empty catalog on a WebGPU-less device → MODEL_VARIANT_MISSING', () => {
  assert.throws(
    () => selectModelVariant({}, CAPS_NO_WEBGPU),
    (err) => err instanceof UpscalerError && err.code === 'MODEL_VARIANT_MISSING',
  );
});

test('identical variant URLs → no separate wasm fallback URL', () => {
  const sel = selectModelVariant({ webgpu: 'https://m/same.onnx', wasm: 'https://m/same.onnx' }, CAPS_WEBGPU);
  assert.equal(sel.variant, 'webgpu');
  assert.equal(sel.wasmFallbackUrl, undefined);
});
