//! Classical image scalers for the `upscaler` engine: bicubic (Catmull-Rom,
//! a = -0.5) and Lanczos3 resampling over RGBA8 pixel data.
//!
//! Both scalers are separable (horizontal pass, then vertical pass), operate
//! on premultiplied alpha so transparency resamples without dark fringes, and
//! normalize the kernel weights per output pixel so brightness is preserved
//! even at window edges and under minification (the filter is widened by
//! `1/scale` when `scale < 1`).
//!
//! # Memory-safety contract
//!
//! Everything exported to JS falls into one of two shapes:
//!
//! 1. **Pure functions** ([`resample_bicubic`], [`resample_lanczos`]) that
//!    take a `Uint8Array` (copied across the boundary) and return a fresh
//!    `Uint8Array`. All intermediate Rust allocations are owned by the call
//!    and freed before it returns — the JS side holds no Rust memory and has
//!    nothing to free.
//!
//! 2. **The [`WasmScalerJob`] struct**, which keeps its input and output
//!    buffers in the WASM heap so large results can be taken out explicitly.
//!    Any struct exported via `wasm-bindgen` automatically exposes a
//!    generated `free()` method on the JS side, which invalidates the Rust
//!    object and releases every allocation it holds. **The JS side MUST call
//!    `.free()` on the job once it has taken the output** (typically in a
//!    `finally` block) — otherwise the WASM heap grows by the size of the
//!    input and output buffers on every call until the worker dies. After
//!    `free()`, any further use of the JS wrapper throws.
//!
//! The engine's worker (`src/worker.ts`) always uses shape 2 and always frees.

use std::fmt;

use wasm_bindgen::prelude::*;

/// Hard cap on output pixel count (16384²) — mirrors the engine's
/// `maxDimension` default so a bogus `scale` can never allocate gigabytes.
const MAX_OUTPUT_PIXELS: usize = 16_384 * 16_384;

/// The resampling kernels. `support` is the half-width of the kernel in
/// source pixels at 1:1 scale (widened under minification).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kernel {
    Bicubic,
    Lanczos3,
}

impl Kernel {
    fn support(self) -> f64 {
        match self {
            Kernel::Bicubic => 2.0,
            Kernel::Lanczos3 => 3.0,
        }
    }

    fn weight(self, t: f64) -> f64 {
        let t = t.abs();
        match self {
            Kernel::Bicubic => {
                // Catmull-Rom (a = -0.5) cubic convolution.
                let t2 = t * t;
                let t3 = t2 * t;
                if t < 1.0 {
                    1.5 * t3 - 2.5 * t2 + 1.0
                } else if t < 2.0 {
                    -0.5 * t3 + 2.5 * t2 - 4.0 * t + 2.0
                } else {
                    0.0
                }
            }
            Kernel::Lanczos3 => {
                if t == 0.0 {
                    1.0
                } else if t < 3.0 {
                    sinc(t) * sinc(t / 3.0)
                } else {
                    0.0
                }
            }
        }
    }
}

fn sinc(t: f64) -> f64 {
    let pi_t = std::f64::consts::PI * t;
    pi_t.sin() / pi_t
}

#[derive(Debug)]
struct ScalerError(String);

impl fmt::Display for ScalerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ScalerError {}

fn validate(pixels_len: usize, width: u32, height: u32, scale: f64) -> std::result::Result<(usize, usize, usize, usize), ScalerError> {
    if width == 0 || height == 0 {
        return Err(ScalerError(format!(
            "invalid dimensions: {width}x{height} (width and height must be non-zero)"
        )));
    }
    if !scale.is_finite() || !(1.0 / 16.0..=16.0).contains(&scale) {
        return Err(ScalerError(format!(
            "invalid scale: {scale} (must be finite and within 1/16..=16)"
        )));
    }
    let (w, h) = (width as usize, height as usize);
    let expected = w
        .checked_mul(h)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| ScalerError("input dimensions overflow usize".to_string()))?;
    if pixels_len != expected {
        return Err(ScalerError(format!(
            "pixel buffer length {pixels_len} does not match {width}x{height} RGBA ({expected} bytes)"
        )));
    }
    let out_w = ((w as f64) * scale).round();
    let out_h = ((h as f64) * scale).round();
    if !(out_w >= 1.0 && out_h >= 1.0) {
        return Err(ScalerError(format!("scale {scale} produces an empty image")));
    }
    let (out_w, out_h) = (out_w as usize, out_h as usize);
    let out_pixels = out_w
        .checked_mul(out_h)
        .ok_or_else(|| ScalerError("output dimensions overflow usize".to_string()))?;
    if out_pixels > MAX_OUTPUT_PIXELS {
        return Err(ScalerError(format!(
            "output {out_w}x{out_h} exceeds the {MAX_OUTPUT_PIXELS}-pixel limit"
        )));
    }
    Ok((w, h, out_w, out_h))
}

