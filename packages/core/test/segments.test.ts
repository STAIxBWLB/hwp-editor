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
 *     1.6.1` (the workflow pin) over `hwp compose runs.spec.json -o runs.hwpx &&
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
  markdownLength,
  offsetToRef,
  parseCatEnvelope,
  runCoverage,
  segmentAtOffset,
  segmentAtRef,
  segmentRef,
  segmentText,
  validateProjectedMetadata,
} from "../src/segments.js";
import type { CatEnvelope, DirectChar, Segment } from "../src/segments.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("parseCatEnvelope", () => {
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
    // The host paragraph belongs to the fixture because the one-unit allowance
    // is decided document-wide: with no paragraph in the envelope there is no
    // evidence that the document stores a break at all.
    const paragraph: Segment = { id: `p${start}`, indices: [1], start, end, kind: "para", section: 0, para: 1 };
    return { envelope: { markdown, segments: [paragraph, segment] }, segment };
  };

  it("maps a window inside a plain run, counting a surrogate pair as two source units", () => {
    const { envelope, segment } = run("둘째 😀문단\n", 0, 6, [0, 7]);
    expect(runCoverage(envelope, segment, 0, 2)).toEqual(window(0, 2));
    expect(runCoverage(envelope, segment, 2, 4)).toEqual(window(2, 5));
    expect(runCoverage(envelope, segment, 3, 4)).toEqual(window(3, 5));
    expect(runCoverage(envelope, segment, 4, 6)).toEqual(window(5, 7));
    // An empty or out-of-piece window names nothing, and is not a whole run.
    expect(runCoverage(envelope, segment, 2, 2)).toEqual(none);
    expect(runCoverage(envelope, segment, 0, 7)).toEqual(none);
    // A window covering the piece is the whole piece, without arithmetic.
    expect(runCoverage(envelope, segment, 0, 6)).toEqual(whole);
  });

  it("counts a surrogate pair inside an emphasized run in source units, not markdown ones", () => {
    // The first head summed UTF-16 lengths into a scalar offset, so a window
    // that reached the closing marker indexed past the end of the text and
    // threw inside render, which unmounted the editor. Every number below is
    // an answer rather than an exception.
    const bold = run("**😀가**\n", 0, 6, [0, 3], directChar(true));
    expect(runCoverage(bold.envelope, bold.segment, 2, 3)).toEqual(window(0, 2));
    expect(runCoverage(bold.envelope, bold.segment, 2, 4)).toEqual(window(0, 3));
    expect(runCoverage(bold.envelope, bold.segment, 2, 6)).toEqual(window(0, 3));
    expect(runCoverage(bold.envelope, bold.segment, 0, 6)).toEqual(whole);
  });

  it("reads an emphasis wrapper back only when the properties vouch for it", () => {
    const bold = run("앞 **굵게** 뒤\n", 2, 8, [2, 4], directChar(true));
    expect(runCoverage(bold.envelope, bold.segment, 4, 5)).toEqual(window(2, 3));
    expect(runCoverage(bold.envelope, bold.segment, 5, 6)).toEqual(window(3, 4));
    // A window is drawn over the rendered markdown, so its edge lands on a
    // marker: it is clamped to the characters the run shows rather than
    // refused, because the same drag formatted something before #71.
    expect(runCoverage(bold.envelope, bold.segment, 3, 5)).toEqual(window(2, 3));
    expect(runCoverage(bold.envelope, bold.segment, 2, 6)).toEqual(window(2, 4));
    // A window that covers only the closing marker covers no character at all.
    expect(runCoverage(bold.envelope, bold.segment, 6, 8)).toEqual(none);
    const italic = run("*굵게*\n", 0, 4, [0, 2], directChar(false, true));
    expect(runCoverage(italic.envelope, italic.segment, 1, 2)).toEqual(window(0, 1));
    const both = run("***굵게***\n", 0, 8, [0, 2], directChar(true, true));
    expect(runCoverage(both.envelope, both.segment, 3, 5)).toEqual(window(0, 2));
    // The engine trims the wrapped text and leaves edge whitespace outside
    // the markers: a bold " / " projects as " **/** ", so the word inside
    // maps, and the edge whitespace joins the window only when the selection
    // covers it.
    const spaced = run(" **/** \n", 0, 7, [0, 3], directChar(true));
    expect(runCoverage(spaced.envelope, spaced.segment, 3, 4)).toEqual(window(1, 2));
    expect(runCoverage(spaced.envelope, spaced.segment, 0, 1)).toEqual(none);
    expect(runCoverage(spaced.envelope, spaced.segment, 0, 4)).toEqual(window(0, 2));
    // The trailing space is the third source unit, so covering it ends at 3.
    expect(runCoverage(spaced.envelope, spaced.segment, 3, 7)).toEqual(window(1, 3));
    // A literal `*Note*` in a plain run is text, not a marker: the direct
    // level says plain, and the fragment is the source verbatim.
    const literal = run("*Note*\n", 0, 6, [0, 6]);
    expect(runCoverage(literal.envelope, literal.segment, 1, 5)).toEqual(window(1, 5));
    // Properties that claim emphasis the fragment does not carry are named
    // whole: the fragment cannot be read back, so nothing narrower is offered.
    const missing = run("굵게\n", 0, 2, [0, 2], directChar(true));
    expect(runCoverage(missing.envelope, missing.segment, 0, 1)).toEqual(whole);
    // A host that publishes no direct level cannot be told apart from a
    // literal marker, so it is named whole rather than guessed.
    const noDirect = run("굵게\n", 0, 2, [0, 2]);
    delete noDirect.segment.directChar;
    expect(runCoverage(noDirect.envelope, noDirect.segment, 0, 1)).toEqual(whole);
  });


  it("accepts the paragraph break a .hwp last piece publishes, and only there", () => {
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
    expect(runCoverage(hwp, run1, 0, 3)).toEqual(window(0, 3));
    expect(runCoverage(hwp, run1, 3, 6)).toEqual(window(3, 6));
    expect(runCoverage(hwp, run1, 0, 6)).toEqual(whole);
    // The same numbers on an HWPX document mean something else: measured on
    // ahwp 1.6.1, " 동일문 안내", "동일문 안내 " and "\u3000동일문 안내" all
    // publish char_range (0, 6) with source_chars (0, 7), because a fragment's
    // edge whitespace is trimmed out of the output and still counted in the
    // span. The next paragraph of that document is exact, and that is the only
    // thing that tells the two shapes apart. Without it there is no allowance:
    // the piece is named whole rather than shifted by one.
    const hwpx: CatEnvelope = { markdown, segments: [para1, run1, para2, { ...run2, sourceChars: { start: 0, end: 6 } }] };
    expect(runCoverage(hwpx, run1, 0, 3)).toEqual(whole);
    // An earlier piece may not claim that unit even where the document proves
    // it stores a break: with a later piece in the same paragraph, only that
    // later piece can be the one that ends at the break.
    const early: Segment = { id: "two", indices: [1, 0], start: 0, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 7 } };
    const late: Segment = { id: "later", indices: [1, 1], start: 7, end: 10, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 7, end: 11 } };
    const splitPara: Segment = { id: "pboth", indices: [1], start: 0, end: 10, kind: "para", section: 0, para: 1 };
    const twoRuns: CatEnvelope = { markdown: "동일문 안내|동일문\n", segments: [splitPara, early, late] };
    expect(runCoverage(twoRuns, early, 0, 3)).toEqual(whole);
    expect(runCoverage(twoRuns, late, 7, 9)).toEqual(window(7, 9));
    // And one unit is the whole allowance: two of them is a rewrite.
    const longer = run("동일문 안내\n", 0, 6, [0, 8]);
    expect(runCoverage(longer.envelope, longer.segment, 0, 3)).toEqual(whole);
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
    expect(runCoverage(envelope, first, 1, 3)).toEqual(window(1, 3));
    expect(runCoverage(envelope, second, 4, 5)).toEqual(window(11, 12));
    expect(runCoverage(envelope, second, 5, 6)).toEqual(window(12, 13));
    // A range covering the last piece is the piece itself: the caller keeps
    // the span the engine published, break included, instead of a window.
    expect(runCoverage(envelope, second, 4, 6)).toEqual(whole);
    // The interrupting control's own characters belong to no piece: a window
    // that reaches back over it is outside the piece's own range.
    expect(runCoverage(envelope, second, 3, 5)).toEqual(none);
  });

  it("names a rewritten fragment whole, however well its length matches", () => {
    // Measured on ahwp 1.6.1: `가$xy$나` projects as an equation, a hard break
    // as two spaces before the newline, a footnote as `[^N]`, an image as
    // `![](…)` and a link as `[text](url)`. Every fixture below publishes a
    // span EQUAL to the fragment it shows, which is exactly the coincidence a
    // length comparison cannot see.
    const equation = run("가$xy$나\n", 0, 6, [0, 6]);
    expect(runCoverage(equation.envelope, equation.segment, 0, 1)).toEqual(whole);
    const hardBreak = run("가  \n나\n", 0, 5, [0, 5]);
    expect(runCoverage(hardBreak.envelope, hardBreak.segment, 0, 1)).toEqual(whole);
    const footnote = run("본문[^1]\n", 0, 6, [0, 6]);
    expect(runCoverage(footnote.envelope, footnote.segment, 0, 2)).toEqual(whole);
    const image = run("![](a)\n", 0, 6, [0, 6]);
    expect(runCoverage(image.envelope, image.segment, 0, 2)).toEqual(whole);
    // The wrappers that do not appear in `directChar` are refused the same way.
    const underline = run("<u>x</u>\n", 0, 8, [0, 8]);
    expect(runCoverage(underline.envelope, underline.segment, 3, 4)).toEqual(whole);
    const strike = run("~~x~~\n", 0, 5, [0, 5]);
    expect(runCoverage(strike.envelope, strike.segment, 2, 3)).toEqual(whole);
    const escaped = run("a&amp;b\n", 0, 7, [0, 7]);
    expect(runCoverage(escaped.envelope, escaped.segment, 0, 1)).toEqual(whole);
    // An inline control counted in the source span shrinks it instead: the
    // span and the text disagree, and nothing converts between them.
    const inlineControl = run("ab\n", 0, 2, [0, 4]);
    expect(runCoverage(inlineControl.envelope, inlineControl.segment, 0, 1)).toEqual(whole);
    // No published source offsets: there is no source coordinate to map to,
    // and a schema 1.0 host keeps the whole-run behavior.
    const noSource = run("ab\n", 0, 2, undefined);
    expect(runCoverage(noSource.envelope, noSource.segment, 0, 1)).toEqual(whole);
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
    expect(runCoverage({ markdown, segments: [coincidence, field] }, coincidence, 0, 1)).toEqual(whole);
    const bookmark: Segment = { ...field, id: "bmk", kind: "bookmark" };
    expect(runCoverage({ markdown, segments: [coincidence, bookmark] }, coincidence, 0, 1)).toEqual(whole);
    const image: Segment = { ...field, id: "img", kind: "image" };
    expect(runCoverage({ markdown, segments: [coincidence, image] }, coincidence, 0, 1)).toEqual(whole);
    // The same numbers read back as text once nothing covers them, which is
    // what says the nested-segment check - not the length - is what refuses.
    expect(runCoverage({ markdown, segments: [coincidence] }, coincidence, 0, 1)).toEqual(window(0, 1));
  });
});

