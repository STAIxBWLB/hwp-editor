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
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  offsetToRef,
  parseCatEnvelope,
  segmentAtOffset,
  segmentAtRef,
  segmentRef,
  segmentText,
} from "../src/segments.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("parseCatEnvelope", () => {
  it("parses the real basic envelope", () => {
    const env = parseCatEnvelope(fixture("cat-segments-basic.json"));
    expect(env.markdown).toContain("DocumentSpec v2 visual anchor");
    // v2 nests: the image and its run lie inside para 0's wider range.
    expect(env.segments).toHaveLength(5);
    expect(env.segments[0]).toEqual({
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
});

describe("segment coordinate helpers", () => {
  const env = parseCatEnvelope(fixture("cat-segments-table.json"));

  it("maps markdown offsets to segments and refs", () => {
    // offset 0 is inside the heading segment (para 0)
    expect(segmentAtOffset(env, 0)).toMatchObject({ section: 0, para: 0 });
    expect(offsetToRef(env, 0)).toEqual({ section: 0, para: 0 });
    // v2 para ranges include the trailing paragraph break, so an offset v1
    // left in the gap now resolves to the paragraph that owns the break.
    expect(segmentAtOffset(env, 13)).toMatchObject({ section: 0, para: 0 });
    expect(offsetToRef(env, 13)).toEqual({ section: 0, para: 0 });
    // past the end of the markdown maps to nothing
    expect(segmentAtOffset(env, env.markdown.length)).toBeUndefined();
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
    expect(ref).toEqual({ section: 0, para: 3 });
    const seg = segmentAtRef(env, ref)!;
    expect(segmentText(env, seg)).toContain("다음 회의는 9월 1일입니다.");
    expect(segmentAtRef(env, { section: 0, para: 99 })).toBeUndefined();
  });
});
