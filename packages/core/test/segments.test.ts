/**
 * Segments envelope tests. Fixtures are REAL captures, re-produced by the
 * hwp-cli v0.20.0 release binary (`hwp 0.20.0`) from the commands below, now
 * with `--segments v2`; the emitted markdown is byte-identical to the v1
 * captures these fixtures replace, which is what makes the pair a drift
 * check on the envelope rather than a snapshot of whatever the current
 * binary happens to emit:
 *   cat-segments-basic.json — `hwp compose examples/document-spec-v2/basic.json
 *     -o basic.hwpx && hwp cat basic.hwpx --format markdown --with-segments
 *     --segments v2`
 *   cat-segments-table.json — `hwp new -o table.hwpx --from table.md &&
 *     hwp cat table.hwpx --format markdown --with-segments --segments v2`
 *     (markdown table; table.md is the v1 fixture's own markdown, which
 *     round-trips byte-identically)
 *   cat-segments-runs.json — the schema `1.1` envelope, captured from `ahwp
 *     1.6.1` (then the workflow pin) over `hwp compose runs.spec.json -o runs.hwpx &&
 *     hwp cat runs.hwpx --format markdown --with-segments --segments v2`. The
 *     spec is one paragraph of three runs, `{"version":"2.0","document":
 *     {"version":"1.0","sections":[{"blocks":[{"type":"paragraph","runs":
 *     [{"type":"text","text":"앞 "},{"type":"text","text":"굵게","bold":true},
 *     {"type":"text","text":" 뒤"}]}]}]}}`. The same document through the same
 *     command under `hwp 1.4.0` emits the same four segments at schema `1.0`
 *     with no `source_chars`, so the two differ only by this bump's addition.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  documentFormat,
  markdownLength,
  offsetToRef,
  parseCatEnvelope,
  publishedTableCount,
  runCoverage,
  segmentAtOffset,
  segmentAtRef,
  segmentRef,
  segmentText,
  tableCountMismatch,
  validateCatEnvelope,
  validateProjectedMetadata,
} from "../src/segments.js";
import type { CatEnvelope, DirectChar, DocumentFormat, Segment } from "../src/segments.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("parseCatEnvelope", () => {
  it("retains real ahwp 2.0.0 schema 1.2 controls through wire and host validation", () => {
    const env = parseCatEnvelope(fixture("cat-segments-controls.json"));
    expect(JSON.parse(fixture("cat-segments-controls.json")).schema_version).toBe("1.2");
    const run = env.segments.find(s => s.controls !== undefined)!;
    expect(run.controls).toEqual([{ kind: "tab", at: 1, source: 1 }]);
    expect(segmentText(env, run)).toBe("앞 가나다뒤");
    expect(validateCatEnvelope(env)).toBe(env);
    expect(validateProjectedMetadata(env).segments.find(s => s.controls)?.controls).toEqual(run.controls);
    expect(env.segments.filter(s => s.controls === undefined)).toHaveLength(3);
  });

  it.each([
    null, [], [null], [{ kind: "unknown", at: 1, source: 1 }],
    [{ kind: "tab", at: -1, source: 1 }], [{ kind: "tab", at: 1.5, source: 1 }],
    [{ kind: "tab", at: 6, source: 1 }], [{ kind: "tab", at: 1, source: -1 }],
    [{ kind: "tab", at: 1, source: 14 }], [{ kind: "tab", at: 1, source: 1.5 }],
  ].map(controls => ({ controls })))("rejects malformed controls $controls in wire and projected envelopes", ({ controls }) => {
    const wire = JSON.parse(fixture("cat-segments-controls.json"));
    wire.segments[1].controls = controls;
    expect(() => parseCatEnvelope(JSON.stringify(wire))).toThrow(/control/);
    const env = parseCatEnvelope(fixture("cat-segments-controls.json"));
    Object.assign(env.segments[1]!, { controls });
    expect(() => validateCatEnvelope(env)).toThrow(/control/);
    expect(() => validateProjectedMetadata(env)).toThrow(/control/);
  });

  it("rejects controls on a paragraph in both entry paths", () => {
    const wire = JSON.parse(fixture("cat-segments-controls.json"));
    wire.segments[0].controls = wire.segments[1].controls;
    expect(() => parseCatEnvelope(JSON.stringify(wire))).toThrow(/controls/);
    const env = parseCatEnvelope(fixture("cat-segments-controls.json"));
    env.segments[0]!.controls = env.segments[1]!.controls!;
    expect(() => validateCatEnvelope(env)).toThrow(/controls/);
  });

  it.each(["1.1", "1.12"])("accepts additive envelope schema %s", schema_version => {
    const wire = JSON.parse(fixture("cat-segments-basic.json"));
    wire.schema_version = schema_version;
    expect(parseCatEnvelope(JSON.stringify(wire)).segments).toHaveLength(5);
  });
  it("parses the real schema 1.1 envelope and projects its per-run source_chars", () => {
    const wire = JSON.parse(fixture("cat-segments-runs.json"));
    expect(wire.schema_version).toBe("1.1");
    const env = parseCatEnvelope(fixture("cat-segments-runs.json"));
    expect(env.markdown).toBe("앞 **굵게** 뒤\n\n");
    expect(env.segments.map((s) => s.kind)).toEqual(["para", "run", "run", "run"]);
    // char_range counts the emitted markdown, emphasis markers included: the
    // bold run covers its two `**` while its sourceChars span only `굵게`.
    expect(env.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 12], [0, 2], [2, 8], [8, 10],
    ]);
    expect(env.segments.map((s) => s.sourceChars)).toEqual([
      undefined, { start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 },
    ]);
  });
  it("projects the 1.1 envelope to the 1.0 spelling plus the source offsets", () => {
    const wire = JSON.parse(fixture("cat-segments-runs.json"));
    const oneOne = parseCatEnvelope(JSON.stringify(wire));
    for (const segment of wire.segments) delete segment.source_chars;
    const oneZero = parseCatEnvelope(JSON.stringify({ ...wire, schema_version: "1.0" }));
    // The field's presence is the feature gate: a 1.0 host omits it, and its
    // absence — not a version number — is what a consumer checks.
    expect(oneZero.segments.some((segment) => segment.sourceChars !== undefined)).toBe(false);
    expect(oneOne.segments.map((segment) => segment.sourceChars !== undefined))
      .toEqual([false, true, true, true]);
    expect(oneOne.segments.map(({ sourceChars: _source, ...rest }) => rest)).toEqual(oneZero.segments);
  });
  it.each([
    ["a zero-length range", { start: 2, end: 2 }],
    ["a reversed range", { start: 4, end: 2 }],
    ["a negative bound", { start: -1, end: 2 }],
    ["a fractional bound", { start: 0.5, end: 2 }],
    ["a non-object", [0, 2]],
  ])("rejects source_chars with %s", (_label, source_chars) => {
    const wire = JSON.parse(fixture("cat-segments-runs.json"));
    wire.segments[1].source_chars = source_chars;
    expect(() => parseCatEnvelope(JSON.stringify(wire))).toThrow("source_chars");
  });
  it("rejects source_chars on a segment that is not a run", () => {
    const wire = JSON.parse(fixture("cat-segments-runs.json"));
    wire.segments[0].source_chars = { start: 0, end: 2 };
    expect(() => parseCatEnvelope(JSON.stringify(wire))).toThrow("outside a run segment");
  });
  it.each([-1, 0.5])("rejects malformed path indices %s before selection", index => {
    const wire = JSON.parse(fixture("cat-segments-basic.json"));
    wire.segments[0].path.indices = [index];
    expect(() => parseCatEnvelope(JSON.stringify(wire))).toThrow("malformed segment");
  });
  it("parses the real basic envelope", () => {
    const env = parseCatEnvelope(fixture("cat-segments-basic.json"));
    expect(env.markdown).toContain("DocumentSpec v2 visual anchor");
    // v2 nests: the image and its run lie inside para 0's wider range.
    expect(env.segments).toHaveLength(5);
    expect(env.segments[0]).toMatchObject({
      id: "175b9dd4192615d5.0.0",
      indices: [0],
      start: 0,
      end: 12,
      kind: "para",
      section: 0,
      para: 0,
    });
    expect(env.segments.map((s) => s.kind)).toEqual([
      "para",
      "image",
      "run",
      "para",
      "run",
    ]);
  });

  it("parses the real table envelope", () => {
    const env = parseCatEnvelope(fixture("cat-segments-table.json"));
    expect(env.segments).toHaveLength(35);
    // The markdown table maps to paragraph 2; in v2 its para segment covers
    // the whole table and contains the table/cell/run segments nested inside.
    const table = env.segments.find(
      (s) => s.kind === "para" && s.para === 2,
    )!;
    expect(table.section).toBe(0);
    expect(segmentText(env, table)).toContain("| **항목** |");
    // Every segment projects onto a top-level paragraph coordinate.
    for (const s of env.segments) {
      expect(s.para).toBeGreaterThanOrEqual(0);
      expect(s.para).toBeLessThanOrEqual(3);
    }
  });

  it("rejects malformed payloads", () => {
    expect(() => parseCatEnvelope("42")).toThrow(/not an object/);
    expect(() => parseCatEnvelope("{}")).toThrow(/not a v2 envelope/);
    // The v1 envelope shape is not accepted: one shape only (D-03).
    expect(() =>
      parseCatEnvelope(
        '{"markdown":"# hi","segments":[{"start":0,"end":3,"kind":"para","section":0,"para":0}]}',
      ),
    ).toThrow(/not a v2 envelope/);
    expect(() =>
      parseCatEnvelope(
        '{"schema_version":"1.0","contract":"hwp-segment-envelope-v2","markdown":"x","segments":[{"start":0}]}',
      ),
    ).toThrow(/malformed segment/);
  });

  it("preserves scalar range coordinates while slicing non-BMP markdown at UTF-16 boundaries", () => {
    const json = JSON.stringify({
      contract: "hwp-segment-envelope-v2", schema_version: "1.0", markdown: "😀한",
      segments: [{ id: "p", kind: "para", path: { section: 0, indices: [0] }, char_range: { start: 1, end: 2 },
        direct: { char: { bold: true, italic: false, size_pt: 11, color: "#000000", faces: ["A", "A", "A", "A", "A", "A", null], face_ids: [2, 2, 2, 2, 2, 2, 2] },
          char_shape_id: 999, para: { alignment: "left", indent: 0, line_spacing: 160, line_spacing_type: 0 }, para_shape_id: 999 } }],
    });
    const env = parseCatEnvelope(json);
    expect(env.segments[0]).toMatchObject({ start: 1, end: 2, directChar: { bold: true, face_ids: [2, 2, 2, 2, 2, 2, 2] }, directPara: { alignment: "left" } });
    expect(markdownLength(env)).toBe(2);
    expect(segmentAtOffset(env, 1)).toBe(env.segments[0]);
    expect(segmentText(env, env.segments[0]!)).toBe("한");
    const malformed = JSON.parse(json) as { segments: Array<{ direct: { char: { size_pt: number } } }> };
    malformed.segments[0]!.direct.char.size_pt = Number.NaN;
    expect(() => parseCatEnvelope(JSON.stringify(malformed))).toThrow(/malformed direct[.]char/);
  });

  it("validates only present projected metadata and gives a host upgrade step for malformed values", () => {
    const oldHost = { markdown: "x", segments: [{ start: 0, end: 1, kind: "para" as const, section: 0, para: 0 }] };
    expect(validateProjectedMetadata(oldHost)).toBe(oldHost);
    const malformed = { ...oldHost, segments: [{ ...oldHost.segments[0]!, directChar: { bold: "yes" } as never }] };
    expect(() => validateProjectedMetadata(malformed)).toThrow(/malformed direct[.]char properties; upgrade the host adapter/);
  });

  it("revalidates projected run source offsets and drops a null one", () => {
    const run = { start: 0, end: 1, kind: "run" as const, section: 0, para: 0, sourceChars: { start: 3, end: 5 } };
    const kept = { markdown: "x", segments: [run] };
    expect(validateProjectedMetadata(kept)).toBe(kept);
    const nulled = validateProjectedMetadata({ markdown: "x", segments: [{ ...run, sourceChars: null as never }] });
    expect(nulled.segments[0]).not.toHaveProperty("sourceChars");
    for (const sourceChars of [{ start: 5, end: 5 }, { start: 5, end: 3 }, { start: -1, end: 2 }, { start: 0.5, end: 2 }]) {
      expect(() => validateProjectedMetadata({ markdown: "x", segments: [{ ...run, sourceChars }] }))
        .toThrow(/malformed source_chars/);
    }
    expect(() => validateProjectedMetadata({ markdown: "x", segments: [{ start: 0, end: 1, kind: "para", section: 0, para: 0,
      sourceChars: { start: 0, end: 1 } }] })).toThrow(/outside a run segment/);
  });

  it("fails an out-of-range projected offset at the boundary, not later in render", () => {
    // A host can project character ranges that run past its own Markdown. The
    // projected transport is validated on the way in, so the reader gets this
    // message instead of segmentText throwing inside a React render.
    expect(() => validateProjectedMetadata({ markdown: "ab", segments: [{ start: 0, end: 5, kind: "para" as const, section: 0, para: 0 }] }))
      .toThrow(/character range exceeds markdown/);
    expect(() => validateProjectedMetadata({ markdown: "ab", segments: [{ start: 3, end: 2, kind: "para" as const, section: 0, para: 0 }] }))
      .toThrow(/malformed character range/);
    expect(validateProjectedMetadata({ markdown: "ab", segments: [{ start: 0, end: 2, kind: "para" as const, section: 0, para: 0 }] }))
      .toEqual({ markdown: "ab", segments: [{ start: 0, end: 2, kind: "para", section: 0, para: 0 }] });
  });

  it("treats null direct shapes and null font faces as published compatibility values", () => {
    const base = { contract: "hwp-segment-envelope-v2", schema_version: "1.0", markdown: "x" };
    const parsed = parseCatEnvelope(JSON.stringify({ ...base, segments: [{ id: "p", kind: "para",
      path: { section: 0, indices: [0] }, char_range: { start: 0, end: 1 }, direct: { char: null, para: null } }] }));
    expect(parsed.segments[0]).not.toHaveProperty("directChar");
    expect(parsed.segments[0]).not.toHaveProperty("directPara");
    const projectedNulls = validateProjectedMetadata({ markdown: "x", segments: [{ start: 0, end: 1, kind: "para", section: 0, para: 0,
      directChar: null as never, directPara: null as never }] });
    expect(projectedNulls.segments[0]).not.toHaveProperty("directChar");
    expect(projectedNulls.segments[0]).not.toHaveProperty("directPara");
    expect(() => validateProjectedMetadata({ markdown: "x", segments: [{ start: 0, end: 1, kind: "para", section: 0, para: 0,
      directChar: null as never, directPara: { alignment: "bad" } as never }] })).toThrow(/malformed direct[.]para/);
    const fonts = parseCatEnvelope(JSON.stringify({ ...base, segments: [{ id: "p", kind: "para",
      path: { section: 0, indices: [0] }, char_range: { start: 0, end: 1 }, direct: {
        char: { bold: false, italic: false, size_pt: 0, color: "#abcdef", faces: [null, null, null, null, null, null, null], face_ids: [0, 0, 0, 0, 0, 0, 0] },
        para: { alignment: "divide", indent: -1, line_spacing: 0, line_spacing_type: 255 },
      } }] }));
    expect(fonts.segments[0]?.directChar?.faces).toEqual([null, null, null, null, null, null, null]);
    expect(fonts.segments[0]?.directPara?.alignment).toBe("divide");
  });

  it("rejects malformed published direct bounds in parser and projected transports", () => {
    const valid = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: ["A", "A", "A", "A", "A", "A", "A"], face_ids: [0, 0, 0, 0, 0, 0, 0] };
    const invalidChars = [
      { ...valid, color: "black" },
      { ...valid, faces: ["A"] },
      { ...valid, face_ids: [0, 0, 0, 0, 0, 0, -1] },
    ];
    for (const char of invalidChars) {
      const wire = { contract: "hwp-segment-envelope-v2", schema_version: "1.0", markdown: "x", segments: [{
        id: "p", kind: "para", path: { section: 0, indices: [0] }, char_range: { start: 0, end: 1 }, direct: { char },
      }] };
      expect(() => parseCatEnvelope(JSON.stringify(wire))).toThrow(/malformed direct[.]char/);
      const projected = { markdown: "x", segments: [{ start: 0, end: 1, kind: "para" as const, section: 0, para: 0,
        directChar: char as never }] };
      expect(() => validateProjectedMetadata(projected)).toThrow(/malformed direct[.]char/);
    }
    const badPara = { alignment: "diagonal", indent: 1.5, line_spacing: 160, line_spacing_type: 256 };
    const wire = { contract: "hwp-segment-envelope-v2", schema_version: "1.0", markdown: "x", segments: [{
      id: "p", kind: "para", path: { section: 0, indices: [0] }, char_range: { start: 0, end: 1 }, direct: { para: badPara },
    }] };
    expect(() => parseCatEnvelope(JSON.stringify(wire))).toThrow(/malformed direct[.]para/);
    expect(() => validateProjectedMetadata({ markdown: "x", segments: [{ start: 0, end: 1, kind: "para", section: 0, para: 0,
      directPara: badPara as never }] })).toThrow(/malformed direct[.]para/);
  });
});

describe("segment coordinate helpers", () => {
  const env = parseCatEnvelope(fixture("cat-segments-table.json"));

  it("maps markdown offsets to segments and refs", () => {
    // offset 0 is inside the heading segment (para 0)
    expect(segmentAtOffset(env, 0)).toMatchObject({ section: 0, para: 0 });
    expect(offsetToRef(env, 0)).toEqual({ section: 0, para: 0, id: env.segments[0]!.id });
    // v2 para ranges include the trailing paragraph break, so an offset v1
    // left in the gap now resolves to the paragraph that owns the break.
    expect(segmentAtOffset(env, 13)).toMatchObject({ section: 0, para: 0 });
    expect(offsetToRef(env, 13)).toEqual({ section: 0, para: 0, id: env.segments[0]!.id });
    // past the end of the markdown maps to nothing
    expect(segmentAtOffset(env, markdownLength(env))).toBeUndefined();
  });

  it("finds the outermost segment at an offset inside a nested range", () => {
    // offset 32 lies inside the first header cell: para 2 > table > cell >
    // para > run all cover it, and the container-first order means the
    // paragraph is found, not one of its nested segments.
    expect(segmentAtOffset(env, 32)).toMatchObject({
      kind: "para",
      section: 0,
      para: 2,
    });
  });

  it("finds a segment by source coordinate and slices its text", () => {
    const closing = env.segments.find(
      (s) => s.kind === "para" && s.para === 3,
    )!;
    const ref = segmentRef(closing);
    expect(ref).toEqual({ section: 0, para: 3, id: closing.id });
    const seg = segmentAtRef(env, ref)!;
    expect(segmentText(env, seg)).toContain("다음 회의는 9월 1일입니다.");
    expect(segmentAtRef(env, { section: 0, para: 99 })).toBeUndefined();
  });
});

describe("documentFormat", () => {
  it("reads the extension the handle carries, and answers nothing else", () => {
    // With no bytes the name is all there is, and the two rules it chooses
    // between differ by one character, so a name that says neither extension
    // gets the answer with no allowance.
    expect(documentFormat("demo.hwp")).toBe("hwp");
    expect(documentFormat("demo.HWP")).toBe("hwp");
    expect(documentFormat("demo.hwpx")).toBe("hwpx");
    expect(documentFormat("dir/demo.HwPx")).toBe("hwpx");
    expect(documentFormat(undefined)).toBe("unknown");
    expect(documentFormat("")).toBe("unknown");
    expect(documentFormat("demo.txt")).toBe("unknown");
    expect(documentFormat("demo.hwp.bak")).toBe("unknown");
  });

  it("reads the format from the document's bytes, so a mislabelled file is not trusted", () => {
    // hwp-cli reads the format from the content, so an HWPX file saved as
    // ".hwp" opens fine - and then asked this question by name alone it was
    // handed the HWP5 allowance, which shifts every window in it by one
    // character. The container header is what decides.
    expect(documentFormat("mislabelled.hwp", hwpxBytes())).toBe("unknown");
    expect(documentFormat("mislabelled.hwpx", hwp5Bytes())).toBe("unknown");
    // A name that says nothing useful defers to the header, and agreement
    // answers that one format.
    expect(documentFormat("download", hwpxBytes())).toBe("hwpx");
    expect(documentFormat("download", hwp5Bytes())).toBe("hwp");
    expect(documentFormat("demo.hwpx", hwpxBytes())).toBe("hwpx");
    expect(documentFormat("demo.hwp", hwp5Bytes())).toBe("hwp");
    // Bytes the sniff does not recognize are no evidence, so the name answers:
    // a host that passes a stub handle, or a producer whose package the sniff
    // does not recognize, keeps the behavior it had.
    expect(documentFormat("demo.hwpx", new Uint8Array([1, 2, 3]))).toBe("hwpx");
    expect(documentFormat("demo.hwpx", new Uint8Array())).toBe("hwpx");
    // A zip that is not an HWPX package (no STORED `mimetype` entry) is not a
    // disagreement, it is a document this rule cannot identify.
    expect(documentFormat("demo.hwpx", plainZipBytes())).toBe("hwpx");
    expect(documentFormat("demo.hwp", plainZipBytes())).toBe("hwp");
  });
});

/** The eight bytes every HWP5 file starts with (CFBF/OLE2). */
function hwp5Bytes(): Uint8Array {
  return new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
}

