/**
 * Tiling, overlap, feathered blending and bounded concurrency for neural
 * (Real-ESRGAN) processing. Runs INSIDE the engine worker.
 *
 * Tiling scheme
 * -------------
 * Tiles are `tile × tile` sampled with `overlap` px of extra context on
 * every interior side, so the model sees real content beyond each seam. The
 * context is what prevents seams; the blend is what hides the transition:
 *
 *  - Each tile's output covers its full rect (core + margins), scaled.
 *  - Margins on image borders have weight 1 (no neighbor to blend with).
 *  - Interior margins carry a linear feather ramp 0→1 across the overlap.
 *  - A pixel written for the first time is written at full weight; a pixel
 *    already written by an earlier tile is cross-faded: `new*w + old*(1-w)`.
 *    Because every interior margin is also covered by the neighboring tile's
 *    rect, the two contributions always cross-fade regardless of completion
 *    order, and the result is seamless.
 *
 * This keeps extra memory at O(output/8) (a written-bitset) instead of
 * O(output × float) for a sum/weight accumulator.
 *
 * v0.3.0: tile size / overlap / concurrency follow the HONESTLY-LABELED gpu
 * tier heuristic (`gpuTier` in Capabilities) — see `tilePolicyFor`. Per-tile
 * DURATION and a running ETA are reported on tile COMPLETION (additive
 * optional fields on the existing `tile_processing` event; the first tile's
 * duration includes model warmup — expected and documented).
 */

import type { Capabilities } from './DeviceRouter.js';
import type { ModelManager } from './ModelManager.js';

/** Default context pixels sampled beyond each interior tile edge (source px). */
export const TILE_OVERLAP = 16;
/** Larger context budget for 'high'-tier adapters. */
export const HIGH_TIER_OVERLAP = 24;

const TILE_SIZE = 512;
const TILE_SIZE_LOW_VRAM = 256;

/** How the worker runs one 4x neural tile. */
export type NeuralTileRunner = (tile: ImageData) => Promise<ImageData>;

/**
 * Per-tile telemetry relayed out of the worker. Fired on tile COMPLETION:
 * `tileDurationMs` is the duration of the tile just completed (first tile
 * includes warmup), `etaMs` the running-average estimate for the rest.
 */
export interface TileProgressInfo {
  tileIndex: number;
  totalTiles: number;
  tileDurationMs?: number;
  etaMs?: number;
}

export type TileProgressSink = (info: TileProgressInfo) => void;

/** Compute policy for one neural run, derived from the gpu tier heuristic. */
export interface TilePolicy {
  tileSize: number;
  overlap: number;
  concurrency: number;
}

/**
 * Tier-driven tile policy (HEURISTIC — inputs are labeled in Capabilities):
 *   software/entry → 256 px, concurrency 2 (conservative)
 *   mid            → 512 px, concurrency 4
 *   high           → 512 px, concurrency 4, larger overlap budget
 * `lowVram` still overrides downward (256 px / 2 / default overlap). On the
 * WASM EP the tier concurrency is additionally clamped by hardware threads.
 * Unknown tier ⇒ 'entry' (conservative). Pure; exported for tests.
 */
export function tilePolicyFor(
  capabilities: Pick<Capabilities, 'lowVram' | 'gpuTier' | 'webgpu'>,
  hardwareConcurrency = 4,
): TilePolicy {
  const tier = capabilities.gpuTier ?? 'entry';
  let policy: TilePolicy;
  switch (tier) {
    case 'high':
      policy = { tileSize: TILE_SIZE, overlap: HIGH_TIER_OVERLAP, concurrency: 4 };
      break;
    case 'mid':
      policy = { tileSize: TILE_SIZE, overlap: TILE_OVERLAP, concurrency: 4 };
      break;
    default:
      // 'software', 'entry', and any unrecognized tier: conservative.
      policy = { tileSize: TILE_SIZE_LOW_VRAM, overlap: TILE_OVERLAP, concurrency: 2 };
      break;
  }
  if (capabilities.lowVram) {
    policy = {
      tileSize: Math.min(policy.tileSize, TILE_SIZE_LOW_VRAM),
      overlap: Math.min(policy.overlap, TILE_OVERLAP),
      concurrency: Math.min(policy.concurrency, 2),
    };
  }
  if (!capabilities.webgpu) {
    policy = { ...policy, concurrency: Math.min(policy.concurrency, Math.max(1, hardwareConcurrency)) };
  }
  return policy;
}

interface TileJob {
  index: number;
  /** Top-left of the tile's CORE region in source pixels. */
  x0: number;
  y0: number;
}

export class TileProcessor {
  readonly #onTile: TileProgressSink;

  constructor(onTile: TileProgressSink) {
    this.#onTile = onTile;
  }

  /**
   * Processes `image` with the tiled Real-ESRGAN pipeline at the model's
   * fixed 4x. Returns the full upscaled image. One `tile_processing`
   * notification fires PER COMPLETED TILE with its duration and the running
   * ETA (average over completed tiles × remaining ÷ concurrency).
   */
  async processNeural(image: ImageData, capabilities: Capabilities, model: ModelManager): Promise<ImageData> {
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const { tileSize, overlap, concurrency } = tilePolicyFor(capabilities, hw);
    const core = tileSize - 2 * overlap;
    const scale = 4;

    const { width: W, height: H } = image;
    const cols = Math.ceil(W / core);
    const rows = Math.ceil(H / core);
    const total = cols * rows;

    const outW = W * scale;
    const outH = H * scale;
    const out = new Uint8ClampedArray(outW * outH * 4);
    // Written-bitset: one bit per output pixel (see class doc).
    const written = new Uint8Array((outW * outH + 7) >> 3);

    const jobs: TileJob[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        jobs.push({ index: jobs.length, x0: c * core, y0: r * core });
      }
    }

