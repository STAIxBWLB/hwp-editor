import { describe, expect, it } from "vitest";
import type { Segment } from "@hwp-editor/core";
import { COMPOSE_STYLE_ROWS, DOCUMENT_PROFILES, resolveSelection } from "@hwp-editor/core";
import { sanitizeSvg } from "../src/sanitize.js";
import { plainSegmentText } from "../src/text.js";
import { parseMarkdownTable, findTables, tableAtRef } from "../src/tables.js";
import { extractFieldSlots } from "../src/fields.js";
import { COMPOSE_PRESETS, buildDocumentSpec, bodyToBlocks } from "../src/presets.js";
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

  it("locates a slot after non-BMP characters by scalar offset (t18-14)", () => {
    // `match.index` counts UTF-16 units while a segment range counts scalars.
    // Each emoji is two units and one scalar, so five of them move the lookup
    // five scalars on, past the paragraph that holds the slot.
    const markdown = "😀😀😀😀😀{{a}}\n\nAfter";
    const emoji: Segment = { id: "emoji-p", indices: [0], start: 0, end: 5, kind: "para", section: 0, para: 0 };
    const slot: Segment = { id: "slot-p", indices: [1], start: 5, end: 10, kind: "para", section: 0, para: 1 };
    const after: Segment = { id: "after-p", indices: [2], start: 10, end: 19, kind: "para", section: 0, para: 2 };
    expect(extractFieldSlots({ markdown, segments: [emoji, slot, after] })).toEqual([
      { name: "a", segment: { section: 0, para: 1, id: "slot-p" } },
    ]);
  });

  it("locates a slot in a table cell on the cell's own paragraph (t18-15)", () => {
    // The projection lists the host paragraph, then the table, the cell and
    // the cell's paragraph, so the first segment covering the slot is the host.
    // Resolving to the host aims the inspector's Delete at the whole table.
    const markdown = "| {{x}} |";
    const host: Segment = { id: "host-p", indices: [0], start: 0, end: 9, kind: "para", section: 0, para: 0 };
    const table: Segment = { id: "tbl", indices: [0, 0], start: 0, end: 9, kind: "table", section: 0, para: 0 };
    const cell: Segment = { id: "cell", indices: [0, 0, 0], start: 2, end: 7, kind: "cell", section: 0, para: 0 };
    const cellPara: Segment = { id: "cell-p", indices: [0, 0, 0, 0], start: 2, end: 7, kind: "para", section: 0, para: 0 };
    expect(extractFieldSlots({ markdown, segments: [host, table, cell, cellPara] })).toEqual([
      { name: "x", segment: { section: 0, para: 0, id: "cell-p" } },
    ]);
    // A cell whose paragraph the projection omits is refused, not resolved to
    // the host paragraph whose range covers the whole table: keeping tables
    // and cells in the comparison is what makes this a skip.
    expect(extractFieldSlots({ markdown, segments: [host, table, cell] })).toEqual([]);
  });

  it("leaves out a slot whose paragraph names only its host (t18-18)", () => {
    // A nested paragraph with no id has no ref of its own: its coordinate
    // resolves to the host, so listing the slot would aim Delete at the host
    // and everything the projection nested inside it.
    const markdown = "{{x}}";
    const host: Segment = { id: "host-p", indices: [0], start: 0, end: 5, kind: "para", section: 0, para: 0 };
    const nested: Segment = { indices: [0, 1, 0, 0], start: 0, end: 5, kind: "para", section: 0, para: 0 };
    expect(extractFieldSlots({ markdown, segments: [host, nested] })).toEqual([]);
  });

  it("resolves a slot inside an HWP field through the run that holds it (t18-r4)", () => {
    // The projection emits a field segment whose range is its display text, at
    // the same depth as the run holding it, and that run is usually longer -
    // so depth-and-shorter-range picks the control, which resolveSelection
    // refuses as a container. The slot then vanished from the panel with no
    // signal, and these are exactly the slots `--set-field` fills.
    const markdown = "성명: {{name}} 귀하";
    const para: Segment = { id: "p", indices: [0], start: 0, end: 15, kind: "para", section: 0, para: 0 };
    const run: Segment = { id: "r", indices: [0, 0], start: 0, end: 14, kind: "run", section: 0, para: 0 };
    const field: Segment = { id: "fld", indices: [0, 1], start: 4, end: 12, kind: "field", section: 0, para: 0 };
    expect(extractFieldSlots({ markdown, segments: [para, run, field] })).toEqual([
      { name: "name", segment: { section: 0, para: 0, id: "p" } },
    ]);
    // Without a run in the projection the paragraph is still the answer: a
    // control is never the segment a slot belongs to.
    expect(extractFieldSlots({ markdown, segments: [para, field] })).toEqual([
      { name: "name", segment: { section: 0, para: 0, id: "p" } },
    ]);
    // The control still refuses a click of its own.
    expect(resolveSelection({ markdown, segments: [para, run, field] },
      { id: "fld", indices: [0, 1], start: 4, end: 12, kind: "field", section: 0, para: 0 }).refusal).toBe("container");
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

  it("keeps the panel's heading and title rows at the values the table states (#35)", () => {
    // `hwp compose` refuses a style the spec does not define, so the panel
    // spells these rows out. The numbers are this repo's own - the engine's
    // presets carry no title or heading style - so they are pinned as values
    // here rather than only read back from the table, and a drift in either the
    // table or the builder shows up.
    const styles = buildDocumentSpec("report", { title: "제목", author: "", body: "# 머리\n\n본문" }).document.styles;
    expect(styles?.["heading"]).toEqual({
      font_family: "함초롬바탕", font_size_pt: 18, bold: true, spacing_before_pt: 13, spacing_after_pt: 6,
    });
    expect(styles?.["title"]).toEqual({
      font_family: "함초롬바탕", font_size_pt: 21, bold: true, align: "center", spacing_after_pt: 18,
    });
    // The sizes are relative to the preset's body row: `official` is 12pt.
    const official = buildDocumentSpec("official", { title: "제목", author: "", body: "본문" }).document.styles;
    expect(official?.["heading"]?.font_size_pt).toBe(15);
    expect(official?.["title"]?.font_size_pt).toBe(18);
  });

  it("derives every preset's heading and title rows from the profile tables (#35)", () => {
    // The two tables, not the builder: `DOCUMENT_PROFILES` for the body row and
    // `COMPOSE_STYLE_ROWS` for what the panel adds to it. A literal creeping
    // back into `presets.ts` diverges from these and fails here, for every
    // preset rather than the one a value happens to match.
    for (const preset of COMPOSE_PRESETS) {
      const profile = DOCUMENT_PROFILES[preset];
      const styles = buildDocumentSpec(preset, { title: "제목", author: "", body: "# 머리\n\n본문" }).document.styles;
      expect(styles?.["heading"]).toEqual({
        font_family: profile.fontFamily,
        font_size_pt: profile.bodySizePt + COMPOSE_STYLE_ROWS.heading.sizeDeltaPt,
        bold: true,
        spacing_before_pt: COMPOSE_STYLE_ROWS.heading.spacingBeforePt,
        spacing_after_pt: COMPOSE_STYLE_ROWS.heading.spacingAfterPt,
      });
      expect(styles?.["title"]).toEqual({
        font_family: profile.fontFamily,
        font_size_pt: profile.bodySizePt + COMPOSE_STYLE_ROWS.title.sizeDeltaPt,
        bold: true,
        align: "center",
        spacing_after_pt: COMPOSE_STYLE_ROWS.title.spacingAfterPt,
      });
    }
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
