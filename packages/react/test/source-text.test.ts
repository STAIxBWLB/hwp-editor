/**
 * #168: ops built from segment text use the paragraph's source text, not the
 * Markdown with generated numbering, and v1 selection bands use row geometry.
 * Fixtures re-measured with released ahwp 2.0.0 (originally captured on 1.6.3) for agent-hwp testdata
 * hwp-cli-plan-template.hwpx; `literal-*` is the same file with paragraph 0
 * set to `1. lit`, paragraph 3 to `- dash * star`, and paragraph 4 to `abc`.
 * Only the v2 schema number changed on 2.0.0; Markdown, segments and layouts
 * remained identical. See docs/ahwp-2.0.0-verification.md for reproduction.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatEnvelope, PageImage, Segment } from "@hwp-editor/core";
import { opsToJson, paragraphAddress, parseCatEnvelope, parseRenderLayouts } from "@hwp-editor/core";
import { bandsOnPage, segmentOnPage } from "../src/geometry.js";
import { paragraphSourceText } from "../src/text.js";

const fixture = (name: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "plan-template", name), "utf8");

function pagesFrom(layoutJson: string): PageImage[] {
  return [...parseRenderLayouts(layoutJson).entries()].map(([page, layout]) => ({
    page, width: layout.width_pt, height: layout.height_pt, dpi: 72, format: "svg" as const, data: new Uint8Array(), layout,
  }));
}

// v1 reaches the editor as the host projects it: the CLI envelope as is.
const v1 = JSON.parse(fixture("cat-v1.json")) as CatEnvelope;
const v2 = parseCatEnvelope(fixture("cat-v2.json"));
const pages = pagesFrom(fixture("all-layout.json"));
const literalV1 = JSON.parse(fixture("literal-v1.json")) as CatEnvelope;
const literalV2 = parseCatEnvelope(fixture("literal-v2.json"));
const literalPages = pagesFrom(fixture("literal-layout.json"));

const para = (envelope: CatEnvelope, index: number): Segment =>
  envelope.segments.find(s => s.kind === "para" && s.section === 0 && (s.indices ?? [s.para]).join() === String(index))!;

describe("replace uses source text (#168)", () => {
  it.each([["v1", v1], ["v2", v2]] as const)("AC1: drops generated numbering on paragraph 4 (%s)", (_, envelope) => {
    const text = paragraphSourceText(envelope, para(envelope, 4), pages);
    expect(text).toBe("사업명: {{사업명}}");
    const json = JSON.parse(opsToJson([{ kind: "replace", address: paragraphAddress(para(envelope, 4)), find: text, replace: "abc" }]));
    expect(json[0].from).toBe("사업명: {{사업명}}");
  });

  it("AC1: v2 needs no layout to tell numbering from source", () => {
    expect(paragraphSourceText(v2, para(v2, 4))).toBe("사업명: {{사업명}}");
  });

  it.each([["v1", literalV1], ["v2", literalV2]] as const)("AC2: keeps a literal `1. ` source prefix (%s)", (_, envelope) => {
    expect(paragraphSourceText(envelope, para(envelope, 0), literalPages)).toBe("1. lit");
    // The numbered paragraph beside it still loses its generated marker.
    expect(paragraphSourceText(envelope, para(envelope, 4), literalPages)).toBe("abc");
  });

  it("AC2: without layout or v2 runs, v1 text is unchanged (no guessing)", () => {
    expect(paragraphSourceText(literalV1, para(literalV1, 0))).toBe("1. lit");
    expect(paragraphSourceText(v1, para(v1, 4))).toBe("1. 사업명: {{사업명}}");
  });

  it.each([["v1", v1], ["v2", v2]] as const)("AC4: multi-level numbered paragraphs (%s)", (_, envelope) => {
    expect(paragraphSourceText(envelope, para(envelope, 9), pages)).toBe("추진 배경");
    expect(paragraphSourceText(envelope, para(envelope, 10), pages)).toBe("{{배경1}}");
    expect(paragraphSourceText(envelope, para(envelope, 11), pages)).toBe("{{배경2}}");
  });

  // Bullets: synthetic envelopes in the projection's shape, since the fixture has none.
  const bulleted = (markdown: string, sourceLength: number): [CatEnvelope, Segment, PageImage[]] => {
    const envelope: CatEnvelope = { markdown: `${markdown}\n`, segments: [{ kind: "para", section: 0, para: 0, start: 0, end: [...markdown].length }] };
    const page: PageImage = { page: 1, width: 600, height: 800, dpi: 72, format: "svg", data: new Uint8Array(),
      layout: { width_pt: 600, height_pt: 800, truncated: false,
        rows: [{ id: "0123456789abcdef.0.0", kind: "para", box: { x0: 0, x1: 100, y0: 10, y1: 30 }, source_chars: { start: 0, end: sourceLength } }] } };
    return [envelope, envelope.segments[0]!, [page]];
  };

  it.each(["- ", "* ", "+ ", "   - "])("AC4: generated bullet %j is dropped", (marker) => {
    expect(paragraphSourceText(...bulleted(`${marker}항목`, 2))).toBe("항목");
  });

  it("AC4: a literal leading dash in source is kept", () => {
    expect(paragraphSourceText(...bulleted("- 항목", 4))).toBe("- 항목");
    expect(paragraphSourceText(literalV2, para(literalV2, 3), literalPages)).toBe("- dash * star");
  });
});

describe("v1 selection band uses row geometry (#168)", () => {
  // Real line y extents in points from the evidence, page 1 of 2.
  const lines: Record<number, [number, number]> = { 4: [183.6, 204.85], 5: [210.4, 229.15] };

  it.each([4, 5])("AC3: band overlaps paragraph %i's rendered line with v1 input", (index) => {
    const v1Para = para(v1, index);
    const bands = bandsOnPage(v1, v1Para, pages[0]!, 0, pages.length);
    expect(bands).toHaveLength(1);
    const band = bands[0]!;
    expect(band.approximate).toBeUndefined();
    const top = band.top / 100 * pages[0]!.layout!.height_pt;
    const bottom = top + band.height / 100 * pages[0]!.layout!.height_pt;
    const v2Bands = bandsOnPage(v2, para(v2, index), pages[0]!, 0, pages.length);
    expect(band).toEqual(v2Bands[0]);
    const row = pages[0]!.layout!.rows.find(r => r.id.endsWith(`.0.${index}`))!;
    expect(top).toBeCloseTo(row.box!.y0, 3);
    expect(bottom).toBeCloseTo(row.box!.y1, 3);
    void lines;
  });

  it("AC3: evidence lines overlap for indices 3 and 4", () => {
    for (const [index, [y0, y1]] of [[3, lines[4]!], [4, lines[5]!]] as const) {
      const band = bandsOnPage(v1, para(v1, index), pages[0]!, 0, pages.length)[0]!;
      const h = pages[0]!.layout!.height_pt;
      const top = band.top / 100 * h;
      const bottom = top + band.height / 100 * h;
      expect(top < y1 && bottom > y0).toBe(true);
    }
  });

  it("a v1 click resolves through rows to the paragraph under it", () => {
    const h = pages[0]!.layout!.height_pt;
    const hit = segmentOnPage(v1, pages[0]!, 100 / 600, 220 / h, 0, pages.length);
    expect(hit).toBe(para(v1, 4));
  });

  it("paragraphs on page 2 band on page 2 only", () => {
    const p = para(v1, 26);
    expect(bandsOnPage(v1, p, pages[0]!, 0, 2)).toEqual([]);
    expect(bandsOnPage(v1, p, pages[1]!, 1, 2)).toHaveLength(1);
  });

  it("without layout the estimate is marked approximate", () => {
    const { layout: _, ...bare } = pages[0]!;
    const bands = bandsOnPage(v1, para(v1, 0), bare, 0, 1);
    expect(bands[0]?.approximate).toBe(true);
  });
});
