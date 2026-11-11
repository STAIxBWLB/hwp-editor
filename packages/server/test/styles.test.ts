/**
 * Named styles against the real binary (issue #53, WP3/T5).
 *
 * The parts of AC6 and AC7 that a stub cannot show:
 *
 * - `hwp styles` reports the composed document's styles and the paragraph ids
 *   that use them, which is the join the Styles panel highlights from;
 * - one `update_style` on the body style moves every paragraph that inherits
 *   it, and leaves a run whose size was set directly alone;
 * - the same preset batch applied twice is byte-identical, which is what makes
 *   the preset switch idempotent for a user who presses it again.
 *
 * The undo half of AC6 — ONE engine call, ONE history entry — lives in
 * `packages/react/test/styles-panel.test.tsx`, because the history is the
 * client store's, not the engine's.
 *
 * Skipped when no runnable hwp is installed, exactly like the other
 * real-binary suites.
 */
import { expect, it } from "vitest";
import { bodyStyle, type DocumentSpecV2, type EditOp } from "@hwp-editor/core";
import { createCliEngine } from "../src/cli-engine.js";
import { BIN, describeBin } from "./helpers.js";

const engine = createCliEngine({ bin: BIN, timeoutMs: 60_000 });

/** A two-paragraph body (one run formatted directly) and a 2x2 table. */
const SPEC = {
  version: "2.0",
  document: {
    version: "1.0",
    metadata: { title: "스타일 시험" },
    styles: {
      body: { font_family: "함초롬바탕", font_size_pt: 12, line_height_percent: 160, align: "justify" },
      heading: { font_family: "함초롬바탕", font_size_pt: 15, bold: true, align: "left" },
    },
    sections: [
      {
        blocks: [
          { type: "paragraph", style: "heading", runs: [{ type: "text", text: "1. 스타일" }] },
          { type: "paragraph", style: "body", runs: [{ type: "text", text: "첫 번째 본문" }] },
          {
            type: "paragraph",
            style: "body",
            runs: [
              { type: "text", text: "두 번째 본문 " },
              // Direct formatting: an explicit size on the run, which the
              // engine keeps as the direct level of its segment.
              { type: "text", text: "직접 서식", font_size_pt: 20, bold: true },
            ],
          },
          {
            type: "table",
            columns: [{ width_mm: 60 }, { width_mm: 60 }],
            rows: [
              {
                cells: [
                  { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "A1" }] }] },
                  { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "B1" }] }] },
                ],
              },
              {
                cells: [
                  { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "A2" }] }] },
                  { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "B2" }] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
} as unknown as DocumentSpecV2;

async function base() {
  const composed = await engine.compose(SPEC, "styles.hwpx");
  return composed.document;
}

/**
 * The same two body paragraphs with no table at all — the document `hwp edit
 * --style-tables` aborts on, and the reason the preset travels as an op.
 */
const NO_TABLE_SPEC = {
  version: "2.0",
  document: {
    version: "1.0",
    metadata: { title: "표 없음" },
    styles: {
      body: { font_family: "함초롬바탕", font_size_pt: 12, line_height_percent: 160, align: "justify" },
      heading: { font_family: "함초롬바탕", font_size_pt: 15, bold: true, align: "left" },
    },
    sections: [
      {
        blocks: [
          { type: "paragraph", style: "heading", runs: [{ type: "text", text: "1. 표가 없는 문서" }] },
          { type: "paragraph", style: "body", runs: [{ type: "text", text: "첫 번째 본문" }] },
          { type: "paragraph", style: "body", runs: [{ type: "text", text: "두 번째 본문" }] },
        ],
      },
    ],
  },
} as unknown as DocumentSpecV2;

