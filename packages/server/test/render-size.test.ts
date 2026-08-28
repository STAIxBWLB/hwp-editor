/**
 * Page-dimension parser tests (BUG-04, D-16, D-17).
 *
 * The two parsers are the trust boundary between subprocess output and
 * `PageCanvas`'s `aspectRatio`, which collapses on a zero. A payload whose
 * dimensions cannot be read must return null so the caller can throw, and a
 * long non-PNG payload must not masquerade as a sized image by yielding two
 * arbitrary uint32s.
 */

import { describe, expect, it } from "vitest";

import type { DocumentSpecV2 } from "@hwp-editor/core";

import { createCliEngine, pngSize, svgSize } from "../src/cli-engine.js";
import { BIN, describeBin, sampleSpec } from "./helpers.js";

/** The verified real hwp-cli PNG header: signature, length, `IHDR`. */
const PNG_HEADER = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
];

/** A 32-byte PNG whose IHDR carries the given big-endian dimensions. */
function png(width: number, height: number): Uint8Array {
  const data = new Uint8Array(32);
  data.set(PNG_HEADER, 0);
  const view = new DataView(data.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return data;
}

describe("pngSize", () => {
  it("reads the dimensions of a real hwp-cli PNG header", () => {
    expect(pngSize(png(1240, 1754))).toEqual({ width: 1240, height: 1754 });
  });

  it("returns null for a buffer shorter than the header", () => {
    expect(pngSize(new Uint8Array(23))).toBeNull();
    expect(pngSize(new Uint8Array(0))).toBeNull();
  });

  it("returns null for a long payload that is not a PNG", () => {
    // 64 zero bytes: long enough to pass the old length check, and the two
    // uint32s it would have yielded are meaningless.
    expect(pngSize(new Uint8Array(64))).toBeNull();
  });

  it("returns null when the signature is right but the chunk type is not IHDR", () => {
    const data = png(100, 200);
    data.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT"
    expect(pngSize(data)).toBeNull();
  });

  it("returns null for a well-formed header carrying a zero dimension", () => {
    expect(pngSize(png(0, 1754))).toBeNull();
    expect(pngSize(png(1240, 0))).toBeNull();
    expect(pngSize(png(0, 0))).toBeNull();
  });
});

describe("svgSize", () => {
  it("reads hwp-cli's real root tag", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="595.28pt" height="841.86pt" viewBox="0 0 595.28 841.86">';
    expect(svgSize(svg)).toEqual({ width: 595.28, height: 841.86 });
  });

  it("falls back to viewBox when the root tag carries no width/height", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595.28 841.86">';
    expect(svgSize(svg)).toEqual({ width: 595.28, height: 841.86 });
  });

  it("accepts mm, in, cm, em and % unit suffixes as well as pt and px", () => {
    for (const unit of ["pt", "px", "mm", "in", "cm", "em", "%"]) {
      const svg = `<svg width="210${unit}" height="297${unit}">`;
      expect(svgSize(svg), unit).toEqual({ width: 210, height: 297 });
    }
  });

  it("returns null when width and height carry different units", () => {
    // Same-unit pairs are comparable; mixed units would silently corrupt
    // the aspect ratio, so they fail loudly like any unreadable dimension.
    expect(svgSize('<svg width="210mm" height="841.86pt">')).toBeNull();
    expect(svgSize('<svg width="595.28pt" height="842">')).toBeNull();
    expect(svgSize('<svg width="210" height="297mm">')).toBeNull();
  });

  it("returns null for degenerate dimension values", () => {
    expect(svgSize('<svg width="NaN" height="841.86">')).toBeNull();
    expect(svgSize('<svg width="inf" height="841.86">')).toBeNull();
    expect(svgSize('<svg width="-5.00" height="841.86">')).toBeNull();
    expect(svgSize('<svg width="0" height="841.86">')).toBeNull();
    expect(svgSize('<svg width="595.28" height="0">')).toBeNull();
  });

  it("returns null when there is no <svg tag at all", () => {
    expect(svgSize("not markup")).toBeNull();
    expect(svgSize("")).toBeNull();
  });
});

describeBin("render dimensions (real hwp-cli binary)", () => {
  it("returns strictly positive dimensions on every page", async () => {
    const cli = createCliEngine({ bin: BIN });
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "size.hwpx");
    for (const format of ["svg", "png"] as const) {
      const pages = await cli.render(composed.document, { format });
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        expect(page.width, `${format} page ${page.page} width`).toBeGreaterThan(0);
        expect(page.height, `${format} page ${page.page} height`).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});