/** An OPC package header: `PK\x03\x04`, a STORED `mimetype` entry, then its value. */
function hwpxBytes(mimetype = "application/hwp+zip"): Uint8Array {
  const value = new TextEncoder().encode(mimetype);
  const bytes = new Uint8Array(38 + value.length);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 0, true);   // compression method: STORED
  view.setUint16(26, 8, true);  // file name length: "mimetype"
  view.setUint16(28, 0, true);  // extra field length
  bytes.set(new TextEncoder().encode("mimetype"), 30);
  bytes.set(value, 38);
  return bytes;
}

/** A zip whose first entry is not the HWPX `mimetype`, so the sniff gives up. */
function plainZipBytes(): Uint8Array {
  return hwpxBytes("application/zip");
}

/**
 * The markdown-to-source mapping behind a sub-run address.
 *
 * Every case starts from a shape the engine was measured to emit: a plain run
 * whose fragment is its text, a bold/italic run wrapped in its markers, and a
 * run whose block control splits it into one segment per piece.
 */
describe("runCoverage", () => {
  const directChar = (bold = false, italic = false): DirectChar => ({
    bold, italic, size_pt: 10, color: "#000000",
    faces: [null, null, null, null, null, null, null],
    face_ids: [0, 0, 0, 0, 0, 0, 0],
  });
  /** A window outcome, spelled out so each case reads as an answer, not an array. */
  const window = (start: number, end: number) => ({ kind: "window", range: [start, end] });
  const whole = { kind: "whole" };
  const none = { kind: "none" };
  /**
   * One coverage answer, with the format the caller would have to name.
   *
   * The default is `unknown`, which is the strictest answer there is: no
   * allowance, so every piece has to publish exactly the width it shows. A
   * case that needs the HWP5 break allowance says `"hwp"` at the call.
   */
  const cover = (
    envelope: CatEnvelope,
    segment: Segment,
    start: number,
    end: number,
    format: DocumentFormat = "unknown",
  ) => runCoverage(envelope, segment, start, end, format);
  const run = (
    markdown: string,
    start: number,
    end: number,
    sourceChars: [number, number] | undefined,
    direct = directChar(),
  ): { envelope: CatEnvelope; segment: Segment } => {
    const segment: Segment = {
      id: `r${start}`,
      indices: [1, 0],
      start,
      end,
      kind: "run",
      section: 0,
      para: 1,
      directChar: direct,
      ...(sourceChars === undefined ? {} : { sourceChars: { start: sourceChars[0], end: sourceChars[1] } }),
    };
    // The host paragraph belongs to the fixture because the one-unit
    // allowance is decided per paragraph: a piece that is not exact is named
    // whole even when a sibling piece in the same document maps.
    const paragraph: Segment = { id: `p${start}`, indices: [1], start, end, kind: "para", section: 0, para: 1 };
    return { envelope: { markdown, segments: [paragraph, segment] }, segment };
  };

  it("maps a window inside a plain run, counting a surrogate pair as two source units", () => {
    // Two visible characters of the seven-unit source: the run shows six
    // scalars in seven UTF-16 units, the surrogate pair counting twice.
    const { envelope, segment } = run("둘째 😀문단\n", 0, 6, [0, 7]);
    expect(cover(envelope, segment, 0, 2)).toEqual(window(0, 2));
    expect(cover(envelope, segment, 2, 4)).toEqual(window(2, 5));
    expect(cover(envelope, segment, 3, 4)).toEqual(window(3, 5));
    expect(cover(envelope, segment, 4, 6)).toEqual(window(5, 7));
    // The span is the UTF-16 width of the text, so no allowance is needed and
    // both formats read it: the pair's two units are in the span as well.
    expect(cover(envelope, segment, 0, 2, "hwpx")).toEqual(window(0, 2));
    // An empty or out-of-piece window names nothing, and is not a whole run.
    expect(cover(envelope, segment, 2, 2)).toEqual(none);
    expect(cover(envelope, segment, 0, 7)).toEqual(none);
    // A window covering the piece is the whole piece, without arithmetic.
    expect(cover(envelope, segment, 0, 6)).toEqual(whole);
  });

  it("counts a surrogate pair inside an emphasized run in source units, not markdown ones", () => {
    // The first head summed UTF-16 lengths into a scalar offset, so a window
    // that reached the closing marker indexed past the end of the text and
    // threw inside render, which unmounted the editor. Every number below is
    // an answer rather than an exception.
    const bold = run("**😀가**\n", 0, 6, [0, 3], directChar(true));
    expect(cover(bold.envelope, bold.segment, 2, 3)).toEqual(window(0, 2));
    expect(cover(bold.envelope, bold.segment, 2, 4)).toEqual(window(0, 3));
    expect(cover(bold.envelope, bold.segment, 2, 6)).toEqual(window(0, 3));
    expect(cover(bold.envelope, bold.segment, 0, 6)).toEqual(whole);
  });

  it("reads an emphasis wrapper back only when the properties vouch for it", () => {
    const bold = run("앞 **굵게** 뒤\n", 2, 8, [2, 4], directChar(true));
    expect(cover(bold.envelope, bold.segment, 4, 5)).toEqual(window(2, 3));
    expect(cover(bold.envelope, bold.segment, 5, 6)).toEqual(window(3, 4));
    // A window is drawn over the rendered markdown, so its edge lands on a
    // marker: it is clamped to the characters the run shows rather than
    // refused, because the same drag formatted something before #71.
    expect(cover(bold.envelope, bold.segment, 3, 5)).toEqual(window(2, 3));
    expect(cover(bold.envelope, bold.segment, 2, 6)).toEqual(window(2, 4));
    // A window that covers only the closing marker covers no character at all.
    expect(cover(bold.envelope, bold.segment, 6, 8)).toEqual(none);
    const italic = run("*굵게*\n", 0, 4, [0, 2], directChar(false, true));
    expect(cover(italic.envelope, italic.segment, 1, 2)).toEqual(window(0, 1));
    const both = run("***굵게***\n", 0, 8, [0, 2], directChar(true, true));
    expect(cover(both.envelope, both.segment, 3, 5)).toEqual(window(0, 2));
    // The engine trims the wrapped text and leaves edge whitespace outside
    // the markers: a bold " / " projects as " **/** ", so the word inside
    // maps, and the edge whitespace joins the window only when the selection
    // covers it.
    const spaced = run(" **/** \n", 0, 7, [0, 3], directChar(true));
    expect(cover(spaced.envelope, spaced.segment, 3, 4)).toEqual(window(1, 2));
    expect(cover(spaced.envelope, spaced.segment, 0, 1)).toEqual(none);
    expect(cover(spaced.envelope, spaced.segment, 0, 4)).toEqual(window(0, 2));
    // The trailing space is the third source unit, so covering it ends at 3.
    expect(cover(spaced.envelope, spaced.segment, 3, 7)).toEqual(window(1, 3));
    // A literal `*Note*` in a plain run is text, not a marker: the direct
    // level says plain, and the fragment is the source verbatim.
    const literal = run("*Note*\n", 0, 6, [0, 6]);
    expect(cover(literal.envelope, literal.segment, 1, 5)).toEqual(window(1, 5));
    // Properties that claim emphasis the fragment does not carry are named
    // whole: the fragment cannot be read back, so nothing narrower is offered.
    const missing = run("굵게\n", 0, 2, [0, 2], directChar(true));
    expect(cover(missing.envelope, missing.segment, 0, 1)).toEqual(whole);
    // A host that publishes no direct level cannot be told apart from a
    // literal marker, so it is named whole rather than guessed.
    const noDirect = run("굵게\n", 0, 2, [0, 2]);
    delete noDirect.segment.directChar;
    expect(cover(noDirect.envelope, noDirect.segment, 0, 1)).toEqual(whole);
  });


  it("accepts the paragraph break an HWP5 last piece publishes, and only there", () => {
    // Measured on ahwp 1.6.1: a `.hwp` paragraph stores its break as the
    // paragraph's last character, so its last piece ends one unit past the
    // text it shows - "동일문 안내" publishes (0, 7) for six characters in
    // every paragraph of the document. The window still stops at the last
    // character shown, so the break is never formatted.
    const markdown = "동일문 안내\n\n동일문 다른\n";
    const para1: Segment = { id: "p1", indices: [1], start: 0, end: 6, kind: "para", section: 0, para: 1 };
    const run1: Segment = { id: "hwp1", indices: [1, 0], start: 0, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 7 } };
    const para2: Segment = { id: "p2", indices: [2], start: 8, end: 14, kind: "para", section: 0, para: 2 };
    const run2: Segment = { id: "hwp2", indices: [2, 0], start: 8, end: 14, kind: "run", section: 0, para: 2,
      directChar: directChar(), sourceChars: { start: 0, end: 7 } };
    const hwp: CatEnvelope = { markdown, segments: [para1, run1, para2, run2] };
    expect(cover(hwp, run1, 0, 3, "hwp")).toEqual(window(0, 3));
    expect(cover(hwp, run1, 3, 6, "hwp")).toEqual(window(3, 6));
    expect(cover(hwp, run1, 0, 6, "hwp")).toEqual(whole);
    // The same numbers under an HWPX name are one unit wider than the text
    // they show, which is exactly the shape an HWPX fragment with a trimmed
    // edge space publishes: measured on ahwp 1.6.1, " 동일문 안내",
    // "동일문 안내 " and "\u3000동일문 안내" all report char_range (0, 6) with
    // source_chars (0, 7). Reading that unit as a break would format the
    // characters one place to the left of the selection, so the piece is named
    // whole.
    expect(cover(hwp, run1, 0, 3, "hwpx")).toEqual(whole);
    // No format named is no allowance either.
    expect(cover(hwp, run1, 0, 3)).toEqual(whole);
    // An earlier piece may not claim that unit: with a later piece in the same
    // paragraph, only that later piece can be the one that ends at the break.
    const early: Segment = { id: "two", indices: [1, 0], start: 0, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 7 } };
    const late: Segment = { id: "later", indices: [1, 1], start: 7, end: 10, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 7, end: 11 } };
    const splitPara: Segment = { id: "pboth", indices: [1], start: 0, end: 10, kind: "para", section: 0, para: 1 };
    const twoRuns: CatEnvelope = { markdown: "동일문 안내|동일문\n", segments: [splitPara, early, late] };
    expect(cover(twoRuns, early, 0, 3, "hwp")).toEqual(whole);
    expect(cover(twoRuns, late, 7, 9, "hwp")).toEqual(window(7, 9));
    // And one unit is the whole allowance: two of them is a rewrite.
    const longer = run("동일문 안내\n", 0, 6, [0, 8]);
    expect(cover(longer.envelope, longer.segment, 0, 3, "hwp")).toEqual(whole);
  });

  it("reads an HWPX span that is one unit wider than its text as whole (t30-c1)", () => {
    // The round-3 head asked the envelope whether the document stores its
    // breaks, and answered by agreement: every paragraph's last piece had to
    // read one unit longer. An HWPX document whose (only) paragraph starts
    // with a space answers yes to that - the trimmed space is counted in the
    // span - and the allowance then shifted every window by one. Measured on
    // ahwp 1.6.1: selecting 동일문 in " 동일문 안내" answered chars [0, 3),
    // which bolds "동일" where the user selected "동일문". The format is the
    // answer, so the same numbers are a window for HWP5 and whole for HWPX.
    const leading = run("동일문 안내\n", 0, 6, [0, 7]);
    expect(cover(leading.envelope, leading.segment, 0, 3, "hwpx")).toEqual(whole);
    expect(cover(leading.envelope, leading.segment, 0, 3, "hwp")).toEqual(window(0, 3));
    // Two paragraphs, each starting with U+3000, are two pieces the old
    // agreement accepted - the reviewer measured "　가. 동일문 안내" twice,
    // each publishing one unit past its nine visible characters, and the
    // count said one target with no whole note.
    const markdown = "가. 동일문 안내\n\n가. 동일문 안내\n";
    const one: Segment = { id: "p1", indices: [1], start: 0, end: 9, kind: "para", section: 0, para: 1 };
    const piece1: Segment = { id: "q1", indices: [1, 0], start: 0, end: 9, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 10 } };
    const two: Segment = { id: "p2", indices: [2], start: 11, end: 20, kind: "para", section: 0, para: 2 };
    const piece2: Segment = { id: "q2", indices: [2, 0], start: 11, end: 20, kind: "run", section: 0, para: 2,
      directChar: directChar(), sourceChars: { start: 0, end: 10 } };
    const hwpx: CatEnvelope = { markdown, segments: [one, piece1, two, piece2] };
    expect(cover(hwpx, piece1, 0, 2, "hwpx")).toEqual(whole);
    expect(cover(hwpx, piece2, 11, 13, "hwpx")).toEqual(whole);
    expect(cover(hwpx, piece1, 0, 2, "hwp")).toEqual(window(0, 2));
  });

  it("keeps an HWP5 document's windows when one paragraph is not exact (t30-c4)", () => {
    // The round-3 agreement was document-wide, so one paragraph whose span was
    // not exactly one unit wider - a .hwp paragraph with an edge space, whose
    // trimmed space and stored break both sit in the span - turned windows off
    // for every other paragraph of the file. The format answers the question
    // now, and a piece that is not exact is named whole on its own.
    const markdown = "동일문 안내\n\n 동일문\n";
    const para1: Segment = { id: "p1", indices: [1], start: 0, end: 6, kind: "para", section: 0, para: 1 };
    const run1: Segment = { id: "r1", indices: [1, 0], start: 0, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 7 } };
    const para2: Segment = { id: "p2", indices: [2], start: 8, end: 12, kind: "para", section: 0, para: 2 };
    const run2: Segment = { id: "r2", indices: [2, 0], start: 8, end: 12, kind: "run", section: 0, para: 2,
      directChar: directChar(), sourceChars: { start: 0, end: 6 } };
    const hwp: CatEnvelope = { markdown, segments: [para1, run1, para2, run2] };
    expect(cover(hwp, run1, 0, 3, "hwp")).toEqual(window(0, 3));
    expect(cover(hwp, run2, 8, 10, "hwp")).toEqual(whole);
  });

  it("keeps each piece of a block-control-split run on its own source span", () => {
    // The engine's own measurement (hwp-cli tests/segment_source_chars.rs):
    // "앞" publishes (0, 1) and "뒤" (9, 11) - the table anchor's 8 WCHAR sit
    // between the pieces and belong to neither, and the last piece carries the
    // paragraph break.
    const para: Segment = { id: "psplit", indices: [1], start: 0, end: 6, kind: "para", section: 0, para: 1 };
    const first: Segment = { id: "split", indices: [1, 0], start: 0, end: 3, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 3 } };
    const second: Segment = { id: "split", indices: [1, 1], start: 4, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 11, end: 14 } };
    const envelope: CatEnvelope = { markdown: "abc|de\n", segments: [para, first, second] };
    expect(cover(envelope, first, 1, 3, "hwp")).toEqual(window(1, 3));
    expect(cover(envelope, second, 4, 5, "hwp")).toEqual(window(11, 12));
    expect(cover(envelope, second, 5, 6, "hwp")).toEqual(window(12, 13));
    // A range covering the last piece is the piece itself: the caller keeps
    // the span the engine published, break included, instead of a window.
    expect(cover(envelope, second, 4, 6)).toEqual(whole);
    // The interrupting control's own characters belong to no piece: a window
    // that reaches back over it is outside the piece's own range.
    expect(cover(envelope, second, 3, 5)).toEqual(none);
  });

  it("names nothing for a window that stops on half of a shared marker pair (t30-c2)", () => {
    // A bold run a control splits publishes one id per piece, and the engine's
    // marker pair straddles them: the first piece is "**굵", the second "게**".
    // Neither is a wrapper `runWindowText` can read, so the round-3 head
    // answered "whole" for both and a drag that stopped on the opening "**"
    // formatted the run - measured on .hwpx, where selecting only the opening
    // pair of a bold "굵게" named the 굵 piece.
    const para: Segment = { id: "p", indices: [1], start: 0, end: 7, kind: "para", section: 0, para: 1 };
    const first: Segment = { id: "bold", indices: [1, 0], start: 0, end: 3, kind: "run", section: 0, para: 1,
      directChar: directChar(true), sourceChars: { start: 0, end: 1 } };
    const second: Segment = { id: "bold", indices: [1, 1], start: 3, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(true), sourceChars: { start: 1, end: 2 } };
    const envelope: CatEnvelope = { markdown: "**굵게**\n", segments: [para, first, second] };
    // The opening pair shows no character of the first piece.
    expect(cover(envelope, first, 0, 2, "hwpx")).toEqual(none);
    // The closing pair shows none of the second piece either, even though the
    // window ends past the text.
    expect(cover(envelope, second, 4, 6, "hwpx")).toEqual(none);
    // A window that does reach the text is still named whole: a half pair
    // cannot be read back character for character.
    expect(cover(envelope, first, 2, 3, "hwpx")).toEqual(whole);
    expect(cover(envelope, second, 3, 5, "hwpx")).toEqual(whole);
  });

  it("names a rewritten fragment whole, however well its length matches", () => {
    // Measured on ahwp 1.6.1: `가$xy$나` projects as an equation, a hard break
    // as two spaces before the newline, a footnote as `[^N]`, an image as
    // `![](…)` and a link as `[text](url)`. Every fixture below publishes a
    // span EQUAL to the fragment it shows, which is exactly the coincidence a
    // length comparison cannot see.
    const equation = run("가$xy$나\n", 0, 6, [0, 6]);
    expect(cover(equation.envelope, equation.segment, 0, 1)).toEqual(whole);
    const hardBreak = run("가  \n나\n", 0, 5, [0, 5]);
    expect(cover(hardBreak.envelope, hardBreak.segment, 0, 1)).toEqual(whole);
    const footnote = run("본문[^1]\n", 0, 6, [0, 6]);
    expect(cover(footnote.envelope, footnote.segment, 0, 2)).toEqual(whole);
    const image = run("![](a)\n", 0, 6, [0, 6]);
    expect(cover(image.envelope, image.segment, 0, 2)).toEqual(whole);
    // The wrappers that do not appear in `directChar` are refused the same way.
    const underline = run("<u>x</u>\n", 0, 8, [0, 8]);
    expect(cover(underline.envelope, underline.segment, 3, 4)).toEqual(whole);
    const strike = run("~~x~~\n", 0, 5, [0, 5]);
    expect(cover(strike.envelope, strike.segment, 2, 3)).toEqual(whole);
    const escaped = run("a&amp;b\n", 0, 7, [0, 7]);
    expect(cover(escaped.envelope, escaped.segment, 0, 1)).toEqual(whole);
    // A literal `&`, `<` or `\` is published verbatim from a body paragraph on
    // 1.6.1 - `a\b a&b a<b` comes back with a span equal to its text - so the
    // allow-list refuses these for being wider than the engine is, not because
    // the characters are rewritten (t30-c5). The cost is a whole-run format,
    // and the range hint says so.
    const literal = run("a\\b\n", 0, 4, [0, 4]);
    expect(cover(literal.envelope, literal.segment, 0, 1)).toEqual(whole);
    const ampersand = run("a&b\n", 0, 4, [0, 4]);
    expect(cover(ampersand.envelope, ampersand.segment, 0, 1)).toEqual(whole);
    // An inline control counted in the source span shrinks it instead: the
    // span and the text disagree, and nothing converts between them.
    const inlineControl = run("ab\n", 0, 2, [0, 4]);
    expect(cover(inlineControl.envelope, inlineControl.segment, 0, 1)).toEqual(whole);
    // No published source offsets: there is no source coordinate to map to,
    // and a schema 1.0 host keeps the whole-run behavior.
    const noSource = run("ab\n", 0, 2, undefined);
    expect(cover(noSource.envelope, noSource.segment, 0, 1)).toEqual(whole);
  });

  it("names whole a run whose text a field, a bookmark or an image rewrites", () => {
    // Measured on ahwp 1.6.1: a hyperlink projects as `[여기](https://…)` and
    // the envelope publishes a `field` segment over the run that shows it, so
    // the fragment's length has nothing to do with the source characters. A
    // coincidence of lengths is the case that matters, so this one is equal.
    const coincidence: Segment = { id: "link", indices: [1, 0], start: 0, end: 9, kind: "run",
      section: 0, para: 1, directChar: directChar(), sourceChars: { start: 0, end: 9 } };
    const field: Segment = { id: "fld", indices: [1, 0], start: 0, end: 9, kind: "field", section: 0, para: 1 };
    const markdown = "abcdefghi\n";
    expect(cover({ markdown, segments: [coincidence, field] }, coincidence, 0, 1)).toEqual(whole);
    const bookmark: Segment = { ...field, id: "bmk", kind: "bookmark" };
    expect(cover({ markdown, segments: [coincidence, bookmark] }, coincidence, 0, 1)).toEqual(whole);
    const image: Segment = { ...field, id: "img", kind: "image" };
    expect(cover({ markdown, segments: [coincidence, image] }, coincidence, 0, 1)).toEqual(whole);
    // The same numbers read back as text once nothing covers them, which is
    // what says the nested-segment check - not the length - is what refuses.
    expect(cover({ markdown, segments: [coincidence] }, coincidence, 0, 1)).toEqual(window(0, 1));
  });
});

