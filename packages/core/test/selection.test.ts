import { describe, expect, it } from "vitest";
import { compareSegments, formatAddresses, hasOwnRef, isSectionDefinitionParagraph, paragraphAddress, resolveSelection, segmentPath, selectSimilar, selectionAction, selectedParagraphs } from "../src/selection.js";
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
  it("maps every segment kind to exactly its own content, never an enclosing paragraph", () => {
    const table = env.segments.find((s) => s.id === "tbl")!;
    const cell = env.segments.find((s) => s.id === "cell")!;
    // The paragraph that anchors the table control is not the table's text: a
    // delete-para there removes the table, so a table has no paragraph target.
    expect(resolveSelection(env, table)).toEqual({ paragraphs: [], paragraph: undefined, refusal: "table" });
    // A cell's text lives in the paragraphs inside it, and all of them are the
    // target; no single one of them is, so replace/insert/delete are refused.
    expect(resolveSelection(env, cell)).toEqual({ paragraphs: [env.segments[6]!], paragraph: undefined, refusal: "cell" });
    expect(resolveSelection(env, env.segments[0]!)).toEqual({ paragraphs: [env.segments[0]!], paragraph: env.segments[0]!, refusal: null });
    expect(resolveSelection(env, env.segments[1]!)).toEqual({ paragraphs: [env.segments[0]!], paragraph: env.segments[0]!, refusal: null });
    expect(paragraphAddress(env.segments[0]!)).toEqual({ id: "p0" });
    expect(formatAddresses(env, [env.segments[0]!, env.segments[3]!])).toEqual([{ id: "r0" }, { id: "r0-other-style" }, { id: "r1" }]);
    expect(formatAddresses(env, [env.segments[1]!])).toEqual([{ id: "r0" }]);
    // A label names the real nesting path, not the host paragraph's index.
    expect(segmentPath(cell)).toBe("0/1.0.0");
    expect(segmentPath(env.segments[6]!)).toBe("0/1.0.0.0");
    // A cell whose paragraphs the envelope does not carry cannot be descended
    // into, and its host is not a substitute.
    const emptyCell: Segment = { id: "empty-cell", indices: [1, 0, 2], start: 10, end: 15, kind: "cell", section: 0, para: 1 };
    expect(resolveSelection({ markdown: env.markdown, segments: [...env.segments, emptyCell] }, emptyCell))
      .toEqual({ paragraphs: [], paragraph: undefined, refusal: "cell" });
    // A legacy projection carries no nesting path, so neither a table nor a
    // cell resolves, rather than falling back to the enclosing paragraph.
    const legacyHost: CatEnvelope = { markdown: "x", segments: [
      { start: 0, end: 1, kind: "para", section: 0, para: 0 },
      { start: 0, end: 1, kind: "table", section: 0, para: 0 },
      { start: 0, end: 1, kind: "cell", section: 0, para: 0 },
    ] };
    expect(resolveSelection(legacyHost, legacyHost.segments[1]!).paragraphs).toEqual([]);
    expect(resolveSelection(legacyHost, legacyHost.segments[2]!).paragraphs).toEqual([]);
    expect(resolveSelection(legacyHost, legacyHost.segments[0]!).paragraph).toBe(legacyHost.segments[0]);
  });

  it("extends from a table or an empty-cell anchor instead of throwing", () => {
    const emptyCell: Segment = { id: "empty-cell", indices: [1, 0, 2], start: 10, end: 15, kind: "cell", section: 0, para: 1 };
    const withEmpty: CatEnvelope = { markdown: env.markdown, segments: [...env.segments, emptyCell] };
    const last = withEmpty.segments.find((s) => s.id === "p2")!;
    // Ctrl-clicking a table stores its ref as the anchor; a later Shift-click
    // has no paragraph to measure the range from, so the range starts at the click.
    const fromTable = reducer(initialState, { type: "select", selection: { section: 0, para: 1, id: "tbl" } });
    expect(selectionAction(withEmpty, fromTable, last, "extend")).toEqual({
      type: "selectMany",
      selections: [{ section: 0, para: 2, id: "p2" }],
      primary: { section: 0, para: 2, id: "p2" },
      anchor: { section: 0, para: 2, id: "p2" },
    });
    const fromEmptyCell = reducer(initialState, { type: "select", selection: { section: 0, para: 1, id: "empty-cell" } });
    expect(selectionAction(withEmpty, fromEmptyCell, withEmpty.segments[0]!, "extend")).toEqual({
      type: "selectMany",
      selections: [{ section: 0, para: 0, id: "p0" }],
      primary: { section: 0, para: 0, id: "p0" },
      anchor: { section: 0, para: 0, id: "p0" },
    });
    // Shift-clicking the table itself adds nothing to a paragraph selection:
    // a table has no paragraph of its own, so the click reports its reason and
    // the selection stays, rather than widening to the table's host paragraph.
    const fromPara = reducer(initialState, { type: "select", selection: { section: 0, para: 0, id: "p0" } });
    const refused = selectionAction(withEmpty, fromPara, withEmpty.segments.find((s) => s.id === "tbl")!, "extend");
    expect(refused).toEqual({ type: "refuseSelection", refusal: "table" });
    // The state keeps the paragraph selected and records the reason.
    const kept = reducer(fromPara, refused);
    expect(kept.selection).toEqual({ section: 0, para: 0, id: "p0" });
    expect(kept.selectionRefusal).toBe("table");
  });

  it("covers every paragraph of a two-paragraph cell, and refuses the single-paragraph edits", () => {
    const twoCell: CatEnvelope = { markdown: "xy", segments: [
      { id: "host", indices: [1], start: 0, end: 2, kind: "para", section: 0, para: 1 },
      { id: "tbl2", indices: [1, 0], start: 0, end: 2, kind: "table", section: 0, para: 1 },
      { id: "cell2", indices: [1, 0, 0], start: 0, end: 2, kind: "cell", section: 0, para: 1 },
      { id: "cell-p0", indices: [1, 0, 0, 0], start: 0, end: 1, kind: "para", section: 0, para: 1 },
      { id: "cell-p0-r0", indices: [1, 0, 0, 0, 0], start: 0, end: 1, kind: "run", section: 0, para: 1 },
      { id: "cell-p1", indices: [1, 0, 0, 1], start: 1, end: 2, kind: "para", section: 0, para: 1 },
      { id: "cell-p1-r0", indices: [1, 0, 0, 1, 0], start: 1, end: 2, kind: "run", section: 0, para: 1 },
    ] };
    const cell = twoCell.segments.find((s) => s.id === "cell2")!;
    const resolved = resolveSelection(twoCell, cell);
    expect(resolved.paragraphs.map((p) => p.id)).toEqual(["cell-p0", "cell-p1"]);
    expect(resolved.paragraph).toBeUndefined();
    expect(resolved.refusal).toBe("cell");
    // What the editor counts as selected is both paragraphs, so align and
    // spacing reach the whole cell.
    const selected = reducer(initialState, { type: "select", selection: { section: 0, para: 1, id: "cell2" } });
    expect(selectedParagraphs(twoCell, selected).map((p) => p.id)).toEqual(["cell-p0", "cell-p1"]);
    // Character format walks the runs of both, not of the first only.
    expect(formatAddresses(twoCell, resolved.paragraphs, null)).toEqual([{ id: "cell-p0-r0" }, { id: "cell-p1-r0" }]);
    // Toggling the cell on takes both together, and the anchor keeps the cell
    // it came from, so a later range still covers the cell's whole span.
    const empty = reducer(initialState, { type: "select", selection: null });
    const onCell = selectionAction(twoCell, empty, cell, "toggle");
    expect(onCell).toEqual({
      type: "selectMany",
      selections: [{ section: 0, para: 1, id: "cell-p0" }, { section: 0, para: 1, id: "cell-p1" }],
      primary: { section: 0, para: 1, id: "cell-p0" },
      anchor: { section: 0, para: 1, id: "cell2" },
    });
    // A second Ctrl-click takes the cell off: the toggle compares the cell's
    // paragraphs with the stored ones, so neither half is left behind.
    const selectedCell = reducer(empty, onCell!);
    const offCell = reducer(selectedCell, selectionAction(twoCell, selectedCell, cell, "toggle")!);
    expect(offCell.selections).toEqual([]);
    expect(offCell.selection).toBeNull();
  });

  it("extends from a cell anchor by every paragraph of the cell", () => {
    const withNeighbours: CatEnvelope = { markdown: "a\n\nb\n\nc\n\nd", segments: [
      { id: "above", indices: [0], start: 0, end: 1, kind: "para", section: 0, para: 0 },
      { id: "host", indices: [1], start: 3, end: 8, kind: "para", section: 0, para: 1 },
      { id: "tbl", indices: [1, 0], start: 3, end: 8, kind: "table", section: 0, para: 1 },
      { id: "cell", indices: [1, 0, 0], start: 3, end: 8, kind: "cell", section: 0, para: 1 },
      { id: "c0", indices: [1, 0, 0, 0], start: 3, end: 4, kind: "para", section: 0, para: 1 },
      { id: "c1", indices: [1, 0, 0, 1], start: 6, end: 7, kind: "para", section: 0, para: 1 },
      { id: "below", indices: [2], start: 9, end: 10, kind: "para", section: 0, para: 2 },
    ] };
    const segmentFor = (id: string): Segment => withNeighbours.segments.find((s) => s.id === id)!;
    const cellSelected = reducer(initialState, selectionAction(withNeighbours, initialState, segmentFor("cell"), "toggle")!);
    expect(selectedParagraphs(withNeighbours, cellSelected).map((paragraph) => paragraph.id)).toEqual(["c0", "c1"]);
    // Downwards the cell's span ends at its last paragraph, so extending past
    // the cell keeps all of it instead of stopping at its first paragraph.
    const downwards = reducer(cellSelected, selectionAction(withNeighbours, cellSelected, segmentFor("below"), "extend")!);
    expect(selectedParagraphs(withNeighbours, downwards).map((paragraph) => paragraph.id)).toEqual(["c0", "c1", "below"]);
    // Upwards from the state that extend left behind, the same span is still
    // the endpoint, so the second half of the cell is not dropped by the
    // paragraph above it. The paragraph that holds the table control sits
    // inside that span in path order and comes with it; it is a paragraph of
    // the flow, not the cell's text.
    const upwards = reducer(downwards, selectionAction(withNeighbours, downwards, segmentFor("above"), "extend")!);
    expect(selectedParagraphs(withNeighbours, upwards).map((paragraph) => paragraph.id)).toEqual(["above", "host", "c0", "c1"]);
  });

  it("gives an image, a field and a bookmark no paragraph target at all", () => {
    const container: CatEnvelope = { markdown: "abcde", segments: [
      { id: "host", indices: [1], start: 0, end: 5, kind: "para", section: 0, para: 1 },
      { id: "img", indices: [1, 0], start: 0, end: 5, kind: "image", section: 0, para: 1 },
      { id: "fld", indices: [1, 1], start: 0, end: 5, kind: "field", section: 0, para: 1 },
      { id: "bmk", indices: [1, 2], start: 0, end: 5, kind: "bookmark", section: 0, para: 1 },
    ] };
    for (const kind of ["image", "field", "bookmark"] as const) {
      const segment = container.segments.find((s) => s.kind === kind)!;
      // Its range sits inside the host paragraph's, so resolving to that
      // paragraph would hand the host's text to a delete.
      expect(resolveSelection(container, segment))
        .toEqual({ paragraphs: [], paragraph: undefined, refusal: "container" });
    }
    // A modifier click on one of them adds nothing: a multi-selection holds
    // paragraphs, and none of these kinds has one of its own.
    const state = reducer(initialState, { type: "select", selection: { section: 0, para: 1, id: "host" } });
    expect(selectionAction(container, state, container.segments[1]!, "toggle"))
      .toEqual({ type: "refuseSelection", refusal: "container" });
    expect(selectionAction(container, state, container.segments[1]!, "extend"))
      .toEqual({ type: "refuseSelection", refusal: "container" });
    // A plain click still selects the segment it hit, alone, so the inspector
    // can name its own reason for refusing paragraph edits.
    expect(selectionAction(container, state, container.segments[1]!, "single"))
      .toEqual({ type: "select", selection: { section: 0, para: 1, id: "img" } });
  });

  it("never carries a table into a multi-selection, so a paragraph stays primary", () => {
    // A plain click selects the table; every modifier click after it used to
    // append to that ref, leaving the table primary and hiding the controls for
    // the paragraph that was actually clicked.
    const onTable = reducer(initialState, { type: "select", selection: { section: 0, para: 1, id: "tbl" } });
    const p2 = env.segments.find((s) => s.id === "p2")!;
    const first = selectionAction(env, onTable, p2, "toggle");
    expect(first).toEqual({
      type: "selectMany",
      selections: [{ section: 0, para: 2, id: "p2" }],
      primary: { section: 0, para: 2, id: "p2" },
      anchor: { section: 0, para: 2, id: "p2" },
    });
    const two = reducer(onTable, first!);
    const three = reducer(two, selectionAction(env, two, env.segments[0]!, "toggle")!);
    expect(three.selection?.id).toBe("p0");
    expect(selectedParagraphs(env, three).map((paragraph) => paragraph.id)).toEqual(["p0", "p2"]);
    // Ctrl-clicking p0 again removes it, and the primary falls to a paragraph
    // that is still selected, never back to the table ref that started this.
    const off = reducer(three, selectionAction(env, three, env.segments[0]!, "toggle")!);
    expect(off.selection?.id).toBe("p2");
    expect(off.selections?.map((ref) => ref.id)).toEqual(["p2"]);
  });

  it("starts a fresh paragraph selection from a run-level one, replacing rather than merging", () => {
    const plain = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) };
    const bold = { ...plain, bold: true };
    const runs: CatEnvelope = { markdown: "xy\n\nxy\n\nz", segments: [
      { id: "P0", indices: [0], start: 0, end: 2, kind: "para", section: 0, para: 0, directChar: plain },
      { id: "r00", indices: [0, 0], start: 0, end: 1, kind: "run", section: 0, para: 0, directChar: plain },
      { id: "r01", indices: [0, 1], start: 1, end: 2, kind: "run", section: 0, para: 0, directChar: bold },
      { id: "P1", indices: [1], start: 4, end: 6, kind: "para", section: 0, para: 1, directChar: plain },
      { id: "r10", indices: [1, 0], start: 4, end: 5, kind: "run", section: 0, para: 1, directChar: plain },
      { id: "r11", indices: [1, 1], start: 5, end: 6, kind: "run", section: 0, para: 1, directChar: bold },
      { id: "P2", indices: [2], start: 8, end: 9, kind: "para", section: 0, para: 2, directChar: plain },
      { id: "r20", indices: [2, 0], start: 8, end: 9, kind: "run", section: 0, para: 2, directChar: plain },
    ] };
    const segmentFor = (id: string): Segment => runs.segments.find((s) => s.id === id)!;
    const p2 = segmentFor("P2");
    // Matching character format runs from the selected run's own bold shape and
    // selects the bold runs, never their paragraphs.
    const similar = selectSimilar(runs, segmentFor("r01"), "char");
    expect(similar.map((ref) => ref.id)).toEqual(["r01", "r11"]);
    const afterSimilar = reducer(initialState, { type: "selectMany", selections: similar, primary: similar[0]!, anchor: similar[0]! });
    // A run-level selection is terminal. Run paths and control paths do not
    // order together, so a modifier click replaces the run list with the
    // clicked unit's own paragraphs: the bold runs are dropped rather than
    // mixed with P2's run, which is what pulled a table cell's run into one
    // range before.
    const toggled = selectionAction(runs, afterSimilar, p2, "toggle");
    expect(toggled).toEqual({
      type: "selectMany",
      selections: [{ section: 0, para: 2, id: "P2" }],
      primary: { section: 0, para: 2, id: "P2" },
      anchor: { section: 0, para: 2, id: "P2" },
    });
    expect(selectionAction(runs, afterSimilar, segmentFor("P1"), "extend")).toEqual({
      type: "selectMany",
      selections: [{ section: 0, para: 1, id: "P1" }],
      primary: { section: 0, para: 1, id: "P1" },
      anchor: { section: 0, para: 1, id: "P1" },
    });
    // The state the click leaves holds that one paragraph, so the format op
    // addresses its runs and nothing from the run list it replaced.
    const restarted = reducer(afterSimilar, toggled!);
    expect(selectedParagraphs(runs, restarted).map((paragraph) => paragraph.id)).toEqual(["P2"]);
    expect(formatAddresses(runs, selectedParagraphs(runs, restarted))).toEqual([{ id: "r20" }]);
  });

  it("orders paragraphs by path, not envelope position, so a point paragraph sorts in place", () => {
    const pointScan: CatEnvelope = { markdown: "ab\n\ncd", segments: [
      { id: "P0", indices: [0], start: 0, end: 2, kind: "para", section: 0, para: 0 },
      { id: "P2", indices: [2], start: 4, end: 6, kind: "para", section: 0, para: 2 },
      { id: "r2", indices: [2, 0], start: 4, end: 6, kind: "run", section: 0, para: 2 },
      { id: "P1", indices: [1], start: 4, end: 4, kind: "para", section: 0, para: 1 },
    ] };
    const state = reducer(initialState, { type: "select", selection: { section: 0, para: 0, id: "P0" } });
    // The empty point paragraph at offset 4 is emitted after P2 in the
    // envelope, but it reads before it.
    const toPoint = selectionAction(pointScan, state, pointScan.segments[3]!, "extend");
    expect(toPoint.type).toBe("selectMany");
    if (toPoint.type !== "selectMany") return;
    expect(toPoint.selections.map((ref) => ref.id)).toEqual(["P0", "P1"]);
    // The range past the point takes it in rather than skipping it.
    const toLast = selectionAction(pointScan, state, pointScan.segments[1]!, "extend");
    expect(toLast.type).toBe("selectMany");
    if (toLast.type !== "selectMany") return;
    expect(toLast.selections.map((ref) => ref.id)).toEqual(["P0", "P1", "P2"]);
    expect(selectedParagraphs(pointScan, reducer(state, toLast)).map((p) => p.id)).toEqual(["P0", "P1", "P2"]);
    expect([...pointScan.segments].filter((s) => s.kind === "para").sort(compareSegments).map((s) => s.id))
      .toEqual(["P0", "P1", "P2"]);
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

  it("addresses a character window from published source offsets, and keeps the whole-run fallback", () => {
    const plain = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) };
    const p: Segment = { id: "p", indices: [0], start: 0, end: 7, kind: "para", section: 0, para: 0 };
    const run: Segment = { id: "r0", indices: [0, 0], start: 0, end: 6, kind: "run", section: 0, para: 0,
      directChar: plain, sourceChars: { start: 0, end: 6 } };
    const source: CatEnvelope = { markdown: "동일문 안내\n", segments: [p, run] };
    const range = { paragraph: { section: 0, para: 0, id: "p" }, start: 0, end: 3 };
    // Three of the six characters: the op names the run and the half-open
    // source window, so the rest of the run is outside the edit.
    expect(formatAddresses(source, [p], range)).toEqual([{ id: "r0", chars: [0, 3] }]);
    // The whole run needs no window, exactly as before #71.
    expect(formatAddresses(source, [p], { ...range, start: 0, end: 6 })).toEqual([{ id: "r0" }]);
    // A schema 1.0 host publishes no source offsets, so a partial selection
    // keeps the pre-#71 behavior and formats the whole run.
    const legacy = { ...run } as Segment;
    delete legacy.sourceChars;
    expect(formatAddresses({ markdown: source.markdown, segments: [p, legacy] }, [p], range)).toEqual([{ id: "r0" }]);
    // A source span the projection cannot read back exactly refuses the
    // selection rather than formatting characters the user did not pick.
    expect(formatAddresses({ markdown: source.markdown, segments: [p, { ...run, sourceChars: { start: 0, end: 4 } }] }, [p], range))
      .toEqual([]);
  });

  it("keeps a split run's pieces apart by their source windows", () => {
    const plain = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) };
    const p: Segment = { id: "p", indices: [0], start: 0, end: 6, kind: "para", section: 0, para: 0 };
    const first: Segment = { id: "split", indices: [0, 0], start: 0, end: 3, kind: "run", section: 0, para: 0,
      directChar: plain, sourceChars: { start: 0, end: 3 } };
    const second: Segment = { id: "split", indices: [0, 1], start: 4, end: 6, kind: "run", section: 0, para: 0,
      directChar: plain, sourceChars: { start: 3, end: 5 } };
    const envelope: CatEnvelope = { markdown: "abc|de\n", segments: [p, first, second] };
    // A block control interrupts the run, so one id names two pieces: the
    // covered piece is the whole run, the partly covered one carries its own
    // window, and the two are not deduplicated into one op.
    expect(formatAddresses(envelope, [p], { paragraph: { section: 0, para: 0, id: "p" }, start: 0, end: 5 }))
      .toEqual([{ id: "split" }, { id: "split", chars: [3, 4] }]);
    expect(formatAddresses(envelope, [p], { paragraph: { section: 0, para: 0, id: "p" }, start: 1, end: 5 }))
      .toEqual([{ id: "split", chars: [1, 3] }, { id: "split", chars: [3, 4] }]);
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

  it("refuses a nested paragraph that carries no id of its own (t18-18)", () => {
    // A ref is {section, para} plus an optional id, so a nested paragraph with
    // no id names the host: selecting it and pressing Delete would remove the
    // host with everything the projection nested inside it.
    const host: Segment = { id: "host", indices: [0], start: 0, end: 4, kind: "para", section: 0, para: 0 };
    const nested: Segment = { indices: [0, 0, 0, 0], start: 0, end: 4, kind: "para", section: 0, para: 0 };
    const legacy: Segment = { start: 0, end: 4, kind: "para", section: 0, para: 0 };
    const graph: CatEnvelope = { markdown: "abcd", segments: [host, nested] };
    expect(hasOwnRef(host)).toBe(true);
    // A legacy projection names no path, so its bare coordinate is its own.
    expect(hasOwnRef(legacy)).toBe(true);
    expect(hasOwnRef(nested)).toBe(false);

    expect(resolveSelection(graph, nested)).toEqual({ paragraphs: [], paragraph: undefined, refusal: "unaddressable" });
    expect(selectionAction(graph, initialState, nested, "single")).toEqual({ type: "refuseSelection", refusal: "unaddressable" });
    expect(selectionAction(graph, initialState, host, "single")).toEqual({
      type: "select",
      selection: { section: 0, para: 0, id: "host" },
    });
  });

  it("refuses a cell's or a run's id-less nested holder instead of naming the host (t18-18)", () => {
    // The same shape arrives by three more routes: a cell whose only paragraph
    // is a nested table's (no id), a run with an id under that paragraph, and
    // the similar-format sweep. Each used to hand back a bare coordinate,
    // which segmentForRef resolves to the host paragraph.
    const plain = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) };
    const host: Segment = { id: "host", indices: [0], start: 0, end: 6, kind: "para", section: 0, para: 0, directChar: plain };
    const cell: Segment = { id: "cell", indices: [0, 1], start: 0, end: 6, kind: "cell", section: 0, para: 0 };
    const nested: Segment = { indices: [0, 1, 0], start: 0, end: 6, kind: "para", section: 0, para: 0, directChar: plain };
    const run: Segment = { id: "inner-run", indices: [0, 1, 0, 0], start: 0, end: 6, kind: "run", section: 0, para: 0, directChar: plain };
    const graph: CatEnvelope = { markdown: "abcdef", segments: [host, cell, nested, run] };
    // The cell's paragraphs exist but none of them can name itself, so the
    // whole cell is unaddressable rather than most of it being edited.
    expect(resolveSelection(graph, cell)).toEqual({ paragraphs: [], paragraph: undefined, refusal: "unaddressable" });
    expect(resolveSelection(graph, nested)).toEqual({ paragraphs: [], paragraph: undefined, refusal: "unaddressable" });
    // The run's id addresses the run itself, but every paragraph-level op goes
    // through its holder, and that paragraph's ref is the host's coordinate.
    expect(resolveSelection(graph, run)).toEqual({ paragraphs: [], paragraph: undefined, refusal: "unaddressable" });
    const onCell = reducer(initialState, { type: "select", selection: { section: 0, para: 0, id: "cell" } });
    expect(selectionAction(graph, onCell, cell, "toggle"))
      .toEqual({ type: "refuseSelection", refusal: "unaddressable" });
    expect(selectionAction(graph, onCell, run, "toggle"))
      .toEqual({ type: "refuseSelection", refusal: "unaddressable" });
    // What the editor counts as selected follows the same rule.
    expect(selectedParagraphs(graph, onCell)).toEqual([]);
  });

  it("sweeps similar format past the units that cannot name themselves (t18-18)", () => {
    // selectSimilar feeds set-char, set-para and set-align through the state,
    // so a ref it returns has to name the unit itself. The id-less nested
    // paragraph and run match the shape and are left out; the ones that name
    // themselves still select.
    const plain = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) };
    const shape = { alignment: "left" as const, indent: 0, line_spacing: 160, line_spacing_type: 0 };
    const topPara: Segment = { id: "top-p", indices: [0], start: 0, end: 6, kind: "para", section: 0, para: 0, directPara: shape, directChar: plain };
    const topRun: Segment = { id: "top-r", indices: [0, 0], start: 0, end: 3, kind: "run", section: 0, para: 0, directChar: plain };
    const nestedPara: Segment = { indices: [0, 1, 0, 0], start: 0, end: 6, kind: "para", section: 0, para: 0, directPara: shape, directChar: plain };
    const nestedRun: Segment = { indices: [0, 1, 0, 0, 0], start: 0, end: 3, kind: "run", section: 0, para: 0, directChar: plain };
    const graph: CatEnvelope = { markdown: "abcdef", segments: [topPara, topRun, nestedPara, nestedRun] };
    expect(selectSimilar(graph, topRun, "char")).toEqual([{ section: 0, para: 0, id: "top-r" }]);
    expect(selectSimilar(graph, topPara, "para")).toEqual([{ section: 0, para: 0, id: "top-p" }]);
    // A legacy projection carries no indices at all, so its paragraphs are
    // still swept: the filter drops units that have a path but no id, not the
    // coordinate that is the only identity an older projection has.
    const legacy: CatEnvelope = { markdown: "abcdef", segments: [
      { start: 0, end: 6, kind: "para", section: 0, para: 0, directPara: shape },
      { start: 0, end: 6, kind: "para", section: 0, para: 1, directPara: shape },
    ] };
    expect(selectSimilar(legacy, legacy.segments[0]!, "para")).toEqual([
      { section: 0, para: 0 }, { section: 0, para: 1 },
    ]);
  });

  it("classifies a section's definition paragraph by position, not by text", () => {
    // Body paragraph 0 of every section carries SectionDef: the engine will not
    // move it and refuses an insertion before it. It reads as an ordinary
    // (usually empty) paragraph, so the index is the only signal.
    const definition: Segment = { id: "def", indices: [0], start: 0, end: 0, kind: "para", section: 0, para: 0 };
    const body: Segment = { id: "body", indices: [1], start: 0, end: 3, kind: "para", section: 0, para: 1 };
    const otherSection: Segment = { id: "def2", indices: [0], start: 0, end: 0, kind: "para", section: 1, para: 0 };
    const inCell: Segment = { id: "cell-p", indices: [1, 0, 0, 0], start: 0, end: 3, kind: "para", section: 0, para: 1 };
    const run: Segment = { id: "run", indices: [0, 0], start: 0, end: 3, kind: "run", section: 0, para: 0 };
    const legacy: Segment = { start: 0, end: 3, kind: "para", section: 0, para: 0 };
    expect(isSectionDefinitionParagraph(definition)).toBe(true);
    expect(isSectionDefinitionParagraph(otherSection)).toBe(true);
    expect(isSectionDefinitionParagraph(body)).toBe(false);
    // A cell's first paragraph is nested, and its host index is not its own.
    expect(isSectionDefinitionParagraph(inCell)).toBe(false);
    expect(isSectionDefinitionParagraph(run)).toBe(false);
    expect(isSectionDefinitionParagraph(legacy)).toBe(false);
  });
});
