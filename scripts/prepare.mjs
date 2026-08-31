#!/usr/bin/env node
/**
 * Conditional build for `npm prepare`:
 *
 *  - `dist/index.js` exists → exit 0 silently. Consumers installing from
 *    GitHub get the committed prebuilt `dist/` and never need a Rust
 *    toolchain.
 *  - otherwise → shell out to `npm run build` (Rust + wasm-bindgen + tsup),
 *    which is the from-source path (see README "Building from Source").
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const marker = path.join(root, '..', 'dist', 'index.js');

if (existsSync(marker)) {
  process.exit(0);
}

console.log('[upscaler] dist/ not found — building from source (Rust toolchain required)...');
const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
