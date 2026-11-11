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
  runSourceRange,
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
describe("runSourceRange", () => {
  const directChar = (bold = false, italic = false): DirectChar => ({
    bold, italic, size_pt: 10, color: "#000000",
    faces: [null, null, null, null, null, null, null],
    face_ids: [0, 0, 0, 0, 0, 0, 0],
  });
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
    return { envelope: { markdown, segments: [segment] }, segment };
  };

  it("maps a window inside a plain run, counting a surrogate pair as two source units", () => {
    const { envelope, segment } = run("둘째 😀문단\n", 0, 6, [0, 7]);
    expect(runSourceRange(envelope, segment, 0, 2)).toEqual([0, 2]);
    expect(runSourceRange(envelope, segment, 2, 4)).toEqual([2, 5]);
    expect(runSourceRange(envelope, segment, 3, 4)).toEqual([3, 5]);
    expect(runSourceRange(envelope, segment, 4, 6)).toEqual([5, 7]);
    expect(runSourceRange(envelope, segment, 2, 2)).toBeUndefined();
    expect(runSourceRange(envelope, segment, 0, 7)).toBeUndefined();
  });

  it("reads an emphasis wrapper back only when the properties vouch for it", () => {
    const bold = run("앞 **굵게** 뒤\n", 2, 8, [2, 4], directChar(true));
    expect(runSourceRange(bold.envelope, bold.segment, 4, 5)).toEqual([2, 3]);
    expect(runSourceRange(bold.envelope, bold.segment, 5, 6)).toEqual([3, 4]);
    // A window is drawn over the rendered markdown, so its edge lands on a
    // marker: it is clamped to the characters the run shows rather than
    // refused, because the same drag formatted something before #71.
    expect(runSourceRange(bold.envelope, bold.segment, 3, 5)).toEqual([2, 3]);
    expect(runSourceRange(bold.envelope, bold.segment, 2, 6)).toEqual([2, 4]);
    // A window that covers only the closing marker covers no character at all.
    expect(runSourceRange(bold.envelope, bold.segment, 6, 8)).toBeUndefined();
    const italic = run("*굵게*\n", 0, 4, [0, 2], directChar(false, true));
    expect(runSourceRange(italic.envelope, italic.segment, 1, 2)).toEqual([0, 1]);
    const both = run("***굵게***\n", 0, 8, [0, 2], directChar(true, true));
    expect(runSourceRange(both.envelope, both.segment, 3, 5)).toEqual([0, 2]);
    // The engine trims the wrapped text and leaves edge whitespace outside
    // the markers: a bold " / " projects as " **/** ", so the word inside
    // maps, and the edge whitespace joins the window only when the selection
    // covers it.
    const spaced = run(" **/** \n", 0, 7, [0, 3], directChar(true));
    expect(runSourceRange(spaced.envelope, spaced.segment, 3, 4)).toEqual([1, 2]);
    expect(runSourceRange(spaced.envelope, spaced.segment, 0, 1)).toBeUndefined();
    expect(runSourceRange(spaced.envelope, spaced.segment, 0, 4)).toEqual([0, 2]);
    // The trailing space is the third source unit, so covering it ends at 3.
    expect(runSourceRange(spaced.envelope, spaced.segment, 3, 7)).toEqual([1, 3]);
    // A literal `*Note*` in a plain run is text, not a marker: the direct
    // level says plain, and the fragment is the source verbatim.
    const literal = run("*Note*\n", 0, 6, [0, 6]);
    expect(runSourceRange(literal.envelope, literal.segment, 1, 5)).toEqual([1, 5]);
    // Properties that claim emphasis the fragment does not carry are refused.
    const missing = run("굵게\n", 0, 2, [0, 2], directChar(true));
    expect(runSourceRange(missing.envelope, missing.segment, 0, 1)).toBeUndefined();
    // A host that publishes no direct level cannot be told apart from a
    // literal marker, so it is refused rather than guessed.
    const noDirect = run("굵게\n", 0, 2, [0, 2]);
    delete noDirect.segment.directChar;
    expect(runSourceRange(noDirect.envelope, noDirect.segment, 0, 1)).toBeUndefined();
  });

  it("accepts the paragraph break a .hwp last piece publishes, and only there", () => {
    // Measured on ahwp 1.6.1: a `.hwp` paragraph stores its break as the
    // paragraph's last character, so its last piece ends one unit past the
    // text it shows - "동일문 안내" publishes (0, 7) for six characters. The
    // window still stops at the last character shown, so the break is never
    // formatted.
    const only = run("동일문 안내\n", 0, 6, [0, 7]);
    expect(runSourceRange(only.envelope, only.segment, 0, 3)).toEqual([0, 3]);
    expect(runSourceRange(only.envelope, only.segment, 3, 6)).toEqual([3, 6]);
    expect(runSourceRange(only.envelope, only.segment, 0, 6)).toEqual([0, 6]);
    // An earlier piece may not claim that unit: this one has a sibling after
    // it, so its span must be its text.
    const early: Segment = { id: "two", indices: [1, 0], start: 0, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 7 } };
    const late: Segment = { id: "later", indices: [1, 1], start: 7, end: 9, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 7, end: 9 } };
    const twoRuns: CatEnvelope = { markdown: "동일문 안내둘째\n", segments: [early, late] };
    expect(runSourceRange(twoRuns, early, 0, 3)).toBeUndefined();
    // And one unit is the whole allowance: a rewritten fragment is refused.
    const longer = run("동일문 안내\n", 0, 6, [0, 8]);
    expect(runSourceRange(longer.envelope, longer.segment, 0, 3)).toBeUndefined();
  });

  it("keeps each piece of a block-control-split run on its own source span", () => {
    // The engine's own measurement (hwp-cli tests/segment_source_chars.rs):
    // "앞" publishes (0, 1) and "뒤" (9, 11) - the table anchor's 8 WCHAR sit
    // between the pieces and belong to neither, and the last piece carries the
    // paragraph break.
    const first: Segment = { id: "split", indices: [1, 0], start: 0, end: 3, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 0, end: 3 } };
    const second: Segment = { id: "split", indices: [1, 1], start: 4, end: 6, kind: "run", section: 0, para: 1,
      directChar: directChar(), sourceChars: { start: 11, end: 14 } };
    const envelope: CatEnvelope = { markdown: "abc|de\n", segments: [first, second] };
    expect(runSourceRange(envelope, first, 1, 3)).toEqual([1, 3]);
    expect(runSourceRange(envelope, second, 4, 5)).toEqual([11, 12]);
    expect(runSourceRange(envelope, second, 5, 6)).toEqual([12, 13]);
    // The covered piece ends where it shows, never inside the break.
    expect(runSourceRange(envelope, second, 4, 6)).toEqual([11, 13]);
    // The interrupting control's own characters belong to no piece: a window
    // that reaches back over it is outside the piece's own range.
    expect(runSourceRange(envelope, second, 3, 5)).toBeUndefined();
  });

  it("refuses a window whose text is not the source text", () => {
    const underline = run("<u>x</u>\n", 0, 8, [0, 1]);
    expect(runSourceRange(underline.envelope, underline.segment, 3, 4)).toBeUndefined();
    const strike = run("~~x~~\n", 0, 5, [0, 1]);
    expect(runSourceRange(strike.envelope, strike.segment, 2, 3)).toBeUndefined();
    // Escaping grows the output; an inline control counted in the source span
    // shrinks it. Neither converts, so both are refused.
    const escaped = run("a&amp;b\n", 0, 7, [0, 3]);
    expect(runSourceRange(escaped.envelope, escaped.segment, 0, 1)).toBeUndefined();
    const inlineControl = run("ab\n", 0, 2, [0, 4]);
    expect(runSourceRange(inlineControl.envelope, inlineControl.segment, 0, 1)).toBeUndefined();
    // No published source offsets: there is no source coordinate to map to.
    const noSource = run("ab\n", 0, 2, undefined);
    expect(runSourceRange(noSource.envelope, noSource.segment, 0, 1)).toBeUndefined();
  });

  it("refuses a run whose text a field or a bookmark rewrites", () => {
    // Measured on ahwp 1.6.1: a hyperlink projects as `[여기](https://…)` and
    // the envelope publishes a `field` segment over the run that shows it, so
    // the fragment's length has nothing to do with the source characters. A
    // coincidence of lengths is the case that matters, so this one is equal.
    const coincidence: Segment = { id: "link", indices: [1, 0], start: 0, end: 9, kind: "run",
      section: 0, para: 1, directChar: directChar(), sourceChars: { start: 0, end: 9 } };
    const field: Segment = { id: "fld", indices: [1, 0], start: 0, end: 9, kind: "field", section: 0, para: 1 };
    const markdown = "[ab](xyz)\n";
    expect(runSourceRange({ markdown, segments: [coincidence, field] }, coincidence, 0, 1)).toBeUndefined();
    const bookmark: Segment = { ...field, id: "bmk", kind: "bookmark" };
    expect(runSourceRange({ markdown, segments: [coincidence, bookmark] }, coincidence, 0, 1)).toBeUndefined();
    // The same numbers read back as text once no field covers them, which is
    // what says the field check - not the length - is what refuses.
    expect(runSourceRange({ markdown, segments: [coincidence] }, coincidence, 0, 1)).toEqual([0, 1]);
  });
});

