/**
 * Segments envelope tests. Fixtures are REAL captures produced with the
 * hwp-cli v0.8.8 debug build
 * (hwp-cli/target/debug/hwp, `hwp 0.8.8`):
 *   cat-segments-basic.json — `hwp compose examples/document-spec-v2/basic.json
 *     -o basic.hwpx && hwp cat basic.hwpx --format markdown --with-segments`
 *   cat-segments-table.json — `hwp new -o table.hwpx --from table.md &&
 *     hwp cat table.hwpx --format markdown --with-segments` (markdown table)
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
    expect(env.segments).toHaveLength(2);
    expect(env.segments[0]).toEqual({
      start: 0,
      end: 10,
      kind: "para",
      section: 0,
      para: 0,
    });
  });

  it("parses the real table envelope", () => {
    const env = parseCatEnvelope(fixture("cat-segments-table.json"));
    expect(env.segments).toHaveLength(4);
    // The markdown table maps to a single paragraph segment (para 2).
    const table = env.segments[2]!;
    expect(table.para).toBe(2);
    expect(segmentText(env, table)).toContain("| **항목** |");
  });

  it("rejects malformed payloads", () => {
    expect(() => parseCatEnvelope("42")).toThrow(/not an object/);
    expect(() => parseCatEnvelope("{}")).toThrow(/missing markdown/);
    expect(() =>
      parseCatEnvelope('{"markdown":"x","segments":[{"start":0}]}'),
    ).toThrow(/malformed segment/);
  });
});

describe("segment coordinate helpers", () => {
  const env = parseCatEnvelope(fixture("cat-segments-table.json"));

  it("maps markdown offsets to segments and refs", () => {
    // offset 0 is inside the heading segment (para 0)
    expect(segmentAtOffset(env, 0)).toMatchObject({ section: 0, para: 0 });
    expect(offsetToRef(env, 0)).toEqual({ section: 0, para: 0 });
    // the gap between segments (paragraph break) maps to nothing
    expect(segmentAtOffset(env, 13)).toBeUndefined();
    expect(offsetToRef(env, 13)).toBeUndefined();
  });

  it("finds a segment by source coordinate and slices its text", () => {
    const ref = segmentRef(env.segments[3]!);
    expect(ref).toEqual({ section: 0, para: 3 });
    const seg = segmentAtRef(env, ref)!;
    expect(segmentText(env, seg)).toContain("다음 회의는 9월 1일입니다.");
    expect(segmentAtRef(env, { section: 0, para: 99 })).toBeUndefined();
  });
});
