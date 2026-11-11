import { describe, expect, it } from "vitest";
import { formatAddresses, paragraphAddress, paragraphForSegment, selectSimilar, selectionAction, selectedParagraphs } from "../src/selection.js";
import type { CatEnvelope, Segment } from "../src/segments.js";
import { initialState, reducer } from "../src/state.js";

const para = (n: number, directChar = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) }): Segment =>
  ({ id: `p${n}`, indices: [n], start: n * 10, end: n * 10 + 9, kind: "para", section: 0, para: n, directChar,
    directPara: { alignment: "left", indent: 0, line_spacing: 160, line_spacing_type: 0 } });
const env: CatEnvelope = { markdown: "x".repeat(29), segments: [
  para(0), { id: "r0", indices: [0, 1], start: 0, end: 3, kind: "run", section: 0, para: 0,
    directChar: { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) } },
  { id: "r0-other-style", indices: [0, 2], start: 3, end: 9, kind: "run", section: 0, para: 0,
    directChar: { bold: true, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) } },
  para(1), { id: "tbl", indices: [1, 0], start: 10, end: 15, kind: "table", section: 0, para: 1 },
  { id: "cell", indices: [1, 0, 0], start: 10, end: 15, kind: "cell", section: 0, para: 1 },
  { id: "inner-para", indices: [1, 0, 0, 0], start: 10, end: 15, kind: "para", section: 0, para: 1 },
  { id: "r1", indices: [1, 1], start: 10, end: 15, kind: "run", section: 0, para: 1,
    directChar: { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) } },
  { ...para(1), id: "sibling-para", indices: [1, 0, 1, 0] },
  para(2, { bold: true, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) }),
] };

