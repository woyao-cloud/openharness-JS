/**
 * Image auto-downscale — bound the longest dimension to a fixed maximum
 * before encoding the image as base64 for the model.
 *
 * Why: most providers reject or downsample images above ~1568-2048px on
 * the longest side. Shipping a 4000px screenshot wastes input tokens, can
 * exceed the request size limit, and historically broke the session
 * outright when an oversized image landed in the conversation history.
 *
 * The function is a no-op for images already within bounds, for formats
 * sharp doesn't process (PDF, SVG), and when sharp itself isn't installed
 * (it's an `optionalDependency` so unsupported platforms still install).
 * Any sharp error returns the original buffer unchanged — we never break a
 * tool call over a downscale failure.
 */

const DEFAULT_MAX_DIMENSION = 2000;

const SHARP_SUPPORTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

type SharpModule = typeof import("sharp");

let _sharpModule: SharpModule | null | undefined;

/** Lazy-load sharp; cache the result so we don't pay the import cost per image. */
async function getSharp(): Promise<SharpModule | null> {
  if (_sharpModule !== undefined) return _sharpModule;
  try {
    const mod = (await import("sharp")) as { default?: SharpModule } & SharpModule;
    _sharpModule = (mod.default ?? mod) as SharpModule;
    return _sharpModule;
  } catch {
    _sharpModule = null;
    return null;
  }
}

/** @internal Test-only reset of the lazy sharp cache. */
export function _resetSharpCacheForTest(): void {
  _sharpModule = undefined;
}

export type DownscaleResult = {
  /** The (possibly resized) buffer to encode. */
  buffer: Buffer;
  /** True if a resize actually happened; false for passthrough. */
  downscaled: boolean;
  /** Set when sharp wasn't available — caller may want to surface a one-time hint. */
  reason?: "sharp-unavailable" | "unsupported-format" | "within-bounds" | "sharp-error";
};

/**
 * Downscale `buffer` so its longest dimension is ≤ `maxDimension` (default 2000).
 * Aspect ratio preserved. Format preserved (PNG stays PNG, JPEG stays JPEG, etc.).
 *
 * Pure pass-through for: PDF, SVG, BMP (sharp doesn't handle reliably),
 * already-small images, missing sharp, and any sharp error.
 */
export async function downscaleIfLarge(
  buffer: Buffer,
  mediaType: string,
  maxDimension: number = DEFAULT_MAX_DIMENSION,
): Promise<DownscaleResult> {
  if (!SHARP_SUPPORTED_TYPES.has(mediaType)) {
    return { buffer, downscaled: false, reason: "unsupported-format" };
  }

  const sharp = await getSharp();
  if (!sharp) {
    return { buffer, downscaled: false, reason: "sharp-unavailable" };
  }

  try {
    const pipeline = sharp(buffer);
    const meta = await pipeline.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w === 0 || h === 0) {
      // Animated GIFs can report 0 here; pass through rather than mangle.
      return { buffer, downscaled: false, reason: "unsupported-format" };
    }
    if (Math.max(w, h) <= maxDimension) {
      return { buffer, downscaled: false, reason: "within-bounds" };
    }
    // `fit: "inside"` + `withoutEnlargement: true` resizes proportionally
    // so the longest side equals maxDimension, with no upscaling.
    const out = await pipeline
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toBuffer();
    return { buffer: out, downscaled: true };
  } catch {
    // Corrupt image, unsupported subformat, etc. — never fail the tool over this.
    return { buffer, downscaled: false, reason: "sharp-error" };
  }
}
