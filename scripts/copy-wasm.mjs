#!/usr/bin/env node
/**
 * Copies the committed Rust scaler binaries from `src/wasm/*.wasm` into
 * `dist/wasm/` so the compiled bundle (dist/index.js, dist/worker.js)
 * resolves them via its relative `new URL('./wasm/...', import.meta.url)`
 * reference. These are the ENGINE's scalers — ONNX Runtime's own artifacts
 * are a separate family fetched via `ort.env.wasm.wasmPaths`.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'wasm');
const outDir = path.join(root, 'dist', 'wasm');

await mkdir(outDir, { recursive: true });

const entries = await readdir(srcDir);
const binaries = entries.filter((name) => name.endsWith('.wasm'));
if (binaries.length === 0) {
  console.error('[upscaler] no .wasm binaries found in src/wasm/ — run `npm run build` from source first.');
  process.exit(1);
}

for (const name of binaries) {
  await copyFile(path.join(srcDir, name), path.join(outDir, name));
  console.log(`[upscaler] copied src/wasm/${name} -> dist/wasm/${name}`);
}
