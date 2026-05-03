import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetSharpCacheForTest, downscaleIfLarge } from "./image-downscale.js";

/** Synthesize a solid-color PNG of the given dimensions via sharp. */
async function makePng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer();
}

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 50, g: 100, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

/** Read PNG/JPEG dimensions from the resulting buffer for assertions. */
async function dimensionsOf(buffer: Buffer): Promise<{ width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(buffer).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe("downscaleIfLarge", () => {
  beforeEach(() => {
    _resetSharpCacheForTest();
  });
  afterEach(() => {
    _resetSharpCacheForTest();
  });

  it("passes small images through unchanged", async () => {
    const buf = await makePng(1024, 768);
    const result = await downscaleIfLarge(buf, "image/png");
    assert.equal(result.downscaled, false);
    assert.equal(result.reason, "within-bounds");
    assert.equal(result.buffer, buf, "should return the same buffer reference");
  });

  it("passes images at exactly the threshold through unchanged (≤ not <)", async () => {
    const buf = await makePng(2000, 1500);
    const result = await downscaleIfLarge(buf, "image/png");
    assert.equal(result.downscaled, false);
    assert.equal(result.reason, "within-bounds");
  });

  it("downscales a wide image so the longest side is exactly 2000", async () => {
    const buf = await makePng(4000, 1000); // 4:1 aspect
    const result = await downscaleIfLarge(buf, "image/png");
    assert.equal(result.downscaled, true);
    const { width, height } = await dimensionsOf(result.buffer);
    assert.equal(width, 2000, "longest side should clamp to 2000");
    assert.equal(height, 500, "aspect ratio preserved (4:1 → 2000×500)");
  });

  it("downscales a tall image so the longest side is exactly 2000", async () => {
    const buf = await makePng(1000, 4000); // 1:4 aspect
    const result = await downscaleIfLarge(buf, "image/png");
    assert.equal(result.downscaled, true);
    const { width, height } = await dimensionsOf(result.buffer);
    assert.equal(height, 2000);
    assert.equal(width, 500);
  });

  it("preserves PNG format on downscale", async () => {
    const buf = await makePng(3000, 3000);
    const result = await downscaleIfLarge(buf, "image/png");
    assert.equal(result.downscaled, true);
    // PNG magic: 89 50 4E 47
    assert.equal(result.buffer[0], 0x89);
    assert.equal(result.buffer[1], 0x50);
    assert.equal(result.buffer[2], 0x4e);
    assert.equal(result.buffer[3], 0x47);
  });

  it("preserves JPEG format on downscale", async () => {
    const buf = await makeJpeg(3000, 2500);
    const result = await downscaleIfLarge(buf, "image/jpeg");
    assert.equal(result.downscaled, true);
    // JPEG magic: FF D8 FF
    assert.equal(result.buffer[0], 0xff);
    assert.equal(result.buffer[1], 0xd8);
    assert.equal(result.buffer[2], 0xff);
  });

  it("respects a custom max dimension", async () => {
    const buf = await makePng(2500, 2500);
    const result = await downscaleIfLarge(buf, "image/png", 1000);
    assert.equal(result.downscaled, true);
    const { width } = await dimensionsOf(result.buffer);
    assert.equal(width, 1000);
  });

  it("passes PDFs through unchanged (sharp doesn't process them)", async () => {
    // Minimal PDF header bytes — content irrelevant since we never touch it
    const buf = Buffer.from("%PDF-1.4\n%fake\n");
    const result = await downscaleIfLarge(buf, "application/pdf");
    assert.equal(result.downscaled, false);
    assert.equal(result.reason, "unsupported-format");
    assert.equal(result.buffer, buf);
  });

  it("passes SVG through unchanged", async () => {
    const buf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const result = await downscaleIfLarge(buf, "image/svg+xml");
    assert.equal(result.downscaled, false);
    assert.equal(result.reason, "unsupported-format");
  });

  it("returns a sharp-error reason on a corrupt image rather than throwing", async () => {
    const buf = Buffer.from("not actually an image at all");
    const result = await downscaleIfLarge(buf, "image/png");
    assert.equal(result.downscaled, false);
    assert.equal(result.reason, "sharp-error");
    // Must hand the original bytes back; the tool will encode as-is and the
    // caller sees the same behavior as if downscale weren't installed.
    assert.equal(result.buffer, buf);
  });
});