    let next = 0;
    const durations: number[] = [];

    const emitComplete = (index: number, durationMs: number): void => {
      durations.push(durationMs);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const remaining = total - durations.length;
      this.#onTile({
        tileIndex: index,
        totalTiles: total,
        tileDurationMs: Math.round(durationMs),
        etaMs: remaining > 0 ? Math.round((avg * remaining) / concurrency) : 0,
      });
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) {
          return;
        }
        const job = jobs[i]!;
        const t0 = performance.now();
        const tile = this.#extractTile(image, job.x0, job.y0, tileSize, overlap);
        const upscaled = await this.#inferTile(tile, model);
        this.#composite(out, written, upscaled, job.x0, job.y0, W, H, core, scale, overlap);
        emitComplete(job.index, performance.now() - t0);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

    return new ImageData(out, outW, outH);
  }

  /**
   * Extracts a `tileSize × tileSize` source rect centered on the core at
   * (`x0`, `y0`), with `overlap` context on interior sides, clamped to the
   * image. Interior edges keep full context; image-border edges are clamped
   * away (no fabricated pixels).
   */
  #extractTile(image: ImageData, x0: number, y0: number, tileSize: number, overlap: number): ImageData {
    const rectX = Math.max(0, x0 - overlap);
    const rectY = Math.max(0, y0 - overlap);
    const rectW = Math.min(tileSize, image.width - rectX);
    const rectH = Math.min(tileSize, image.height - rectY);

    const tile = new ImageData(rectW, rectH);
    const src = image.data;
    const dst = tile.data;
    for (let y = 0; y < rectH; y++) {
      const srcRow = ((rectY + y) * image.width + rectX) * 4;
      dst.set(src.subarray(srcRow, srcRow + rectW * 4), y * rectW * 4);
    }
    return tile;
  }

  /**
   * Runs one tile through the model. Tensor marshaling lives in
   * ModelManager (export-true dtype, alpha restored there); this method
   * only feeds and reads tiles.
   */
  async #inferTile(tile: ImageData, model: ModelManager): Promise<ImageData> {
    return model.run(tile); // ModelManager marshals, infers, unmarshals
  }

  /**
   * Blends one upscaled tile into the output (see class doc for the
   * first-write / cross-fade rule and the feather weights).
   */
  #composite(
    out: Uint8ClampedArray,
    written: Uint8Array,
    tile: ImageData,
    x0: number,
    y0: number,
    srcW: number,
    srcH: number,
    core: number,
    scale: number,
    overlap: number,
  ): void {
    const outW = srcW * scale;
    const outH = srcH * scale;

    const rectX = Math.max(0, x0 - overlap);
    const rectY = Math.max(0, y0 - overlap);
    const rectW = Math.min(tile.width, srcW - rectX);
    const rectH = Math.min(tile.height, srcH - rectY);

    const destX = rectX * scale;
    const destY = rectY * scale;
    const destW = rectW * scale;
    const destH = rectH * scale;

    // Feather width in output pixels; only interior sides feather.
    const feather = overlap * scale;
    const hasLeft = x0 > 0;
    const hasTop = y0 > 0;
    const hasRight = x0 + core < srcW;
    const hasBottom = y0 + core < srcH;

    for (let dy = 0; dy < destH; dy++) {
      const oy = destY + dy;
      if (oy >= outH) {
        break;
      }
      const wTop = hasTop ? Math.min((oy - destY + 1) / feather, 1) : 1;
      const wBottom = hasBottom ? Math.min((destY + destH - oy) / feather, 1) : 1;

      for (let dx = 0; dx < destW; dx++) {
        const ox = destX + dx;
        if (ox >= outW) {
          break;
        }
        const wLeft = hasLeft ? Math.min((ox - destX + 1) / feather, 1) : 1;
        const wRight = hasRight ? Math.min((destX + destW - ox) / feather, 1) : 1;
        const w = wLeft * wRight * wTop * wBottom;

        const dstIdx = (oy * outW + ox) * 4;
        const srcIdx = (dy * tile.width + dx) * 4;

        if (!this.#isWritten(written, oy * outW + ox)) {
          out[dstIdx] = tile.data[srcIdx]!;
          out[dstIdx + 1] = tile.data[srcIdx + 1]!;
          out[dstIdx + 2] = tile.data[srcIdx + 2]!;
          out[dstIdx + 3] = tile.data[srcIdx + 3]!;
          this.#markWritten(written, oy * outW + ox);
          continue;
        }
        if (w >= 1) {
          out[dstIdx] = tile.data[srcIdx]!;
          out[dstIdx + 1] = tile.data[srcIdx + 1]!;
          out[dstIdx + 2] = tile.data[srcIdx + 2]!;
          out[dstIdx + 3] = tile.data[srcIdx + 3]!;
          continue;
        }
        // Cross-fade with whatever an earlier tile left here.
        out[dstIdx] = Math.round(tile.data[srcIdx]! * w + out[dstIdx]! * (1 - w));
        out[dstIdx + 1] = Math.round(tile.data[srcIdx + 1]! * w + out[dstIdx + 1]! * (1 - w));
        out[dstIdx + 2] = Math.round(tile.data[srcIdx + 2]! * w + out[dstIdx + 2]! * (1 - w));
        out[dstIdx + 3] = Math.round(tile.data[srcIdx + 3]! * w + out[dstIdx + 3]! * (1 - w));
      }
    }
  }

  #isWritten(bits: Uint8Array, px: number): boolean {
    return (bits[px >> 3]! & (1 << (px & 7))) !== 0;
  }

  #markWritten(bits: Uint8Array, px: number): void {
    bits[px >> 3] = bits[px >> 3]! | (1 << (px & 7));
  }
}