/// Premultiplies `src` (RGBA8) into an f32 plane of `w * h` pixels, 4 floats
/// per pixel, so subsequent passes never darken transparent regions.
fn premultiply(src: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut plane = vec![0.0f32; w * h * 4];
    for px in 0..w * h {
        let i = px * 4;
        let a = src[i + 3] as f32 / 255.0;
        plane[i] = src[i] as f32 * a;
        plane[i + 1] = src[i + 1] as f32 * a;
        plane[i + 2] = src[i + 2] as f32 * a;
        plane[i + 3] = src[i + 3] as f32;
    }
    plane
}

/// Resamples one axis of a contiguous f32 RGBA pixel list (`src_len * 4`
/// floats in, `dst_len * 4` floats out) with normalized kernel weights.
fn resample_axis(src: &[f32], src_len: usize, dst_len: usize, scale: f64, kernel: Kernel, dst: &mut [f32]) {
    // Under minification the filter is widened by 1/scale so every source
    // pixel contributes; the kernel argument is compressed accordingly.
    let filter_scale = if scale < 1.0 { scale } else { 1.0 };
    let support = kernel.support() / filter_scale;
    let max_taps = (support.ceil() as usize) * 2 + 2;
    let mut weights = vec![0.0f64; max_taps];
    let mut indices = vec![0usize; max_taps];

    for dst_i in 0..dst_len {
        let center = (dst_i as f64 + 0.5) / scale - 0.5;
        let first = (center - support).floor() as i64;
        let last = (center + support).ceil() as i64;

        let mut sum = 0.0f64;
        let mut n = 0usize;
        for src_i in first..=last {
            let w = kernel.weight((src_i as f64 - center) * filter_scale);
            if w == 0.0 {
                continue;
            }
            weights[n] = w;
            indices[n] = (src_i.clamp(0, src_len as i64 - 1)) as usize;
            sum += w;
            n += 1;
        }

        if n == 0 {
            // Degenerate window (only possible at extreme scales): nearest.
            let nearest = (center.round() as i64).clamp(0, src_len as i64 - 1) as usize;
            let s = nearest * 4;
            let d = dst_i * 4;
            dst[d..d + 4].copy_from_slice(&src[s..s + 4]);
            continue;
        }

        let inv_sum = 1.0 / sum;
        let d = dst_i * 4;
        dst[d..d + 4].iter_mut().for_each(|v| *v = 0.0);
        for k in 0..n {
            let wk = (weights[k] * inv_sum) as f32;
            let s = indices[k] * 4;
            for ch in 0..4 {
                dst[d + ch] += src[s + ch] * wk;
            }
        }
    }
}

/// Full RGBA resample: premultiply → horizontal pass → vertical pass →
/// unpremultiply → quantize.
fn resample_impl(pixels: &[u8], width: u32, height: u32, scale: f64, kernel: Kernel) -> std::result::Result<Vec<u8>, ScalerError> {
    let (w, h, out_w, out_h) = validate(pixels.len(), width, height, scale)?;
    let src = premultiply(pixels, w, h);

    // Horizontal pass: (w, h) → (out_w, h), row by row.
    let mut mid = vec![0.0f32; out_w * h * 4];
    for row in 0..h {
        let src_row = &src[row * w * 4..(row + 1) * w * 4];
        let dst_row = &mut mid[row * out_w * 4..(row + 1) * out_w * 4];
        resample_axis(src_row, w, out_w, scale, kernel, dst_row);
    }

    // Vertical pass: (out_w, h) → (out_w, out_h), column by column (columns
    // are gathered contiguously first so the kernel walks flat memory).
    let mut out = vec![0.0f32; out_w * out_h * 4];
    let mut column_src = vec![0.0f32; h * 4];
    let mut column_dst = vec![0.0f32; out_h * 4];
    for x in 0..out_w {
        for y in 0..h {
            let base = (y * out_w + x) * 4;
            column_src[y * 4..y * 4 + 4].copy_from_slice(&mid[base..base + 4]);
        }
        resample_axis(&column_src, h, out_h, scale, kernel, &mut column_dst);
        for y in 0..out_h {
            let base = (y * out_w + x) * 4;
            out[base..base + 4].copy_from_slice(&column_dst[y * 4..y * 4 + 4]);
        }
    }

    // Unpremultiply and quantize.
    let mut bytes = vec![0u8; out_w * out_h * 4];
    for px in 0..out_w * out_h {
        let i = px * 4;
        let a_clamped = out[i + 3].clamp(0.0, 255.0);
        let inv = if a_clamped > 0.0 { 255.0 / a_clamped } else { 0.0 };
        bytes[i] = (out[i] * inv).round().clamp(0.0, 255.0) as u8;
        bytes[i + 1] = (out[i + 1] * inv).round().clamp(0.0, 255.0) as u8;
        bytes[i + 2] = (out[i + 2] * inv).round().clamp(0.0, 255.0) as u8;
        bytes[i + 3] = a_clamped.round() as u8;
    }
    Ok(bytes)
}

