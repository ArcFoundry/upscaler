/**
 * Pixel decode/encode for the upscaler engine.
 *
 * WORKER-ONLY MODULE. It relies on `OffscreenCanvas` and `createImageBitmap`
 * inside the dedicated worker the engine spawns. `src/index.ts` (the main-
 * thread entry) must never import this file — the worker bundle
 * (`dist/worker.js`) is the only consumer.
 */

import { UpscalerError } from './errors.js';

export type OutputFormat = 'image/png' | 'image/webp';

/** The subset of the worker global scope this module needs. */
type WorkerScope = {
  createImageBitmap?: typeof createImageBitmap;
  OffscreenCanvas?: typeof OffscreenCanvas;
};

function scope(): WorkerScope {
  return self as unknown as WorkerScope;
}

function assertWorkerCanvasSupport(): void {
  const s = scope();
  if (typeof s.OffscreenCanvas !== 'function' || typeof s.createImageBitmap !== 'function') {
    throw new UpscalerError(
      'DECODE_FAILED',
      'Codec requires OffscreenCanvas and createImageBitmap — this module runs inside the engine worker only.',
      { recoverable: true },
    );
  }
}

export class Codec {
  /**
   * Decodes an encoded image (PNG/JPEG/WebP/GIF/BMP/ICO — whatever
   * `createImageBitmap` supports in the current browser) into RGBA pixels.
   */
  static async decode(buffer: ArrayBuffer): Promise<ImageData> {
    assertWorkerCanvasSupport();
    const s = scope();

    let bitmap: ImageBitmap;
    try {
      bitmap = await s.createImageBitmap!(new Blob([buffer]));
    } catch (err) {
      throw new UpscalerError(
        'DECODE_FAILED',
        `Failed to decode image input (${err instanceof Error ? err.message : String(err)}). ` +
          'Supported formats are those createImageBitmap accepts (PNG, JPEG, WebP, GIF, BMP, ICO).',
        { recoverable: true, cause: err },
      );
    }

    try {
      const canvas = new s.OffscreenCanvas!(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new UpscalerError('DECODE_FAILED', 'OffscreenCanvas 2D context is unavailable in this browser.', {
          recoverable: true,
        });
      }
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  /**
   * Encodes RGBA pixels into a Blob. `quality` (0..1) applies to lossy
   * formats (WebP) and is ignored for PNG.
   */
  static async encode(imageData: ImageData, format: OutputFormat = 'image/png', quality?: number): Promise<Blob> {
    assertWorkerCanvasSupport();
    const s = scope();

    const canvas = new s.OffscreenCanvas!(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new UpscalerError('ENCODE_FAILED', 'OffscreenCanvas 2D context is unavailable in this browser.', {
        recoverable: true,
      });
    }
    ctx.putImageData(imageData, 0, 0);
    try {
      return await canvas.convertToBlob({
        type: format,
        ...(quality !== undefined ? { quality } : {}),
      });
    } catch (err) {
      throw new UpscalerError(
        'ENCODE_FAILED',
        `Failed to encode result as ${format} (${err instanceof Error ? err.message : String(err)}).`,
        { recoverable: true, cause: err },
      );
    }
  }
}
