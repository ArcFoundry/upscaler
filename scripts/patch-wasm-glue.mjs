#!/usr/bin/env node
/**
 * Fixes the wasm-bindgen glue's default binary path after regeneration.
 *
 * `wasm-bindgen --target web` emits `new URL('upscaler_wasm_bg.wasm',
 * import.meta.url)`, which would resolve next to the BUNDLED worker
 * (dist/upscaler_wasm_bg.wasm). The engine's contract puts the binary at
 * `dist/wasm/` (non-negotiable #9), so the glue's default is rewritten to
 * `./wasm/upscaler_wasm_bg.wasm`. Runs after wasm-bindgen, before tsup;
 * the patched glue lives in the committed src/wasm/.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const gluePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'wasm',
  'upscaler_wasm.js',
);

const source = await readFile(gluePath, 'utf8');
const target = "module_or_path = new URL('./wasm/upscaler_wasm_bg.wasm', import.meta.url);";

if (source.includes(target)) {
  console.log('[upscaler] wasm glue already patched');
  process.exit(0);
}

const patched = source.replace(
  "module_or_path = new URL('upscaler_wasm_bg.wasm', import.meta.url);",
  target,
);

if (patched === source) {
  console.error('[upscaler] could not find the wasm URL pattern to patch in upscaler_wasm.js');
  process.exit(1);
}

await writeFile(gluePath, patched);
console.log('[upscaler] patched wasm glue default path -> ./wasm/upscaler_wasm_bg.wasm');
