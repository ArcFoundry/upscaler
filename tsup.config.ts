import { defineConfig } from 'tsup';

export default defineConfig({
  // worker.ts MUST be a separate entry point: WorkerController references the
  // compiled `./worker.js` next to this bundle via `new URL(..., import.meta.url)`.
  entry: ['src/index.ts', 'src/worker.ts'],
  format: ['esm'],
  dts: true,
  // onnxruntime-web stays external so consumer bundlers (and the examples' Vite
  // dev server) resolve it from node_modules. The wasm-bindgen glue is a local
  // generated file in src/wasm/ — it is bundled, NOT externalized.
  external: ['onnxruntime-web'],
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  clean: true,
  esbuildOptions: (options) => {
    // Never let esbuild's asset pipeline relocate the .wasm binaries: the
    // scaler binary is committed at src/wasm/ and copied verbatim to dist/wasm/
    // by scripts/copy-wasm.mjs, and the glue references it with a relative
    // URL that must survive bundling untouched.
    options.external = [...(options.external ?? []), '*.wasm'];
  },
});