/**
 * #97 item 1: the engine counts tables the envelope never draws. A table inside
 * a footnote, a header, a footer or a hidden comment is reached by the walk
 * `hwp edit` addresses and published as no `table` segment, so the published
 * index is only trustworthy while the two counts agree. These pin the
 * comparison, and the normalization of the count a host projects.
 */
describe("the engine's table count against the published segments (#97)", () => {
  const paragraph: Segment = { id: "p", start: 0, end: 1, kind: "para", section: 0, para: 0 };
  const table = (para: number): Segment => ({
    id: `t${para}`, start: 0, end: 1, kind: "table", section: 0, para,
  });

  /** One paragraph and two published tables, with the count a host projected. */
  const envelope = (bodyTables?: unknown): CatEnvelope => ({
    markdown: "x",
    segments: [paragraph, table(1), table(2)],
    ...(bodyTables === undefined ? {} : { bodyTables: bodyTables as number }),
  });

  it("counts the table segments and nothing else", () => {
    expect(publishedTableCount(envelope(2))).toBe(2);
    expect(publishedTableCount({ markdown: "x", segments: [paragraph] })).toBe(0);
  });

  it("reports a mismatch only when both counts exist and differ", () => {
    expect(tableCountMismatch(envelope(2))).toBeNull();
    // A host that publishes no count keeps table editing: refusing every table
    // op there would take the feature away from documents that are fine.
    expect(tableCountMismatch(envelope())).toBeNull();
    // A note's table is counted and not drawn, so the engine counts more.
    expect(tableCountMismatch(envelope(3))).toEqual({ engine: 3, published: 2 });
    // A count below the published one has no known unpublished table behind
    // it, so no index is trustworthy and the guard refuses it the same way.
    expect(tableCountMismatch(envelope(1))).toEqual({ engine: 1, published: 2 });
  });

  it("keeps a non-negative integer count and drops any other projected value", () => {
    const kept = envelope(2);
    expect(validateProjectedMetadata(kept)).toBe(kept);
    for (const malformed of ["2", 2.5, -1, null, Number.NaN]) {
      const projected = validateProjectedMetadata(envelope(malformed));
      expect(projected).not.toHaveProperty("bodyTables");
      // Dropping is the same answer as "the host published none": allowed.
      expect(tableCountMismatch(projected)).toBeNull();
    }
  });
});

