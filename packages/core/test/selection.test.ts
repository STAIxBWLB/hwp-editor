import { describe, expect, it } from "vitest";
import { formatAddresses, paragraphAddress, paragraphForSegment, selectSimilar, selectionAction, selectedParagraphs } from "../src/selection.js";
import type { CatEnvelope, Segment } from "../src/segments.js";
import { initialState, reducer } from "../src/state.js";

const para = (n: number, directChar = { bold: false, italic: false, size_pt: 10, color: "#000", faces: ["A"], face_ids: [0] }): Segment =>
  ({ id: `p${n}`, indices: [n], start: n * 10, end: n * 10 + 9, kind: "para", section: 0, para: n, directChar,
    directPara: { alignment: "left", indent: 0, line_spacing: 160, line_spacing_type: 0 } });
const env: CatEnvelope = { markdown: "", segments: [
  para(0), { id: "r0", indices: [0, 1], start: 0, end: 5, kind: "run", section: 0, para: 0 },
  para(1), { id: "tbl", indices: [1, 0], start: 10, end: 15, kind: "table", section: 0, para: 1 },
  { id: "cell", indices: [1, 0, 0], start: 10, end: 15, kind: "cell", section: 0, para: 1 },
  { id: "inner-para", indices: [1, 0, 0, 0], start: 10, end: 15, kind: "para", section: 0, para: 1 },
  { id: "r1", indices: [1, 1], start: 10, end: 15, kind: "run", section: 0, para: 1 },
  { ...para(1), id: "sibling-para", indices: [1, 1] },
  para(2, { bold: true, italic: false, size_pt: 10, color: "#000", faces: ["A"], face_ids: [0] }),
] };

describe("selection helpers", () => {
  it("normalizes nested content to its immediate top paragraph and addresses it", () => {
    const table = env.segments.find((s) => s.id === "tbl")!;
    expect(paragraphForSegment(env, table)?.id).toBe("p1");
    expect(paragraphAddress(env.segments[0]!)).toEqual({ id: "p0" });
    expect(formatAddresses(env, [env.segments[0]!, env.segments[2]!])).toEqual([{ id: "r0" }, { id: "r1" }]);
    expect(paragraphForSegment(env, env.segments.find((s) => s.id === "inner-para")!)?.id).toBe("inner-para");
  });

  it("toggles and extends ranges in paragraph reading order", () => {
    const initial = reducer(initialState, { type: "select", selection: { section: 0, para: 0, id: "p0" } });
    const extended = selectionAction(env, initial, env.segments[8]!, "extend");
    expect(extended.type).toBe("selectMany");
    if (extended.type !== "selectMany") return;
    const state = reducer(initial, extended);
    expect(selectedParagraphs(env, state).map((s) => s.id)).toEqual(["p0", "p1", "inner-para", "sibling-para", "p2"]);
    const toggled = selectionAction(env, state, env.segments[2]!, "toggle");
    expect(toggled.type).toBe("selectMany");
    if (toggled.type === "selectMany") expect(toggled.selections.map((s) => s.id)).toEqual(["p0", "inner-para", "sibling-para", "p2"]);
  });

  it("selects by direct properties only and returns no guess when absent", () => {
    expect(selectSimilar(env, env.segments[0]!, "char").map((r) => r.id)).toEqual(["p0", "p1", "sibling-para"]);
    expect(selectSimilar(env, { ...env.segments[0]!, directChar: undefined }, "char")).toEqual([]);
    expect(selectSimilar(env, env.segments[0]!, "para").map((r) => r.id)).toEqual(["p0", "p1", "inner-para", "sibling-para", "p2"]);
    const reordered = { ...env.segments[0]!, directChar: {
      face_ids: [0], faces: ["A"], color: "#000", size_pt: 10, italic: false, bold: false,
    } };
    expect(selectSimilar(env, reordered, "char").map((r) => r.id)).toContain("p1");
  });

  it("keeps legacy run ranges within the paragraph and emits unique source addresses", () => {
    const legacy: CatEnvelope = { markdown: "abcdefghij", segments: [
      { start: 0, end: 5, kind: "para", section: 0, para: 0 },
      { start: 0, end: 3, kind: "run", section: 0, para: 0, indices: [0, 2] },
      { start: 5, end: 8, kind: "run", section: 0, para: 0, indices: [0, 3] },
      { start: 1, end: 4, kind: "run", section: 0, para: 0 },
      { start: 6, end: 9, kind: "run", section: 0, para: 0 },
    ] };
    expect(formatAddresses(legacy, [legacy.segments[0]!])).toEqual([
      { at: { section: 0, paragraph: 0, run: 2 } },
      { at: { section: 0, paragraph: 0, run: 1 } },
    ]);
  });
});
