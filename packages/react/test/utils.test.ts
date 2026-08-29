import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../src/sanitize.js";
import { plainSegmentText } from "../src/text.js";
import { parseMarkdownTable, findTables, tableAtRef } from "../src/tables.js";
import { extractFieldSlots } from "../src/fields.js";
import { buildDocumentSpec, bodyToBlocks } from "../src/presets.js";
import { createT } from "../src/messages.js";
import { nearestSegment, segmentBand } from "../src/geometry.js";
import { makeEnvelope } from "./mock-engine.js";

describe("sanitizeSvg", () => {
  it("strips script and foreignObject", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' +
      '<foreignObject><div>x</div></foreignObject><rect width="10" height="10"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("foreignObject");
    expect(clean).toContain("rect");
  });

  it("strips event handler attributes", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" width="10" height="10"/></svg>';
    expect(sanitizeSvg(dirty)).not.toContain("onclick");
  });

  it("returns empty string for malformed input", () => {
    expect(sanitizeSvg("not xml at all <<<")).toBe("");
  });
});

describe("plainSegmentText", () => {
  it("strips heading and emphasis markers", () => {
    expect(plainSegmentText("# **1. 회의록**")).toBe("1. 회의록");
  });

  it("keeps link labels", () => {
    expect(plainSegmentText("[홈페이지](https://example.com)")).toBe("홈페이지");
  });
});

describe("tables", () => {
  const envelope = makeEnvelope();

  it("parses GFM tables, skipping the separator row", () => {
    const rows = parseMarkdownTable(
      "| 항목 | 담당 |\n| --- | --- |\n| 예산 | 김철수 |",
    );
    expect(rows).toEqual([
      ["항목", "담당"],
      ["예산", "김철수"],
    ]);
  });

  it("finds tables in document order with CLI-compatible indices", () => {
    const tables = findTables(envelope);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.tableIndex).toBe(0);
  });

  it("locates a table by segment ref", () => {
    const table = tableAtRef(envelope, { section: 0, para: 2 });
    expect(table?.rows[1]).toEqual(["예산", "김철수"]);
  });
});

describe("fields", () => {
  it("extracts {{name}} slots with their segment", () => {
    const slots = extractFieldSlots(makeEnvelope());
    expect(slots).toEqual([
      { name: "date", segment: { section: 0, para: 3 } },
    ]);
  });
});

describe("presets", () => {
  it("builds a DocumentSpec v2 with preset profile", () => {
    const spec = buildDocumentSpec("report", {
      title: "테스트 보고서",
      author: "이영준",
      body: "# 1. 개요\n\n본문 내용입니다.",
    });
    expect(spec.version).toBe("2.0");
    expect(spec.document.version).toBe("1.0");
    expect(spec.document.metadata?.title).toBe("테스트 보고서");
    expect(spec.document.metadata?.author).toBe("이영준");
    const section = spec.document.sections[0];
    expect(section.page_number?.position).toBe("bottom_center");
    expect(section.blocks[0]).toMatchObject({ type: "paragraph", style: "title" });
    expect(section.blocks[1]).toMatchObject({ type: "paragraph", style: "heading" });
    expect(section.blocks[2]).toMatchObject({ type: "paragraph", style: "body" });
    expect(spec.document.styles?.["body"]?.font_family).toBe("함초롬바탕");
  });

  it("omits page numbers for presets without them", () => {
    const spec = buildDocumentSpec("official", { title: "", author: "", body: "내용" });
    expect(spec.document.sections[0]?.page_number).toBeUndefined();
    expect(spec.document.metadata?.title).toBeUndefined();
  });

  it("parses markdown-ish body into blocks", () => {
    expect(bodyToBlocks("# 제목\n\n본문\n\n# 둘째")).toHaveLength(3);
  });

  // I18N-05: preset PROFILES are document data, not chrome. `buildDocumentSpec`
  // takes no locale at all — that is the structural guarantee, and these
  // assertions pin it. Composing the way ComposePanel does under each intended
  // UI locale must yield byte-identical font fields.
  it("composes locale-invariant font data under either UI locale", () => {
    for (const locale of ["en", "ko"] as const) {
      const t = createT(locale);
      // The only locale-dependent input ComposePanel feeds the builder.
      const title = t("compose.defaultFileStem");
      expect(title).toBe(locale === "ko" ? "새 문서" : "New document");

      const malgun = buildDocumentSpec("official", { title, author: "", body: "x" });
      const batang = buildDocumentSpec("report", { title, author: "", body: "x" });
      expect(malgun.document.styles?.["body"]?.font_family).toBe("맑은 고딕");
      expect(malgun.document.styles?.["heading"]?.font_family).toBe("맑은 고딕");
      expect(malgun.document.styles?.["title"]?.font_family).toBe("맑은 고딕");
      expect(batang.document.styles?.["body"]?.font_family).toBe("함초롬바탕");
      expect(batang.document.styles?.["heading"]?.font_family).toBe("함초롬바탕");
      expect(batang.document.styles?.["title"]?.font_family).toBe("함초롬바탕");
    }
  });

  // I18N-05 empty edge: an empty form still composes, with the table-supplied
  // default stem as the title and one placeholder paragraph.
  it("composes an empty form with the default stem and no sections lost", () => {
    for (const locale of ["en", "ko"] as const) {
      const spec = buildDocumentSpec("official", {
        title: createT(locale)("compose.defaultFileStem"),
        author: "",
        body: "",
      });
      expect(spec.document.sections).toHaveLength(1);
      expect(spec.document.sections[0]?.blocks).toHaveLength(1);
      expect(spec.document.styles?.["body"]?.font_family).toBe("맑은 고딕");
    }
  });
});

describe("geometry", () => {
  const envelope = makeEnvelope();

  it("maps a click fraction to the covering segment", () => {
    const first = nearestSegment(envelope, 0, 0.01, 1);
    expect(first?.para).toBe(0);
    const last = nearestSegment(envelope, 0, 0.99, 1);
    expect(last?.para).toBe(3);
  });

  it("snaps clicks between segments to the nearest segment", () => {
    // A fraction landing in the blank gap after segment 0.
    const gap = (envelope.segments[0]!.end + 1) / envelope.markdown.length;
    const hit = nearestSegment(envelope, 0, gap, 1);
    expect(hit).toBeDefined();
  });

  it("segmentBand is the inverse of the click mapping", () => {
    const segment = envelope.segments[2]!;
    const band = segmentBand(envelope, segment, 1);
    expect(band).not.toBeNull();
    const hit = nearestSegment(envelope, band!.pageIndex, (band!.top + band!.height / 2) / 100, 1);
    expect(hit?.para).toBe(2);
  });
});