/**
 * #147: the selection fields a decoded envelope resolves a ref through.
 *
 * `projectSegment` already holds the wire's `path.section`, `path.indices` and
 * `id` to these rules, so nothing a valid v2 envelope carries is newly refused.
 * What reaches this function is a host's own `HwpEngine.read` result, whose
 * TypeScript type says the fields are there without anything having checked
 * them: a non-array `indices` throws inside `resolveSelection`, one frame above
 * the boundary that could report it.
 *
 * #150 closes the two gaps #147 left: an empty path, which names no location,
 * and a `para` that disagrees with the path's first index, which the projection
 * derives rather than checks.
 */
describe("validateCatEnvelope selection fields", () => {
  /** The wire fixture the projection tests use, decoded. */
  const valid = (): CatEnvelope => parseCatEnvelope(fixture("cat-segments-basic.json"));
  const firstSegment = (envelope: CatEnvelope): Record<string, unknown> =>
    envelope.segments[0] as unknown as Record<string, unknown>;

  // Every fixture the projection tests read, because the two rules added here
  // are ones a projected envelope can only satisfy by construction: a nested
  // paragraph inside a cell carries `para` equal to the path's *first* index
  // (cat-segments-table's cell paragraph is `indices: [2, 0, 0, 0], para: 2`).
  it.each(["cat-segments-basic.json", "cat-segments-runs.json", "cat-segments-table.json"])(
    "accepts the envelope %s projects, unchanged",
    (name) => {
      const envelope = parseCatEnvelope(fixture(name));
      // The caller's own object comes back, so `bodyTables` and identity survive.
      expect(validateCatEnvelope(envelope)).toBe(envelope);
    });

  it("accepts an id-less legacy envelope, whose segments carry no indices either", () => {
    // What an older host projects, and what the playground's own stub carries:
    // `section` and `para` are required of every published segment, `id` and
    // `indices` are not.
    const legacy: CatEnvelope = {
      markdown: "가나다",
      segments: [{ start: 0, end: 3, kind: "para", section: 0, para: 0 }],
    };
    expect(validateCatEnvelope(legacy)).toBe(legacy);
  });

  it.each([
    ["indices is not an array", { indices: "0.0" }, /segment indices is not a non-empty array of non-negative integers/],
    ["indices holds a non-integer", { indices: [0, 1.5] }, /segment indices is not a non-empty array/],
    ["indices holds a negative index", { indices: [0, -1] }, /segment indices is not a non-empty array/],
    // The path names no location at all, which the projection refuses
    // (`p.indices.length === 0`) and the decoded path now refuses too (#150).
    ["indices is an empty path", { indices: [] }, /segment indices is not a non-empty array/],
    ["section is not a non-negative integer", { section: 0.5 }, /segment section or para is not a non-negative integer/],
    ["para is negative", { para: -1 }, /segment section or para is not a non-negative integer/],
    // The projection sets `para: p.indices[0]`, so a published pair that
    // disagrees is a host's own mistake and names one location twice (#150).
    ["para disagrees with the first index", { para: 1 }, /segment para disagrees with its nesting path/],
    ["id is not a string", { id: 7 }, /segment id is not a string/],
  ])("refuses a segment whose %s", (_label, patch, expected) => {
    const envelope = valid();
    Object.assign(firstSegment(envelope), patch);
    expect(() => validateCatEnvelope(envelope)).toThrow(expected);
  });
});