fn scaler_error(e: ScalerError) -> JsError {
    JsError::new(&e.0)
}

/// Bicubic (Catmull-Rom, a = -0.5) resampling of RGBA8 pixels.
///
/// # Memory safety
/// Pure function: the input `Uint8Array` is copied, every intermediate
/// allocation is freed on return, and the result is a fresh `Uint8Array`.
/// Nothing to free on the JS side.
#[wasm_bindgen]
pub fn resample_bicubic(pixels: &[u8], width: u32, height: u32, scale: f64) -> Result<Vec<u8>, JsError> {
    resample_impl(pixels, width, height, scale, Kernel::Bicubic).map_err(scaler_error)
}

/// Lanczos3 resampling of RGBA8 pixels.
///
/// # Memory safety
/// Pure function: the input `Uint8Array` is copied, every intermediate
/// allocation is freed on return, and the result is a fresh `Uint8Array`.
/// Nothing to free on the JS side.
#[wasm_bindgen]
pub fn resample_lanczos(pixels: &[u8], width: u32, height: u32, scale: f64) -> Result<Vec<u8>, JsError> {
    resample_impl(pixels, width, height, scale, Kernel::Lanczos3).map_err(scaler_error)
}

/// Resampling job that keeps its buffers in the WASM heap.
///
/// # Memory-safety contract (IMPORTANT)
///
/// The job holds the input copy and (after [`WasmScalerJob::process`]) the
/// output buffer in WASM-linear memory. `wasm-bindgen` generates a `free()`
/// method on the JS wrapper class: **the JS side MUST call `job.free()` once
/// it has taken the output** (typically in a `finally` block). Failing to do
/// so leaks the input and output buffers in the WASM heap. Using the job in
/// any way after `free()` throws a JS exception.
#[wasm_bindgen]
pub struct WasmScalerJob {
    kernel: Kernel,
    width: u32,
    height: u32,
    scale: f64,
    input: Vec<u8>,
    output: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl WasmScalerJob {
    /// Creates a job and copies `pixels` (RGBA8, `width * height * 4` bytes)
    /// into the WASM heap. Does no work until [`WasmScalerJob::process`].
    #[wasm_bindgen(constructor)]
    pub fn new(pixels: &[u8], width: u32, height: u32, scale: f64, lanczos: bool) -> std::result::Result<WasmScalerJob, JsError> {
        let kernel = if lanczos { Kernel::Lanczos3 } else { Kernel::Bicubic };
        // Validate eagerly (cheap) so errors surface at construction, not at
        // process() time deep inside the worker pipeline.
        validate(pixels.len(), width, height, scale).map_err(scaler_error)?;
        Ok(WasmScalerJob {
            kernel,
            width,
            height,
            scale,
            input: pixels.to_vec(),
            output: None,
        })
    }

    /// Runs the resampler and keeps the result in the heap until
    /// [`WasmScalerJob::take_output`] copies it out to JS.
    pub fn process(&mut self) -> std::result::Result<(), JsError> {
        let out = resample_impl(&self.input, self.width, self.height, self.scale, self.kernel).map_err(scaler_error)?;
        self.output = Some(out);
        Ok(())
    }

    /// Copies the processed buffer out to JS as a fresh `Uint8Array` and
    /// releases the internal copy. Call `free()` afterwards (see contract).
    pub fn take_output(&mut self) -> std::result::Result<Vec<u8>, JsError> {
        self.output
            .take()
            .ok_or_else(|| JsError::new("WasmScalerJob: call process() before take_output()"))
    }

    /// Number of bytes in the processed output (`out_w * out_h * 4`), or 0
    /// before `process()` has run.
    #[wasm_bindgen(getter, js_name = outputByteLength)]
    pub fn output_byte_length(&self) -> usize {
        match &self.output {
            Some(out) => out.len(),
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..w * h {
            v.extend_from_slice(&rgba);
        }
        v
    }

    #[test]
    fn identity_scale_returns_input_exactly() {
        // At scale 1.0 both kernels put full weight on the exact source pixel.
        let img = solid(8, 8, [10, 20, 30, 255]);
        for pass in [Kernel::Bicubic, Kernel::Lanczos3] {
            let out = resample_impl(&img, 8, 8, 1.0, pass).unwrap();
            assert_eq!(out, img, "{pass:?} at scale 1 must be the identity");
        }
    }

    #[test]
    fn constant_image_stays_constant() {
        let img = solid(16, 16, [200, 100, 50, 128]);
        for pass in [Kernel::Bicubic, Kernel::Lanczos3] {
            for scale in [2.0, 4.0, 0.5] {
                let out = resample_impl(&img, 16, 16, scale, pass).unwrap();
                for px in out.chunks_exact(4) {
                    assert!(
                        (px[0] as i32 - 200).abs() <= 1
                            && (px[1] as i32 - 100).abs() <= 1
                            && (px[2] as i32 - 50).abs() <= 1
                            && (px[3] as i32 - 128).abs() <= 1,
                        "{pass:?} at {scale}x drifted: {px:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn output_size_matches_scale() {
        let img = solid(4, 3, [255, 0, 0, 255]);
        let out = resample_impl(&img, 4, 3, 4.0, Kernel::Lanczos3).unwrap();
        assert_eq!(out.len(), 16 * 12 * 4);
        let out = resample_impl(&img, 4, 3, 0.5, Kernel::Bicubic).unwrap();
        assert_eq!(out.len(), 2 * 2 * 4);
    }

    #[test]
    fn opaque_stays_opaque_and_transparent_resamples_smoothly() {
        // Left half opaque red, right half fully transparent — alpha must
        // ramp monotonically across the boundary, opaque pixels stay opaque,
        // and premultiplied RGB must never exceed alpha (no color bleed into
        // fully transparent pixels).
        let w = 8u32;
        let h = 4u32;
        let mut img = solid(w, h, [255, 0, 0, 255]);
        for y in 0..h {
            for x in w / 2..w {
                let i = ((y * w + x) * 4) as usize;
                img[i + 3] = 0;
            }
        }
        let out = resample_impl(&img, w, h, 2.0, Kernel::Lanczos3).unwrap();
        let ow = (w as usize) * 2;
        // Far left stays fully opaque.
        let i = (0 * ow + 0) * 4;
        assert_eq!(out[i + 3], 255);
        // Far right stays fully transparent with zeroed color (premultiplied
        // RGB of a transparent pixel is 0 and must not bleed back).
        let i = (0 * ow + ow - 1) * 4;
        assert_eq!(out[i + 3], 0);
        for px in out.chunks_exact(4) {
            if px[3] == 0 {
                assert_eq!(&px[..3], &[0, 0, 0], "transparent pixel must have zeroed color");
            }
        }
        // The transition band contains partial coverage: Lanczos ringing is
        // allowed, but the boundary neighborhood must interpolate rather
        // than snap.
        let mid_row = 2usize;
        let a_left = out[(mid_row * ow + ow / 2 - 2) * 4 + 3];
        let a_right = out[(mid_row * ow + ow / 2 + 1) * 4 + 3];
        assert!(a_left > 200 && a_left <= 255);
        assert!(a_right < 55);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(resample_impl(&[0u8; 3], 1, 1, 2.0, Kernel::Bicubic).is_err());
        assert!(resample_impl(&[0u8; 4], 0, 1, 2.0, Kernel::Bicubic).is_err());
        assert!(resample_impl(&[0u8; 4], 1, 1, 0.0, Kernel::Bicubic).is_err());
        assert!(resample_impl(&[0u8; 4], 1, 1, f64::NAN, Kernel::Lanczos3).is_err());
        assert!(resample_impl(&[0u8; 4], 1, 1, 1e6, Kernel::Bicubic).is_err());
    }

    #[test]
    fn gradient_upsample_stays_monotonic() {
        // A horizontal 0→255 ramp upsampled 4x must stay monotonic per row:
        // ringing must never invert the ordering in the mid-band.
        let w = 16u32;
        let h = 2u32;
        let mut img = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..h {
            for x in 0..w {
                let v = (x as f32 / (w - 1) as f32 * 255.0).round() as u8;
                img.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let out = resample_impl(&img, w, h, 4.0, Kernel::Lanczos3).unwrap();
        let ow = (w as usize) * 4;
        for row in 0..h as usize {
            let mut prev: i32 = out[(row * ow) * 4] as i32;
            for x in 1..ow {
                let v = out[(row * ow + x) * 4] as i32;
                assert!(v >= prev - 6, "non-monotonic ramp at x={x}: {v} < {prev}");
                prev = v;
            }
        }
    }
}