describe("selection helpers", () => {
  it("maps nested content to the paragraph that holds its text, never to the table's host", () => {
    const table = env.segments.find((s) => s.id === "tbl")!;
    const cell = env.segments.find((s) => s.id === "cell")!;
    // The paragraph that anchors the table control is not the table's text: a
    // delete-para there removes the table, so a table has no paragraph target.
    expect(paragraphForSegment(env, table)).toBeUndefined();
    // A cell's text lives in the paragraph inside it, and that is what a
    // paragraph op may address.
    expect(paragraphForSegment(env, cell)?.id).toBe("inner-para");
    expect(paragraphAddress(env.segments[0]!)).toEqual({ id: "p0" });
    expect(formatAddresses(env, [env.segments[0]!, env.segments[3]!])).toEqual([{ id: "r0" }, { id: "r0-other-style" }, { id: "r1" }]);
    expect(formatAddresses(env, [env.segments[1]!])).toEqual([{ id: "r0" }]);
    expect(paragraphForSegment(env, env.segments.find((s) => s.id === "inner-para")!)?.id).toBe("inner-para");
    // A cell whose paragraphs the envelope does not carry cannot be descended
    // into, and its host is not a substitute.
    const emptyCell: Segment = { id: "empty-cell", indices: [1, 0, 2], start: 10, end: 15, kind: "cell", section: 0, para: 1 };
    expect(paragraphForSegment({ markdown: env.markdown, segments: [...env.segments, emptyCell] }, emptyCell)).toBeUndefined();
    // A legacy projection carries no nesting path, so neither a table nor a
    // cell resolves, rather than falling back to the enclosing paragraph.
    const legacyHost: CatEnvelope = { markdown: "x", segments: [
      { start: 0, end: 1, kind: "para", section: 0, para: 0 },
      { start: 0, end: 1, kind: "table", section: 0, para: 0 },
      { start: 0, end: 1, kind: "cell", section: 0, para: 0 },
    ] };
    expect(paragraphForSegment(legacyHost, legacyHost.segments[1]!)).toBeUndefined();
    expect(paragraphForSegment(legacyHost, legacyHost.segments[2]!)).toBeUndefined();
  });

  it("toggles and extends ranges in paragraph reading order", () => {
    const initial = reducer(initialState, { type: "select", selection: { section: 0, para: 0, id: "p0" } });
    const extended = selectionAction(env, initial, env.segments[9]!, "extend");
    expect(extended.type).toBe("selectMany");
    if (extended.type !== "selectMany") return;
    const state = reducer(initial, extended);
    expect(selectedParagraphs(env, state).map((s) => s.id)).toEqual(["p0", "p1", "inner-para", "sibling-para", "p2"]);
    const toggled = selectionAction(env, state, env.segments[3]!, "toggle");
    expect(toggled.type).toBe("selectMany");
    if (toggled.type === "selectMany") expect(toggled.selections.map((s) => s.id)).toEqual(["p0", "inner-para", "sibling-para", "p2"]);
  });

  it("selects by direct properties only and returns no guess when absent", () => {
    const similarRuns = selectSimilar(env, env.segments[0]!, "char");
    expect(similarRuns.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(formatAddresses(env, env.segments.filter((s) => similarRuns.some((r) => r.id === s.id)))).toEqual([
      { id: "r0" }, { id: "r1" },
    ]);
    expect(selectSimilar(env, { id: "no-attrs", start: 0, end: 1, kind: "run", section: 0, para: 0 }, "char")).toEqual([]);
    expect(selectSimilar(env, env.segments[0]!, "para").map((r) => r.id)).toEqual(["p0", "p1", "sibling-para", "p2"]);
    const reordered = { ...env.segments[0]!, directChar: {
      face_ids: Array(7).fill(0), faces: Array(7).fill("A"), color: "#000000", size_pt: 10, italic: false, bold: false,
    } };
    expect(selectSimilar(env, reordered, "char").map((r) => r.id)).toContain("r1");
    const oldProjection: CatEnvelope = { markdown: "x".repeat(29), segments: env.segments.filter((s) => s.kind === "para") };
    expect(selectSimilar(oldProjection, oldProjection.segments[0]!, "char").map((r) => r.id)).toEqual([
      "p0", "p1", "sibling-para",
    ]);
  });

  it("keeps legacy run ranges within the paragraph and emits unique source addresses", () => {
    const legacy: CatEnvelope = { markdown: "abcdefghij", segments: [
      { start: 0, end: 5, kind: "para", section: 0, para: 0 },
      { start: 0, end: 3, kind: "run", section: 0, para: 0, indices: [0, 2] },
      { start: 5, end: 8, kind: "run", section: 0, para: 0, indices: [0, 3] },
      { start: 1, end: 4, kind: "run", section: 0, para: 0 },
      { start: 6, end: 9, kind: "run", section: 0, para: 0 },
    ] };
    // A paragraph without nesting indices whose runs carry them is a mixed projection: an ordinal is
    // not a source run index, so refuse the paragraph instead of formatting the wrong run.
    expect(formatAddresses(legacy, [legacy.segments[0]!])).toEqual([]);
    expect(formatAddresses({ markdown: "x", segments: [{ start: 0, end: 1, kind: "para", section: 0, para: 0 }] },
      [{ start: 0, end: 1, kind: "para", section: 0, para: 0 }])).toEqual([{ at: { section: 0, paragraph: 0, run: 0 } }]);
  });

  it("addresses a legacy range run by its position in the paragraph, not in the overlap", () => {
    // Three id-less runs; only the third overlaps the range, so its index in
    // the filtered list is 0 while its position in the paragraph is 2.
    const legacy: CatEnvelope = { markdown: "abcdefghij", segments: [
      { start: 0, end: 9, kind: "para", section: 0, para: 0 },
      { start: 0, end: 3, kind: "run", section: 0, para: 0 },
      { start: 3, end: 6, kind: "run", section: 0, para: 0 },
      { start: 6, end: 9, kind: "run", section: 0, para: 0 },
    ] };
    expect(formatAddresses(legacy, [legacy.segments[0]!], { paragraph: { section: 0, para: 0 }, start: 6, end: 9 }))
      .toEqual([{ at: { section: 0, paragraph: 0, run: 2 } }]);
  });

  it("addresses only overlapping whole runs for one valid Markdown scalar range", () => {
    const p0 = { id: "range-p0", indices: [0], start: 0, end: 8, kind: "para" as const, section: 0, para: 0 };
    const p1 = { id: "range-p1", indices: [1], start: 8, end: 16, kind: "para" as const, section: 0, para: 1 };
    const ranged: CatEnvelope = { markdown: "repeat repeat!!!", segments: [p0,
      { id: "a-fragment", indices: [0, 0], start: 0, end: 5, kind: "run", section: 0, para: 0 },
      { id: "b", indices: [0, 1], start: 5, end: 8, kind: "run", section: 0, para: 0 },
      { id: "a-fragment", indices: [0, 2], start: 4, end: 8, kind: "run", section: 0, para: 0 },
      p1,
      { id: "c", indices: [1, 0], start: 8, end: 10, kind: "run", section: 0, para: 1 },
      { id: "d", indices: [1, 1], start: 14, end: 16, kind: "run", section: 0, para: 1 },
    ] };
    const addresses = formatAddresses(ranged, [p0], { paragraph: { section: 0, para: 0, id: p0.id }, start: 4, end: 7 });
    expect(addresses).toEqual([{ id: "a-fragment" }, { id: "b" }]);
    expect(addresses.every((address) => !("chars" in address))).toBe(true);
    expect(formatAddresses(ranged, [p1], { paragraph: { section: 0, para: 0, id: p0.id }, start: 4, end: 7 })).toEqual([]);
    expect(formatAddresses(ranged, [p0], { paragraph: { section: 0, para: 0, id: p0.id }, start: -1, end: 7 })).toEqual([]);
    expect(formatAddresses(ranged, [p0], { paragraph: { section: 0, para: 0, id: p0.id }, start: 1, end: 2 })).toEqual([{ id: "a-fragment" }]);
    expect(formatAddresses(ranged, [p1], { paragraph: { section: 0, para: 1, id: p1.id }, start: 9, end: 11 })).toEqual([{ id: "c" }]);
    expect(formatAddresses(ranged, [p1], { paragraph: { section: 0, para: 1, id: p1.id }, start: 11, end: 13 })).toEqual([]);
    expect(formatAddresses(ranged, [p0], { paragraph: { section: 0, para: 0, id: p0.id }, start: 100, end: 101 })).toEqual([]);

    const emojiPara: Segment = { id: "emoji-p", indices: [2], start: 0, end: 3, kind: "para", section: 0, para: 2 };
    const emojiRun: Segment = { id: "emoji-run", indices: [2, 0], start: 0, end: 1, kind: "run", section: 0, para: 2 };
    expect(formatAddresses({ markdown: "😀ab", segments: [emojiPara, emojiRun] }, [emojiPara],
      { paragraph: { section: 0, para: 2, id: "emoji-p" }, start: 0, end: 1 })).toEqual([{ id: "emoji-run" }]);
  });

  it("does not emit top-level addresses for nested no-id runs", () => {
    const paragraph: Segment = { id: "nested-p", indices: [2, 0, 0], start: 0, end: 5, kind: "para", section: 0, para: 2 };
    const nestedRun: Segment = { indices: [2, 0, 0, 1], start: 0, end: 5, kind: "run", section: 0, para: 2 };
    const nested: CatEnvelope = { markdown: "hello", segments: [paragraph, nestedRun] };
    expect(formatAddresses(nested, [paragraph])).toEqual([]);
    expect(formatAddresses(nested, [paragraph], { paragraph: { section: 0, para: 2, id: "nested-p" }, start: 1, end: 4 })).toEqual([]);
    const topPara: Segment = { id: "top-p", indices: [3], start: 0, end: 5, kind: "para", section: 0, para: 3 };
    const topRun: Segment = { indices: [3, 2], start: 0, end: 5, kind: "run", section: 0, para: 3 };
    expect(formatAddresses({ markdown: "hello", segments: [topPara, topRun] }, [topPara])).toEqual([
      { at: { section: 0, paragraph: 3, run: 2 } },
    ]);
  });
});
