import { defineConfig } from 'vite';

// COOP/COEP make the dev server cross-origin isolated, which unlocks
// SharedArrayBuffer and therefore MULTI-THREADED WASM (numThreads > 1).
// WebGPU does not need these headers — only WASM threads do.
// Model hosts must additionally send `Cross-Origin-Resource-Policy:
// cross-origin` (or be fetched in CORS mode) for COEP pages — see README.
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