describe("ranges re-measured on released ahwp 2.0.0 (#171)", () => {
  it.each(["hwp", "hwpx"] as const)("keeps source offsets and the trimmed visible run owner in %s", format => {
    const env = parseCatEnvelope(fixture(`cat-segments-ranges-2.0-${format}.json`));
    const run = (paragraph: number) => env.segments.find(s => s.kind === "run" && s.para === paragraph)!;
    const first = run(1);
    expect(segmentText(env, first)).toBe("동일문 안내");
    expect(first.sourceChars).toEqual({ start: 0, end: format === "hwp" ? 7 : 6 });
    expect(runCoverage(env, first, first.start, first.start + 3, format))
      .toEqual({ kind: "window", range: [0, 3] });
    const leading = run(2);
    expect(runCoverage(env, leading, leading.start, leading.start + 3, format))
      .toEqual({ kind: "whole" });
    // #557: 1.6.2 also published the trimmed bold space under this same
    // Markdown span. 2.0.0 leaves only the run owning the visible x.
    const corrected = env.segments.filter(s => s.kind === "run" && s.para === 7);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.indices).toEqual([7, 2]);
    expect(segmentText(env, corrected[0]!)).toBe("x");
    expect(corrected[0]!.sourceChars).toEqual({ start: 2, end: format === "hwp" ? 4 : 3 });
    expect(corrected[0]!.directChar?.bold).toBe(false);
  });
});
