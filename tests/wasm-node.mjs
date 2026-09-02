/**
 * Node-side end-to-end check of the COMMITTED wasm-bindgen glue + binary:
 * mirrors exactly how src/worker.ts uses WasmScalerJob (construct → process
 * → take_output → free in a finally block).
 *
 * Run: npm run test:node  (node --test "tests/*.test.mjs")
 * This file is also standalone-runnable: node tests/wasm-node.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const glue = await import(path.join(root, 'src/wasm/upscaler_wasm.js'));

const binary = await readFile(path.join(root, 'src/wasm/upscaler_wasm_bg.wasm'));
await glue.default(binary);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Build a 64×48 RGBA gradient with an alpha ramp.
const W = 64;
const H = 48;
const pixels = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    pixels[i] = Math.round((x / (W - 1)) * 255);
    pixels[i + 1] = Math.round((y / (H - 1)) * 255);
    pixels[i + 2] = 128;
    pixels[i + 3] = Math.round((x / (W - 1)) * 255);
  }
}

for (const [name, lanczos] of [
  ['lanczos', true],
  ['bicubic', false],
]) {
  let job = null;
  try {
    job = new glue.WasmScalerJob(pixels, W, H, 2, lanczos);
    check(`${name}: constructor returns job`, job instanceof glue.WasmScalerJob);
    job.process();
    const out = job.take_output();
    check(`${name}: output is 2x RGBA`, out.length === (W * 2) * (H * 2) * 4, `${out.length} bytes`);
    const inStart = (0 * W + 0) * 4;
    const outStart = 0;
    check(`${name}: corner pixel roughly preserved`, Math.abs(out[outStart] - pixels[inStart]) <= 2, `${out[outStart]} vs ${pixels[inStart]}`);
    const midIn = (24 * W + 32) * 4;
    const midOut = (48 * (W * 2) + 64) * 4;
    check(`${name}: center pixel brightness preserved`, Math.abs(out[midOut + 2] - pixels[midIn + 2]) <= 2, `${out[midOut + 2]} vs ${pixels[midIn + 2]}`);
  } finally {
    job?.free();
    check(`${name}: free() runs`, true);
  }
}

// free() invalidates the wrapper.
{
  const job = new glue.WasmScalerJob(pixels, W, H, 2, true);
  job.free();
  let threw = false;
  try {
    job.process();
  } catch {
    threw = true;
  }
  check('use-after-free throws', threw);
}

// Rust-side validation propagates as JsError.
{
  let threw = false;
  try {
    new glue.WasmScalerJob(new Uint8Array(10), W, H, 2, true);
  } catch (err) {
    threw = err.message.includes('does not match');
  }
  check('bad buffer length rejected with descriptive error', threw);
}

// Minification path used by neural scale-2 (4x then 0.5 Lanczos downscale).
{
  const big = new Uint8Array(W * 4 * H * 4 * 4).fill(200);
  for (let i = 3; i < big.length; i += 4) big[i] = 255;
  const job = new glue.WasmScalerJob(big, W * 4, H * 4, 0.5, true);
  job.process();
  const out = job.take_output();
  check('downscale 0.5 returns half dims', out.length === (W * 2) * (H * 2) * 4, `${out.length} (expect ${W * 2 * H * 2 * 4})`);
  job.free();
}

// Pure function exports also exist and work.
check('pure resample_lanczos export', typeof glue.resample_lanczos === 'function');
{
  const out = glue.resample_bicubic(pixels, W, H, 2);
  check('pure resample_bicubic works', out.length === (W * 2) * (H * 2) * 4);
}

console.log(failures === 0 ? '\nALL WASM CHECKS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
