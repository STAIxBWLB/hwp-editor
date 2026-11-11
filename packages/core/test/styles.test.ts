/**
 * `styles-v1` and the style edit ops (issue #53, WP3/T5).
 *
 * The expectations below are pinned to two artifacts, both read on
 * 2026-11-11:
 *
 * - `hwp styles <file> --format json` on `ahwp 1.6.1`, whose wire object is
 *   `{contract, schema_version, styles: [{id, name, english_name, kind,
 *   next_style, attrs, used_by}]}`;
 * - `~/workspace/work/dev/hwp-cli/schemas/edit-ops-v1.schema.json`, which
 *   makes `apply_style` carry `address`+`style` (+`clear_direct`),
 *   `create_style` carry `name`+`kind` (+`based_on`), and `update_style`
 *   carry `style`, with every property a flat string such as "14pt" or a
 *   switch spelled "on"/"off".
 */
import { describe, expect, it } from "vitest";
import { hasDirectFormatting, parseCatEnvelope, projectShapeAttrs } from "../src/segments.js";
import {
  bodyStyle,
  parseStyleTable,
  parseStyleTableResponse,
  presetStyleOps,
  stylesVersionSupported,
  STYLE_TABLE_PRESETS,
} from "../src/styles.js";
import { opsToJson, opsToArgv } from "../src/ops.js";
import type { EditOp } from "../src/ops.js";

const ATTRS = {
  char: {
    bold: false,
    italic: false,
    size_pt: 12,
    color: "#000000",
    faces: ["함초롬바탕", null, null, null, null, null, null],
    face_ids: [1, 0, 0, 0, 0, 0, 0],
  },
  para: { alignment: "justify", indent: 0, line_spacing: 160, line_spacing_type: 0 },
  char_shape_id: 0,
  para_shape_id: 0,
};

function table(rows: unknown[]) {
  return JSON.stringify({ contract: "hwp-styles-v1", schema_version: "1.0", styles: rows });
}

const BODY_ROW = {
  id: 0,
  name: "바탕글",
  english_name: "Normal",
  kind: "paragraph",
  next_style: 0,
  attrs: ATTRS,
  used_by: ["p1", "p2"],
};

const HEADING_ROW = {
  id: 1,
  name: "개요 1",
  english_name: "Outline 1",
  kind: "paragraph",
  next_style: 0,
  attrs: ATTRS,
  used_by: ["p0"],
};

const CHAR_ROW = {
  id: 2,
  name: "강조",
  english_name: "Emphasis",
  kind: "character",
  next_style: 0,
  attrs: ATTRS,
  used_by: ["p1"],
};

describe("parseStyleTable", () => {
  it("projects the published rows, keeping the wire spelling of their keys", () => {
    const parsed = parseStyleTable(table([BODY_ROW, HEADING_ROW, CHAR_ROW]));
    expect(parsed.version).toBe("1.0");
    expect(parsed.styles.map((row) => [row.id, row.name, row.kind, row.used_by])).toEqual([
      [0, "바탕글", "paragraph", ["p1", "p2"]],
      [1, "개요 1", "paragraph", ["p0"]],
      [2, "강조", "character", ["p1"]],
    ]);
    expect(parsed.styles[0]!.english_name).toBe("Normal");
    expect(parsed.styles[0]!.next_style).toBe(0);
    expect(parsed.styles[0]!.attrs.char?.size_pt).toBe(12);
    expect(parsed.styles[0]!.attrs.charShapeId).toBe(0);
  });

  it("refuses another contract, another schema major, or a malformed row", () => {
    expect(() => parseStyleTable(JSON.stringify({ contract: "hwp-styles-v2", schema_version: "1.0", styles: [] })))
      .toThrow(/contract or schema major/);
    expect(() => parseStyleTable(JSON.stringify({ contract: "hwp-styles-v1", schema_version: "2.0", styles: [] })))
      .toThrow(/contract or schema major/);
    expect(() => parseStyleTable(table([{ ...BODY_ROW, kind: "table" }]))).toThrow(/styles\[0\]\.kind/);
    expect(() => parseStyleTable(table([{ ...BODY_ROW, used_by: [1] }]))).toThrow(/styles\[0\]\.used_by/);
    expect(() => parseStyleTable(table([{ ...BODY_ROW, id: -1 }]))).toThrow(/styles\[0\]\.id/);
    expect(() => parseStyleTable(table([{ ...BODY_ROW, next_style: 256 }]))).toThrow(/styles\[0\]\.next_style/);
  });

  /**
   * `kind` and each side of `attrs` are independently nullable BY CONTRACT:
   * a null kind is a reserved record value or an HWPX style with no usable
   * `type`, and a null side is a shape id that does not resolve in this
   * document's header table. A table holding either is still a table, so one
   * such row must not blank the whole tab.
   */
  it("accepts the rows the contract states as null instead of failing the whole table", () => {
    const parsed = parseStyleTable(table([
      BODY_ROW,
      { ...HEADING_ROW, kind: null },
      { ...HEADING_ROW, attrs: { char: null, para: ATTRS.para, char_shape_id: null, para_shape_id: 1 } },
      { ...HEADING_ROW, attrs: { char: ATTRS.char, para: null, char_shape_id: 0, para_shape_id: null } },
    ]));
    expect(parsed.styles).toHaveLength(4);
    expect(parsed.styles[1]!.kind).toBeNull();
    // The side that resolved is kept and the side that did not is absent,
    // never defaulted, so a consumer cannot read a fabricated value.
    expect(parsed.styles[2]!.attrs.char).toBeUndefined();
    expect(parsed.styles[2]!.attrs.para?.alignment).toBe(ATTRS.para.alignment);
    expect(parsed.styles[3]!.attrs.char?.size_pt).toBe(12);
    expect(parsed.styles[3]!.attrs.para).toBeUndefined();
  });

  /** A row that answers no kind is not a body style: it is not a paragraph. */
  it("does not pick a null-kind row as the body style", () => {
    const parsed = parseStyleTable(table([{ ...BODY_ROW, kind: null }, HEADING_ROW]));
    expect(bodyStyle(parsed)?.name).toBe("개요 1");
  });
});

