import { describe, expect, it } from "vitest";
import type { CatEnvelope, LayoutRow, PageImage, Segment } from "@hwp-editor/core";
import { bandsOnPage, nearestSegment, segmentOnPage } from "../src/geometry.js";

const segment = (id: string, kind: Segment["kind"], para: number, indices = [para]): Segment =>
  ({ id, kind, para, section: 0, start: para * 10, end: para * 10 + 10, indices });
const table = segment("table", "table", 0);
const left = segment("left", "para", 0, [0, 0, 0, 0]);
const right = segment("right", "para", 0, [0, 0, 1, 0]);
const run = segment("right-run", "run", 0, [0, 0, 1, 0, 0]);
const envelope: CatEnvelope = { markdown: "content repeated twice", segments: [table, left, right, run] };
const row = (id: string, x0: number, x1: number, y0 = 100, y1 = 120): LayoutRow =>
  ({ id, kind: "para", box: { x0, x1, y0, y1 }, source_chars: { start: 50, end: 60 } });
const page: PageImage = { page: 3, width: 1200, height: 1600, dpi: 144, format: "png", data: new Uint8Array(),
  layout: { width_pt: 600, height_pt: 800, truncated: false, rows: [
    { ...row("table", 50, 550, 80, 300), kind: "table", source_chars: null },
    row("left", 60, 250), row("right", 300, 500),
  ] } };

describe("layout geometry", () => {
  it("uses both axes and IDs for nested segments sharing a paragraph coordinate", () => {
    expect(segmentOnPage(envelope, page, 100 / 600, 110 / 800, 0, 1)).toBe(left);
    expect(segmentOnPage(envelope, page, 400 / 600, 110 / 800, 0, 1)).toBe(right);
  });

  it("uses actual page geometry independent of page number, DPI and image format", () => {
    const svg = { ...page, page: 7, dpi: 96, width: 600, height: 800, format: "svg" as const };
    expect(segmentOnPage(envelope, svg, 2 / 3, 110 / 800, 0, 1)).toBe(right);
    expect(bandsOnPage(envelope, right, svg, 0, 1)).toEqual(bandsOnPage(envelope, right, page, 0, 1));
  });

  it("retains every fragment of a repeated ID and uses paragraph geometry for runs", () => {
    const fragments = { ...page, layout: { ...page.layout!, rows: [row("right", 300, 500), row("right", 60, 200, 400, 420)] } };
    expect(bandsOnPage(envelope, right, fragments, 0, 1)).toHaveLength(2);
    expect(bandsOnPage(envelope, run, fragments, 0, 1)).toEqual(bandsOnPage(envelope, right, fragments, 0, 1));
    expect(bandsOnPage(envelope, right, fragments, 0, 1)[0]).toEqual({ left: 50, top: 12.5, width: 200 / 600 * 100, height: 2.5 });
  });

  it("does not fabricate geometry for null, missing, unknown or truncated rows", () => {
    for (const rows of [[], [{ ...row("right", 0, 0), box: null }], [row("unknown", 50, 100)]]) {
      const empty = { ...page, layout: { ...page.layout!, rows, truncated: true } };
      expect(segmentOnPage(envelope, empty, 0.5, 0.5, 0, 1)).toBeUndefined();
      expect(bandsOnPage(envelope, right, empty, 0, 1)).toEqual([]);
    }
  });

  it("uses known hits but never guesses past a truncated recorded prefix", () => {
    const capped = { ...page, layout: { ...page.layout!, truncated: true, rows: [row("left", 60, 250)] } };
    expect(segmentOnPage(envelope, capped, 100 / 600, 110 / 800, 0, 1)).toBe(left);
    expect(segmentOnPage(envelope, capped, 400 / 600, 110 / 800, 0, 1)).toBeUndefined();
  });

  it("uses the nearest measured rectangle for whitespace and flow only for older hosts", () => {
    const textOnly = { ...page, layout: { ...page.layout!, rows: [row("left", 60, 250), row("right", 300, 500)] } };
    expect(segmentOnPage(envelope, textOnly, 490 / 600, 130 / 800, 0, 1)).toBe(right);
    const { layout: _, ...legacy } = page;
    expect(segmentOnPage(envelope, legacy, 0.5, 0.5, 0, 1)).toBe(nearestSegment(envelope, 0, 0.5, 1));
  });
});
