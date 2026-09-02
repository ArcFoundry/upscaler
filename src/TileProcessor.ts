/**
 * Tiling, overlap, feathered blending and bounded concurrency for neural
 * (Real-ESRGAN) processing. Runs INSIDE the engine worker.
 *
 * Tiling scheme
 * -------------
 * Tiles are `tile × tile` (512², or 256² when `lowVram`) sampled with
 * `OVERLAP` (16px) of extra context on every interior side, so the model
 * sees real content beyond each seam. The context is what prevents seams;
 * the blend is what hides the transition:
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
 */

import type { Capabilities } from './DeviceRouter.js';
import type { ModelManager } from './ModelManager.js';

/** Context pixels sampled beyond each interior tile edge (source pixels). */
export const TILE_OVERLAP = 16;

const TILE_SIZE = 512;
const TILE_SIZE_LOW_VRAM = 256;

/** Hard concurrency caps per execution provider. */
const MAX_CONCURRENT_TILES_WEBGPU = 4;
const MAX_CONCURRENT_TILES_WASM = 8;

/** How the worker runs one 4x neural tile. */
export type NeuralTileRunner = (tile: ImageData) => Promise<ImageData>;

/** Per-tile progress relayed out of the worker. */
export type TileProgressSink = (tileIndex: number, totalTiles: number) => void;

interface TileJob {
  index: number;
  /** Top-left of the tile's CORE region in source pixels. */
  x0: number;
  y0: number;
}

export class TileProcessor {
  readonly #onTileStart: TileProgressSink;

  constructor(onTileStart: TileProgressSink) {
    this.#onTileStart = onTileStart;
  }

  /**
   * Processes `image` with the tiled Real-ESRGAN pipeline at the model's
   * fixed 4x. Returns the full upscaled image.
   */
  async processNeural(image: ImageData, capabilities: Capabilities, model: ModelManager): Promise<ImageData> {
    const tileSize = capabilities.lowVram ? TILE_SIZE_LOW_VRAM : TILE_SIZE;
    const core = tileSize - 2 * TILE_OVERLAP;
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
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const concurrency = capabilities.webgpu
      ? MAX_CONCURRENT_TILES_WEBGPU
      : Math.min(hw, MAX_CONCURRENT_TILES_WASM);

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) {
          return;
        }
        const job = jobs[i]!;
        this.#onTileStart(job.index, total);
        const tile = this.#extractTile(image, job.x0, job.y0, tileSize);
        const upscaled = await this.#inferTile(tile, model);
        this.#composite(out, written, upscaled, job.x0, job.y0, W, H, core, scale);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

    return new ImageData(out, outW, outH);
  }

  /**
   * Extracts a `tileSize × tileSize` source rect centered on the core at
   * (`x0`, `y0`), with `TILE_OVERLAP` context on interior sides, clamped to
   * the image. Interior edges keep full context; image-border edges are
   * clamped away (no fabricated pixels).
   */
  #extractTile(image: ImageData, x0: number, y0: number, tileSize: number): ImageData {
    const rectX = Math.max(0, x0 - TILE_OVERLAP);
    const rectY = Math.max(0, y0 - TILE_OVERLAP);
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
  ): void {
    const outW = srcW * scale;
    const outH = srcH * scale;

    const rectX = Math.max(0, x0 - TILE_OVERLAP);
    const rectY = Math.max(0, y0 - TILE_OVERLAP);
    const rectW = Math.min(tile.width, srcW - rectX);
    const rectH = Math.min(tile.height, srcH - rectY);

    const destX = rectX * scale;
    const destY = rectY * scale;
    const destW = rectW * scale;
    const destH = rectH * scale;

    // Feather width in output pixels; only interior sides feather.
    const feather = TILE_OVERLAP * scale;
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