describeBin("named styles (real hwp)", () => {
  it("advertises styles v1 and reports the table with the segments that use each style", async () => {
    const caps = await engine.capabilities();
    expect(caps.styles).toBe("v1");
    const document = await base();
    const table = await engine.styles(document);
    expect(table.version).toMatch(/^1\./);
    // `compose` keeps the spec's own style names beside the engine's seven
    // defaults, so the body style is the spec's, not 바탕글.
    expect(table.styles.map((row) => row.name)).toEqual(expect.arrayContaining(["body", "heading", "바탕글"]));
    const envelope = await engine.read(document);
    // Every id names a paragraph this document actually has: the highlight
    // resolves them against the same envelope `cat --segments v2` prints.
    const ids = new Set(envelope.segments.flatMap((segment) => (segment.id === undefined ? [] : [segment.id])));
    for (const row of table.styles) {
      for (const id of row.used_by) expect(ids.has(id)).toBe(true);
    }
    // The body style is the one the top-level paragraphs use, NOT the style
    // four table cells happen to make the most-used row. The table alone
    // answers 바탕글 here, which is the control that makes the envelope's
    // contribution visible rather than assumed.
    expect(bodyStyle(table)?.name).toBe("바탕글");
    expect(bodyStyle(table, envelope)?.name).toBe("body");
    expect(bodyStyle(table, envelope)?.used_by).toHaveLength(2);
  });

  /**
   * t12-a10: `create_style` clones its base's shapes (hwp-cli 1.4.0
   * styles/edit.rs:280-300), so whatever the base carries and the create op
   * does not set — line spacing, first-line indent — lands on the new style and
   * then on every paragraph the promote applies it to. This is the binary's
   * half of that: a base carrying both hands both over, and a create based on
   * another row does not.
   */
  it("t12-a10: a style created on the paragraph's own style keeps its spacing and indent", async () => {
    const document = await base();
    const table = await engine.styles(document);
    const body = table.styles.find((row) => row.name === "body")!;
    const fallback = table.styles.find((row) => row.name === "바탕글")!;
    // Give the body row the two properties the promote form has no control
    // for, so the clone has something to carry and the other base has
    // something to differ with.
    const indented = await engine.edit(document, [
      { kind: "update-style", style: body.id, lineSpacingPct: "175", indentMm: "8mm" },
    ], { verify: true });
    const before = await engine.styles(indented);
    const own = before.styles.find((row) => row.name === "body")!;
    expect(own.attrs.para?.line_spacing).toBe(175);
    // Control: the indent the promote does not send is really on this row.
    expect(own.attrs.para?.indent ?? 0).toBeGreaterThan(0);

    const created = await engine.edit(indented, [
      { kind: "create-style", name: "인용", basedOn: own.id, styleKind: "paragraph" },
    ], { verify: true });
    const afterOwn = await engine.styles(created);

    const promoted = afterOwn.styles.find((row) => row.name === "인용")!;
    expect(promoted.attrs.para?.line_spacing).toBe(own.attrs.para?.line_spacing);
    expect(promoted.attrs.para?.indent).toBe(own.attrs.para?.indent);
    expect(promoted.attrs.char?.size_pt).toBe(own.attrs.char?.size_pt);

    // The same create on a different base does not inherit it: the assertion
    // above measures the base, not something every row of this document has.
    const other = await engine.edit(indented, [
      { kind: "create-style", name: "기본", basedOn: fallback.id, styleKind: "paragraph" },
    ], { verify: true });
    const defaulted = (await engine.styles(other)).styles.find((row) => row.name === "기본")!;
    expect(defaulted.attrs.para?.indent).not.toBe(own.attrs.para?.indent);
  });

  it("AC6: one update_style moves every inheriting paragraph and leaves direct formatting alone", async () => {
    const document = await base();
    const before = await engine.styles(document);
    const beforeBody = bodyStyle(before, await engine.read(document))!;
    const beforeSize = beforeBody.attrs.char?.size_pt ?? 0;
    expect(beforeSize).toBe(12);
    const beforeRender = await engine.render(document, { pages: "1", format: "svg" });

    const ops: EditOp[] = [{ kind: "update-style", style: beforeBody.name, size: String(beforeSize + 3) }];
    const updated = await engine.edit(document, ops, { verify: true });

    const after = await engine.styles(updated);
    const afterBody = after.styles.find((row) => row.name === beforeBody.name)!;
    expect(afterBody.attrs.char?.size_pt).toBe(beforeSize + 3);

    // Ids are content checksums, so the edit re-keyed every paragraph: the
    // join has to come from the table READ AFTER the edit, never from the one
    // that describes the document as it was.
    const envelope = await engine.read(updated);
    const inheriting = envelope.segments.filter(
      (segment) => segment.id !== undefined && afterBody.used_by.includes(segment.id),
    );
    expect(inheriting).toHaveLength(2);
    // Every paragraph that inherits the style now reports the new size...
    for (const segment of inheriting) expect(segment.style?.char?.size_pt).toBe(beforeSize + 3);
    // ...while the run whose size was set directly keeps its own, which is
    // what leaves directly formatted text as it was.
    const direct = envelope.segments.filter((segment) => segment.direct?.char?.size_pt === 20);
    expect(direct).toHaveLength(1);
    expect(direct[0]!.style?.char?.size_pt).toBe(beforeSize + 3);

    // And the render moved with the shapes: the size change is visible.
    const afterRender = await engine.render(updated, { pages: "1", format: "svg" });
    expect(Buffer.from(afterRender[0]!.data).equals(Buffer.from(beforeRender[0]!.data))).toBe(false);
  });

  it("AC7: the same preset twice is byte-identical", async () => {
    const document = await base();
    const preset: EditOp = { kind: "style-tables", preset: "official" };
    const once = await engine.edit(document, [preset], { verify: true });
    const twice = await engine.edit(once, [preset], { verify: true });
    expect(Buffer.from(twice.data).equals(Buffer.from(once.data))).toBe(true);
  });

  /**
   * t12-a2. `hwp edit --style-tables` aborts the whole edit when the document
   * has no multi-column table, and the style update it was paired with dies
   * with it. Sent as the `style_tables` op the batch survives: the engine
   * reports the one op it could not apply and publishes the rest.
   */
  it("t12-a2: a document with nothing to style keeps the style update and reports the preset", async () => {
    const composed = await engine.compose(NO_TABLE_SPEC, "no-table.hwpx");
    const document = composed.document;
    const body = bodyStyle(await engine.styles(document), await engine.read(document))!;
    const beforeSize = body.attrs.char?.size_pt;
    expect(beforeSize).toBe(12);

    const result = await engine.edit(document, [
      { kind: "update-style", style: body.name, size: String(beforeSize! + 2) },
      { kind: "style-tables", preset: "official" },
    ], { verify: true });

    // The half the user asked for landed...
    const after = (await engine.styles(result)).styles.find((row) => row.name === body.name)!;
    expect(after.attrs.char?.size_pt).toBe(beforeSize! + 2);
    // ...and the preset said so in the report rather than taking the batch
    // down: this document simply has no eligible table.
    const outcome = result.report?.ops.find((op) => op.op === "style_tables");
    expect(outcome?.status).toBe("failed");
    expect(outcome?.reason).toContain("no styleable table");
  });

  /**
   * A preset batch necessarily runs under `--allow-partial`, so the engine
   * publishes the rest of a partly-applied batch and exits 0. A queued edit
   * that found no target must be refused here rather than quietly dropped, and
   * nothing of that batch may reach the caller.
   */
  it("t12-a2: refuses a batch another op's failure would otherwise have shrunk", async () => {
    const document = await base();
    await expect(engine.edit(document, [
      { kind: "style-tables", preset: "report" },
      // A pattern the document does not hold: the engine pushes it to
      // "unapplied" and publishes the rest, which is the case that must be
      // refused. An out-of-range ADDRESS is a parse error instead, so it would
      // exercise the wrong branch.
      { kind: "set-align", find: "없는 문자열", alignment: "center" },
    ], { verify: true })).rejects.toThrow(/unapplied/);
  });
});