describe("parseStyleTableResponse", () => {
  it("reads the projected table a /styles body carries", () => {
    const body = {
      version: "1.0",
      styles: [
        { id: 0, name: "바탕글", english_name: "Normal", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p1"] },
      ],
    };
    expect(parseStyleTableResponse(body).styles[0]!.name).toBe("바탕글");
  });

  it("refuses a projected table whose schema major is not 1", () => {
    expect(() => parseStyleTableResponse({ version: "2.0", styles: [] })).toThrow(/response\.version/);
    expect(() => parseStyleTableResponse({ styles: [] })).toThrow(/response\.version/);
    expect(() => parseStyleTableResponse(null)).toThrow(/response/);
  });
});

describe("stylesVersionSupported", () => {
  it("puts the floor at 1.4.0 and accepts anything above that major", () => {
    expect(stylesVersionSupported("1.3.1")).toBe(false);
    expect(stylesVersionSupported("1.4.0")).toBe(true);
    expect(stylesVersionSupported("1.4.0-beta.1")).toBe(true);
    expect(stylesVersionSupported("1.10.0")).toBe(true);
    expect(stylesVersionSupported("2.0.0")).toBe(true);
    expect(stylesVersionSupported("nonsense")).toBe(false);
  });
});

describe("bodyStyle / presetStyleOps", () => {
  const parsed = parseStyleTable(table([HEADING_ROW, BODY_ROW, CHAR_ROW]));

  it("names the most-used paragraph style as the body, never a character style", () => {
    expect(bodyStyle(parsed)?.name).toBe("바탕글");
    expect(bodyStyle(parseStyleTable(table([CHAR_ROW])))).toBeUndefined();
  });

  it("writes the preset's body row as one update_style", () => {
    expect(presetStyleOps(parsed, "official")).toEqual([
      { kind: "update-style", style: "바탕글", font: "맑은 고딕", size: "12", lineSpacingPct: "160" },
    ]);
    expect(presetStyleOps(parsed, "report")).toEqual([
      { kind: "update-style", style: "바탕글", font: "함초롬바탕", size: "15", lineSpacingPct: "160" },
    ]);
  });

  it("answers with no ops when the document carries no paragraph style", () => {
    expect(presetStyleOps(parseStyleTable(table([CHAR_ROW])), "plan")).toEqual([]);
  });

  it("offers exactly the presets the engine accepts", () => {
    expect([...STYLE_TABLE_PRESETS]).toEqual(["official", "report", "plan", "notice", "minutes", "press"]);
  });
});

describe("style ops on the edit-ops-v1 wire", () => {
  it("serializes create/update/apply with the schema's flat vocabulary", () => {
    const ops: EditOp[] = [
      {
        kind: "create-style",
        name: "표 제목",
        basedOn: "바탕글",
        bold: true,
        size: "12",
        color: "#1A1A1A",
        font: "맑은 고딕",
        align: "center",
      },
      { kind: "update-style", style: "바탕글", size: "14", lineSpacingPct: "180" },
      {
        kind: "apply-style",
        address: { at: { section: 0, paragraph: 2 } },
        style: "표 제목",
        clearDirect: true,
      },
    ];
    expect(JSON.parse(opsToJson(ops))).toEqual([
      {
        op: "create_style",
        name: "표 제목",
        kind: "paragraph",
        based_on: "바탕글",
        bold: "on",
        size: "12pt",
        // Carried verbatim, as the schema's pattern is case-insensitive: a
        // rewritten value would make two identical requests differ in bytes.
        color: "#1A1A1A",
        font: "맑은 고딕",
        align: "center",
      },
      { op: "update_style", style: "바탕글", size: "14pt", line_spacing_pct: "180%" },
      { op: "apply_style", address: { at: { section: 0, paragraph: 2 } }, style: "표 제목", clear_direct: true },
    ]);
  });

  it("carries a style id when the caller names one, and omits clear_direct unless asked", () => {
    const ops: EditOp[] = [
      { kind: "create-style", name: "인용", styleKind: "paragraph", italic: true },
      { kind: "apply-style", address: { at: { section: 1, paragraph: 0 } }, style: 7 },
    ];
    expect(JSON.parse(opsToJson(ops))).toEqual([
      { op: "create_style", name: "인용", kind: "paragraph", italic: "on" },
      { op: "apply_style", address: { at: { section: 1, paragraph: 0 } }, style: 7 },
    ]);
  });

  it("refuses style and addressed ops on the argv bridge, naming the JSON channel", () => {
    // `hwp edit` has no per-op flags for named styles, and the addressed ops
    // already require edit-ops-v1; one sentence covers the family.
    expect(() => opsToArgv([{ kind: "update-style", style: "바탕글", size: "14" }]))
      .toThrow(/edit-ops-v1 JSON transport/);
    expect(() => opsToArgv([{ kind: "apply-style", address: { at: { section: 0, paragraph: 0 } }, style: "바탕글" }]))
      .toThrow(/edit-ops-v1 JSON transport/);
  });

  it("refuses a colour or a unit the schema does not accept", () => {
    expect(() => opsToJson([{ kind: "update-style", style: "바탕글", color: "red" }]))
      .toThrow(/style\.color/);
    // A bare decimal and a suffixed value both read (the CLI's own grammar),
    // but a unit the schema never accepts is refused before the engine sees it.
    expect(JSON.parse(opsToJson([{ kind: "update-style", style: "바탕글", size: "14pt" }])))
      .toEqual([{ op: "update_style", style: "바탕글", size: "14pt" }]);
    expect(() => opsToJson([{ kind: "update-style", style: "바탕글", size: "14px" }]))
      .toThrow(/style\.size/);
  });
});

describe("per-level style projection", () => {
  const styleLevel = { ...ATTRS, char: { ...ATTRS.char, size_pt: 12 } };
  const directLevel = { ...ATTRS, char: { ...ATTRS.char, size_pt: 16 }, char_shape_id: 4 };

  function envelope(style: unknown, direct: unknown) {
    return parseCatEnvelope(JSON.stringify({
      contract: "hwp-segment-envelope-v2",
      schema_version: "1.0",
      markdown: "가",
      segments: [{
        id: "p1",
        kind: "para",
        path: { section: 0, indices: [0] },
        char_range: { start: 0, end: 1 },
        style,
        direct,
      }],
    }));
  }

  it("projects both levels and answers the indicator by comparing them", () => {
    const different = envelope(styleLevel, directLevel).segments[0]!;
    expect(different.style?.char?.size_pt).toBe(12);
    expect(different.direct?.char?.size_pt).toBe(16);
    expect(hasDirectFormatting(different)).toBe(true);
    const same = envelope(styleLevel, styleLevel).segments[0]!;
    expect(hasDirectFormatting(same)).toBe(false);
  });

  it("is inconclusive without both levels: no indicator and nothing to clear", () => {
    expect(hasDirectFormatting(envelope(styleLevel, undefined).segments[0]!)).toBe(false);
    expect(hasDirectFormatting(envelope(undefined, directLevel).segments[0]!)).toBe(false);
    // The engine's own "this level adds nothing" spelling.
    const nulls = envelope(styleLevel, { char: null, para: null }).segments[0]!;
    expect(nulls).not.toHaveProperty("direct");
    expect(hasDirectFormatting(nulls)).toBe(false);
  });

  /**
   * t12-a3: `style_level` makes `char` and `para` independently nullable, and
   * the engine emits a null `direct.char` when `char_shape_id_at` is None. A
   * parser that required both sides rejected the entire envelope, so one
   * unresolvable character shape cost the whole document read.
   */
  it("keeps the side of a level the document did resolve when the other is null", () => {
    const oneSided = envelope(
      { char: null, para: ATTRS.para, char_shape_id: null, para_shape_id: 1 },
      { char: ATTRS.char, para: null, char_shape_id: 0, para_shape_id: null },
    ).segments[0]!;
    expect(oneSided.style?.char).toBeUndefined();
    expect(oneSided.style?.para?.alignment).toBe(ATTRS.para.alignment);
    expect(oneSided.direct?.char?.size_pt).toBe(ATTRS.char.size_pt);
    expect(oneSided.direct?.para).toBeUndefined();
    // One level resolved a side the other did not: that is not the same
    // formatting, so the indicator is on rather than inconclusive.
    expect(hasDirectFormatting(oneSided)).toBe(true);
  });

  it("drops shape ids a host does not publish rather than inventing them", () => {
    const attrs = projectShapeAttrs({ char: ATTRS.char, para: ATTRS.para }, "segment.level");
    expect(attrs).not.toHaveProperty("charShapeId");
    expect(attrs.char?.size_pt).toBe(12);
    expect(() => projectShapeAttrs({ char: ATTRS.char, para: ATTRS.para, char_shape_id: -1 }, "segment.level"))
      .toThrow(/malformed shape ids/);
  });
});
