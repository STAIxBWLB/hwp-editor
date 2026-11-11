/**
 * Op-emission pins for the editing panels (TEST-03).
 *
 * Every op-emitting control in SegmentInspector and TableGrid has its exact
 * queued op shape asserted here against the mock engine's recorded `edit()`
 * call, so a wrong flag spelling, a dropped coordinate, or a lost
 * conditional key is a test failure rather than a runtime surprise against
 * hwp-cli.
 *
 * Selectors are TABLE-DRIVEN from the `en` table, never locale literals:
 * the op contract and the copy contract are independent, and rewording a
 * translation must never break an op assertion. The Korean strings below
 * are document CONTENT from the fixture envelope (cell values, paragraph
 * text) — no locale changes those.
 *
 * The three flows already pinned in editor.test.tsx (replace, set-cell,
 * set-field) are deliberately not duplicated here.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope, DocumentHandle, EditOp, EditReport, LayoutRow, PageImage, Segment } from "@hwp-editor/core";
import tableFixture from "../../core/test/fixtures/cat-segments-table.json";
import { base64, createTauriEngine, parseCatEnvelope } from "@hwp-editor/core";
import { targetsSegment } from "../src/PageCanvas.js";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { clientYForPara, createMockEngine, makeEnvelope, makePage } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = {
  name: "minutes.hwpx",
  data: new TextEncoder().encode("original"),
};

beforeAll(() => {
  // jsdom reports zero-size boxes; give pages the render's 595x842 rect.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("hwped-page")) {
      return {
        top: 0,
        left: 0,
        right: 595,
        bottom: 842,
        width: 595,
        height: 842,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

/** Build a segments envelope from paragraph blocks, as the CLI would. */
function envelopeOf(blocks: string[]): CatEnvelope {
  let markdown = "";
  const segments: CatEnvelope["segments"] = [];
  blocks.forEach((block, para) => {
    const start = markdown.length;
    markdown += `${block}\n\n`;
    segments.push({ start, end: start + block.length, kind: "para", section: 0, para });
  });
  return { markdown, segments };
}

/** The heading paragraph's plain text — the `find`/`anchor` every op carries. */
const HEADING = "1. 회의록";

type Engine = ReturnType<typeof createMockEngine>;

/** Render the editor and click the page so `para` becomes the selection. */
async function selectPara(
  engine: Engine,
  para: number,
  envelope: CatEnvelope = makeEnvelope(),
): Promise<void> {
  render(<HwpEditor engine={engine} file={file} />);
  const page = await screen.findByRole("button", {
    name: en["page.label"]({ page: 1 }),
  });
  fireEvent.click(page, { clientY: clientYForPara(envelope, para) });
}

/** Click the toolbar Apply for `count` queued ops and return the sent ops. */
async function applyOps(engine: Engine, count: number): Promise<EditOp[]> {
  await screen.findByText(en["toolbar.pendingEdits"]({ count }));
  fireEvent.click(
    screen.getByRole("button", { name: en["toolbar.applyWithCount"]({ count }) }),
  );
  await screen.findByText(en["toolbar.pendingEdits"]({ count: 0 }));
  expect(engine.calls.edit).toHaveLength(1);
  return engine.calls.edit[0]!.ops;
}

/** Select the heading paragraph and land in the paragraph inspector. */
async function openInspector(): Promise<Engine> {
  const engine = createMockEngine();
  await selectPara(engine, 0);
  await screen.findByText(HEADING);
  return engine;
}

/** Select the table paragraph (para 2) and land in the table grid. */
async function openTable(): Promise<Engine> {
  const engine = createMockEngine();
  await selectPara(engine, 2);
  await screen.findByRole("button", { name: "예산" });
  return engine;
}

/** Click a table cell by its rendered document text. */
function clickCell(text: string): void {
  fireEvent.click(screen.getByRole("button", { name: text }));
}

/** Click a control by its `en`-table label — never by a locale literal. */
function clickBtn(key: keyof typeof en): void {
  const label = en[key];
  if (typeof label !== "string") throw new Error(`${key} is not a plain label`);
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/**
 * A page whose layout carries one row, as the CLI render does. A click inside
 * that box hit-tests to the row's own segment by id, which is the only way a
 * cell or bookmark selection is reachable: the paragraph-only fallback never
 * yields one.
 */
function pageWithRow(segment: Segment, kind: LayoutRow["kind"] = "cell"): PageImage {
  return {
    ...makePage(),
    layout: {
      width_pt: 600,
      height_pt: 800,
      truncated: false,
      rows: [{
        id: segment.id!,
        kind,
        box: { x0: 100, y0: 100, x1: 300, y1: 140 },
        source_chars: { start: segment.start, end: segment.end },
      }],
    },
  };
}

/** Click the middle of {@link pageWithRow}'s box, in page pixels. */
function clickRow(): void {
  // 200/600 and 120/800 of the 595x842 page the jsdom stub reports.
  fireEvent.click(screen.getByRole("button", { name: en["page.label"]({ page: 1 }) }), {
    clientX: (200 / 600) * 595,
    clientY: (120 / 800) * 842,
  });
}

const tableEnvelope = parseCatEnvelope(JSON.stringify(tableFixture));

describe("SegmentInspector op emission (TEST-03)", () => {
  it.each([["en", en], ["ko", ko]] as const)("disables addressed edits on an argv-only Tauri host (%s)", async (locale, messages) => {
    const commands: string[] = [];
    const pageImage = makePage();
    const responses: Record<string, unknown> = {
      hwped_capabilities: { version: "1.3.1", editable: true, formats: ["hwp", "hwpx"] },
      hwped_read: makeEnvelope(),
      hwped_render: { pages: [{ ...pageImage, dataBase64: base64.encode(pageImage.data) }] },
      hwped_validate: { valid: true, errors: [] },
    };
    const engine = createTauriEngine(async (command) => {
      commands.push(command);
      if (!(command in responses)) throw new Error(`unexpected command ${command}`);
      return responses[command] as never;
    });
    render(<HwpEditor locale={locale} engine={engine} file={file} />);
    const page = await screen.findByRole("button", { name: messages["page.label"]({ page: 1 }) });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });
    expect(await screen.findByText(messages["segment.addressedUnavailable"])).toBeTruthy();
    const panel = screen.getByRole("region", { name: messages["segment.panelAria"] });
    const anchorInputs = [
      screen.getByLabelText(messages["segment.hyperlinkUrlAria"]),
      screen.getByLabelText(messages["segment.hyperlinkTextAria"]),
    ];
    // Paragraph options and the anchor inputs work on an argv-only host: selection is
    // navigation and anchors ride the argv channel, so neither is an addressed edit.
    const argvControls = [...anchorInputs, ...Array.from(panel.querySelectorAll('[role="option"]'))];
    for (const control of Array.from(panel.querySelectorAll("input, textarea, button"))) {
      expect((control as HTMLButtonElement).disabled).toBe(!argvControls.includes(control as HTMLElement));
      fireEvent.click(control);
    }
    expect(screen.getByLabelText(messages["toolbar.pendingEdits"]({ count: 0 }), { exact: true })).toBeTruthy();
    expect(commands).not.toContain("hwped_edit");
  });

  it("uses a paragraph address after clicking past a final formatted paragraph", async () => {
    const envelope = envelopeOf(["첫 문단", "마지막 서식 문단"]);
    const paragraph = envelope.segments[1]!;
    paragraph.id = "1234567890abcdef.0.1";
    paragraph.indices = [1];
    envelope.segments.push({ ...paragraph, kind: "run", id: "1234567890abcdef.0.1.0", indices: [1, 0], start: paragraph.start + 2 });
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} />);
    const page = await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });
    fireEvent.click(page, { clientY: 842 });
    clickBtn("segment.alignCenter");
    expect(await applyOps(engine, 1)).toEqual([
      { kind: "set-align", address: { id: paragraph.id }, alignment: "center" },
    ]);
  });

  it("disables character formatting for a v2 paragraph without immediate runs", async () => {
    const engine = createMockEngine({ envelope: tableEnvelope });
    await selectPara(engine, tableEnvelope.segments.findIndex(segment =>
      segment.kind === "para" && segment.para === 2 && segment.indices?.length === 1), tableEnvelope);
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.para"] }));
    fireEvent.click(screen.getByLabelText(en["segment.bold"]));
    const submit = screen.getByRole("button", { name: en["segment.formatSubmit"] });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(screen.getByLabelText(en["toolbar.pendingEdits"]({ count: 0 }), { exact: true })).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it.each([
    [{ section: 0, paragraph: 2 }, [2]],
    [{ section: 0, paragraph: 0, run: 0 }, [0, 0]],
    [{ section: 0, paragraph: 2, run: 0 }, null],
  ])("matches at-address %j without highlighting nested segments", (at, indices) => {
    const op: EditOp = { kind: "set-align", address: { at }, alignment: "left" };
    const matches = tableEnvelope.segments.filter(segment => targetsSegment(op, tableEnvelope, segment));
    expect(matches.map(segment => segment.indices)).toEqual(indices === null ? [] : [indices]);
  });

  it("queues insert-para-before with the selection anchor and typed text", async () => {
    const engine = await openInspector();
    fireEvent.change(screen.getByLabelText(en["segment.insertLabel"]), {
      target: { value: "머리말" },
    });
    clickBtn("segment.insertBefore");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "insert-para-before", address: { at: { section: 0, paragraph: 0 } }, text: "머리말" },
    ]);
  });

  it("queues insert-para with the selection anchor and typed text", async () => {
    const engine = await openInspector();
    fireEvent.change(screen.getByLabelText(en["segment.insertLabel"]), {
      target: { value: "꼬리말" },
    });
    clickBtn("segment.insertAfter");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "insert-para", address: { at: { section: 0, paragraph: 0 } }, text: "꼬리말" },
    ]);
  });

  it("queues delete-para carrying the selected paragraph's text", async () => {
    const engine = await openInspector();
    clickBtn("segment.deletePara");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "delete-para", address: { at: { section: 0, paragraph: 0 } } },
    ]);
  });

  it.each([
    ["segment.alignLeft", "left"],
    ["segment.alignCenter", "center"],
    ["segment.alignRight", "right"],
    ["segment.alignJustify", "justify"],
  ] as const)(
    "queues set-align from %s with the clicked alignment",
    async (key, alignment) => {
      const engine = await openInspector();
      clickBtn(key);

      expect(await applyOps(engine, 1)).toEqual([
        { kind: "set-align", address: { at: { section: 0, paragraph: 0 } }, alignment },
      ]);
    },
  );

  it("addresses only the selected duplicate and lists its pending target", async () => {
    const envelope = envelopeOf(["반복문구", "반복문구"]);
    envelope.segments[0]!.id = "1234567890abcdef.0.0";
    envelope.segments[1]!.id = "1234567890abcdef.0.1";
    envelope.segments.push({ ...envelope.segments[1]!, kind: "run", id: "1234567890abcdef.0.1.0" });
    const engine = createMockEngine({ envelope });
    await selectPara(engine, 1, envelope);
    fireEvent.click(screen.getByLabelText(en["segment.bold"]));
    clickBtn("segment.formatSubmit");
    expect(screen.getByLabelText(en["toolbar.pendingEdits"]({ count: 1 }), { exact: true }).textContent)
      .toBe(en["toolbar.pendingEdits"]({ count: 1 }));
    expect(screen.getByRole("list", { name: en["toolbar.pendingList"] }).className)
      .toBe("hwped-pending-list");
    expect(screen.getByRole("list", { name: en["toolbar.pendingList"] }).textContent).toContain("1234567890abcdef.0.1.0");
    expect(await applyOps(engine, 1)).toEqual([
      { kind: "set-format", address: { id: "1234567890abcdef.0.1.0" }, props: { bold: "on" } },
    ]);
  });

  it("queues every immediate run of a styled paragraph in one edit call", async () => {
    const envelope = envelopeOf(["서식 있는 문단", "다른 문단"]);
    const para = envelope.segments[0]!;
    para.id = "1234567890abcdef.0.0";
    para.indices = [0];
    envelope.segments.push(
      { ...para, kind: "run", id: "1234567890abcdef.0.0.0", indices: [0, 0], end: 3 },
      { ...para, kind: "run", id: "1234567890abcdef.0.0.1", indices: [0, 1], start: 3 },
      { ...para, kind: "run", id: "1234567890abcdef.0.0.2.0", indices: [0, 2, 0] },
    );
    const engine = createMockEngine({ envelope });
    await selectPara(engine, 0, envelope);
    fireEvent.click(screen.getByLabelText(en["segment.bold"]));
    clickBtn("segment.formatSubmit");
    expect(await applyOps(engine, 2)).toEqual([
      { kind: "set-format", address: { id: "1234567890abcdef.0.0.0" }, props: { bold: "on" } },
      { kind: "set-format", address: { id: "1234567890abcdef.0.0.1" }, props: { bold: "on" } },
    ]);
  });

  it("queues set-format with ONLY the props that were set", async () => {
    const engine = await openInspector();
    fireEvent.change(screen.getByLabelText(en["segment.sizeAria"]), {
      target: { value: "12" },
    });
    clickBtn("segment.formatSubmit");

    // bold and color were never touched: their keys must be absent, not
    // present-and-empty — the conditional spread is the contract.
    expect(await applyOps(engine, 1)).toEqual([
      { kind: "set-format", address: { at: { section: 0, paragraph: 0, run: 0 } }, props: { size: "12" } },
    ]);
  });

  it("edits every paragraph of a selected cell, and refuses the one-paragraph ops", async () => {
    // A cell carrying two paragraphs of its own, as the CLI emits for a wrapped
    // cell. The host paragraph holds the table control, so it is never a target.
    const markdown = "가\n\n나\n";
    const host: Segment = { id: "cell-host", indices: [2], start: 0, end: 5, kind: "para", section: 0, para: 2 };
    const table: Segment = { id: "cell-table", indices: [2, 0], start: 0, end: 5, kind: "table", section: 0, para: 2 };
    const cell: Segment = { id: "cell-two", indices: [2, 0, 0], start: 0, end: 5, kind: "cell", section: 0, para: 2 };
    const first: Segment = { id: "cell-two-p0", indices: [2, 0, 0, 0], start: 0, end: 1, kind: "para", section: 0, para: 2 };
    const second: Segment = { id: "cell-two-p1", indices: [2, 0, 0, 1], start: 3, end: 4, kind: "para", section: 0, para: 2 };
    const envelope: CatEnvelope = { markdown, segments: [host, table, cell, first, second] };
    const engine = createMockEngine({ envelope });
    engine.render = async () => [pageWithRow(cell)];
    render(<HwpEditor engine={engine} file={file} />);
    await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });
    clickRow();

    // The label names the cell by its real nesting path, never the host
    // paragraph index the whole cell shares.
    expect(await screen.findByText(en["segment.selectedCell"]({ path: "0/2.0.0", count: 2 }))).toBeTruthy();
    const panel = screen.getByRole("region", { name: en["segment.panelAria"] });
    expect(panel.querySelector(".hwped-quote")?.textContent).toContain("나");
    // Replace, insert and delete address exactly one paragraph, so a cell
    // selection refuses them - the controls stay in view but dead - and says why.
    expect(screen.getByText(en["segment.cellSelectionRefused"])).toBeTruthy();
    expect((screen.getByRole("button", { name: en["segment.deletePara"] }) as HTMLButtonElement).disabled).toBe(true);
    // Alignment reaches both paragraphs of the cell, not only the first.
    clickBtn("segment.alignCenter");
    expect(await applyOps(engine, 2)).toEqual([
      { kind: "set-align", address: { id: "cell-two-p0" }, alignment: "center" },
      { kind: "set-align", address: { id: "cell-two-p1" }, alignment: "center" },
    ]);
  });

  it("turns paragraph edits off when a selected cell carries no paragraph", async () => {
    const envelope = parseCatEnvelope(JSON.stringify(tableFixture));
    const cell = envelope.segments.filter((s) => s.kind === "cell").at(-1)!;
    // An empty cell's paragraph is not in the read, so nothing inside the cell
    // is addressable; the host paragraph is not a substitute for it.
    envelope.segments = envelope.segments.filter((s) => !(s.indices !== undefined &&
      s.indices.length > cell.indices!.length &&
      cell.indices!.every((index, at) => s.indices![at] === index)));
    const engine = createMockEngine({ envelope });
    engine.render = async () => [pageWithRow(cell)];
    render(<HwpEditor engine={engine} file={file} />);
    await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });
    clickRow();

    expect(await screen.findByText(en["segment.cellSelectionRefused"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["segment.deletePara"] })).toBeNull();
    expect(screen.getByLabelText(en["toolbar.pendingEdits"]({ count: 0 }), { exact: true })).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("starts a paragraph selection over when a run-level selection is toggled or extended", async () => {
    const plain = { bold: false, italic: false, size_pt: 10, color: "#000000", faces: Array(7).fill("A"), face_ids: Array(7).fill(0) };
    const bold = { ...plain, bold: true };
    const envelope: CatEnvelope = { markdown: "xy\n\nxy\n\nz", segments: [
      { id: "P0", indices: [0], start: 0, end: 2, kind: "para", section: 0, para: 0, directChar: bold },
      { id: "r00", indices: [0, 0], start: 0, end: 1, kind: "run", section: 0, para: 0, directChar: plain },
      { id: "r01", indices: [0, 1], start: 1, end: 2, kind: "run", section: 0, para: 0, directChar: bold },
      { id: "P1", indices: [1], start: 4, end: 6, kind: "para", section: 0, para: 1, directChar: plain },
      { id: "r10", indices: [1, 0], start: 4, end: 5, kind: "run", section: 0, para: 1, directChar: plain },
      { id: "r11", indices: [1, 1], start: 5, end: 6, kind: "run", section: 0, para: 1, directChar: bold },
      { id: "P2", indices: [2], start: 8, end: 9, kind: "para", section: 0, para: 2, directChar: plain },
      { id: "r20", indices: [2, 0], start: 8, end: 9, kind: "run", section: 0, para: 2, directChar: plain },
    ] };
    const openSimilar = async (): Promise<Engine> => {
      cleanup();
      const engine = createMockEngine({ envelope });
      render(<HwpEditor engine={engine} file={file} />);
      fireEvent.click((await screen.findAllByRole("option"))[0]!);
      clickBtn("segment.similarChar");
      return engine;
    };

    // Two runs are selected, and the panel names both the obstacle and what a
    // modifier click will do next.
    const toggling = await openSimilar();
    expect(screen.getByText(en["segment.selectedRunCount"]({ count: 2 }))).toBeTruthy();
    expect(screen.getByText(en["segment.runTextEditHint"])).toBeTruthy();
    expect(screen.getByText(en["segment.runSelectionTerminal"])).toBeTruthy();
    // Ctrl-clicking a paragraph starts over at paragraph level: r01 and r11 are
    // gone, and P2's own run is what the format op addresses.
    fireEvent.click(screen.getAllByRole("option")[2]!, { ctrlKey: true });
    expect(await screen.findByText(en["segment.selectedCount"]({ count: 1 }))).toBeTruthy();
    expect(screen.queryByText(en["segment.selectedRunCount"]({ count: 3 }))).toBeNull();
    fireEvent.click(screen.getByLabelText(en["segment.bold"]));
    clickBtn("segment.formatSubmit");
    expect(await applyOps(toggling, 1)).toEqual([
      { kind: "set-format", address: { id: "r20" }, props: { bold: "on" } },
    ]);

    // Shift does the same, so the run list is never ordered against a run it
    // did not contain: P1 and its own two runs, nothing from P0 or P2.
    const extending = await openSimilar();
    fireEvent.click(screen.getAllByRole("option")[1]!, { shiftKey: true });
    expect(await screen.findByText(en["segment.selectedCount"]({ count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(en["segment.bold"]));
    clickBtn("segment.formatSubmit");
    expect(await applyOps(extending, 2)).toEqual([
      { kind: "set-format", address: { id: "r10" }, props: { bold: "on" } },
      { kind: "set-format", address: { id: "r11" }, props: { bold: "on" } },
    ]);
  });

  it("keeps a paragraph selection when a modifier click lands on a table", async () => {
    const markdown = "가나\n";
    const host: Segment = { id: "t-host", indices: [2], start: 0, end: 2, kind: "para", section: 0, para: 2 };
    const table: Segment = { id: "t-table", indices: [2, 0], start: 0, end: 2, kind: "table", section: 0, para: 2 };
    const engine = createMockEngine({ envelope: { markdown, segments: [host, table] } });
    engine.render = async () => [pageWithRow(table, "table")];
    render(<HwpEditor engine={engine} file={file} />);
    const option = (await screen.findAllByRole("option"))[0]!;
    fireEvent.click(option);
    expect(screen.getByText(en["segment.selectedPara"]({ path: "0/2" }))).toBeTruthy();

    // A table carries no paragraph of its own, so a modifier click adds nothing:
    // the paragraph stays selected and the click reports the obstacle instead of
    // making the unusable table ref primary.
    fireEvent.click(screen.getByRole("button", { name: en["page.label"]({ page: 1 }) }), {
      clientX: (200 / 600) * 595,
      clientY: (120 / 800) * 842,
      ctrlKey: true,
    });
    expect(await screen.findByText(en["segment.tableSelectionRefused"])).toBeTruthy();
    expect(screen.getByText(en["segment.selectedCount"]({ count: 1 }))).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: en["segment.deletePara"] }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("lists and numbers paragraphs by path, not by the order the envelope emitted", async () => {
    const envelope: CatEnvelope = { markdown: "ab\n\ncd", segments: [
      { id: "P0", indices: [0], start: 0, end: 2, kind: "para", section: 0, para: 0 },
      { id: "P2", indices: [2], start: 4, end: 6, kind: "para", section: 0, para: 2 },
      // A v2 point paragraph is emitted after the ranges that start at its own
      // offset, so envelope order puts it after P2.
      { id: "P1", indices: [1], start: 4, end: 4, kind: "para", section: 0, para: 1 },
    ] };
    render(<HwpEditor engine={createMockEngine({ envelope })} file={file} />);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      en["segment.choiceLabel"]({ index: 1, text: "ab" }),
      en["segment.choiceLabel"]({ index: 2, text: en["segment.emptyPara"] }),
      en["segment.choiceLabel"]({ index: 3, text: "cd" }),
    ]);
  });

  it("gives a bookmark selection no paragraph target, so Delete never reaches the host text", async () => {
    const base = parseCatEnvelope(JSON.stringify(tableFixture));
    // A bookmark control sits inside a text run: its range is the host
    // paragraph's, which is why resolving it to that paragraph would put the
    // host's text behind a delete.
    const bookmark: Segment = { id: "bmk.1.0", indices: [1, 0], start: 14, end: 28, kind: "bookmark", section: 0, para: 1 };
    const envelope: CatEnvelope = { markdown: base.markdown, segments: [...base.segments, bookmark] };
    const engine = createMockEngine({ envelope });
    // The layout row kind for an image or a field does not exist, so the
    // bookmark path stands in for all three; core/selection.test.ts covers the
    // three kinds themselves.
    engine.render = async () => [pageWithRow(bookmark, "bookmark")];
    render(<HwpEditor engine={engine} file={file} />);
    await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });
    clickRow();

    expect(await screen.findByText(en["segment.containerSelectionRefused"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["segment.deletePara"] })).toBeNull();
    expect(screen.queryByRole("button", { name: en["segment.replaceSubmit"] })).toBeNull();
    expect(screen.queryByText("2026년 8월 정기 회의")).toBeNull();
  });

  it("queues set-format with all three props when all three are set", async () => {
    const engine = await openInspector();
    fireEvent.click(screen.getByLabelText(en["segment.bold"]));
    fireEvent.change(screen.getByLabelText(en["segment.sizeAria"]), {
      target: { value: "14" },
    });
    fireEvent.change(screen.getByLabelText(en["segment.colorAria"]), {
      target: { value: "#FF0000" },
    });
    clickBtn("segment.formatSubmit");

    expect(await applyOps(engine, 1)).toEqual([
      {
        kind: "set-format",
        address: { at: { section: 0, paragraph: 0, run: 0 } },
        props: { bold: "on", size: "14", color: "#FF0000" },
      },
    ]);
  });
});

describe("TableGrid op emission (TEST-03)", () => {
  it("normalizes merge-cells to min/max when the anchor is below the target", async () => {
    const engine = await openTable();
    // Anchor at (1,1), then merge from (0,0): the op must come out
    // normalized regardless of the click order.
    clickCell("김철수");
    clickBtn("table.mergeAnchor");
    clickCell("항목");
    clickBtn("table.mergeWithAnchor");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "merge-cells", table: 0, r1: 0, c1: 0, r2: 1, c2: 1 },
    ]);
  });

  it("queues split-cell with the selected cell's coordinates", async () => {
    const engine = await openTable();
    clickCell("김철수");
    clickBtn("table.splitCell");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "split-cell", table: 0, row: 1, col: 1 },
    ]);
  });

  it("queues add-row without `at` when no cell is selected", async () => {
    const engine = await openTable();
    clickBtn("table.addRow");

    expect(await applyOps(engine, 1)).toEqual([{ kind: "add-row", table: 0 }]);
  });

  it("queues add-row with `at` one below the selected cell's row", async () => {
    const engine = await openTable();
    clickCell("예산");
    clickBtn("table.addRow");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "add-row", table: 0, at: 2 },
    ]);
  });

  it("queues add-col without `at` when no cell is selected", async () => {
    const engine = await openTable();
    clickBtn("table.addCol");

    expect(await applyOps(engine, 1)).toEqual([{ kind: "add-col", table: 0 }]);
  });

  it("queues add-col with `at` one right of the selected cell's column", async () => {
    const engine = await openTable();
    clickCell("담당");
    clickBtn("table.addCol");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "add-col", table: 0, at: 2 },
    ]);
  });

  it("queues delete-row for the selected cell's row", async () => {
    const engine = await openTable();
    clickCell("예산");
    clickBtn("table.deleteRow");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "delete-row", table: 0, row: 1 },
    ]);
  });

  it("queues delete-col for the selected cell's column", async () => {
    const engine = await openTable();
    clickCell("담당");
    clickBtn("table.deleteCol");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "delete-col", table: 0, col: 1 },
    ]);
  });

  it("queues delete-table with the table index as `target`", async () => {
    const engine = await openTable();
    clickBtn("table.deleteTable");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "delete-table", target: 0 },
    ]);
  });
});

describe("panel edge cases (TEST-03)", () => {
  it("emits the exact distinct 0-based coordinates for adjacent cells", async () => {
    const engine = await openTable();
    // (1,0) and (1,1) are adjacent: same row, neighbouring columns.
    clickCell("예산");
    clickBtn("table.splitCell");
    clickCell("김철수");
    clickBtn("table.splitCell");

    expect(await applyOps(engine, 2)).toEqual([
      { kind: "split-cell", table: 0, row: 1, col: 0 },
      { kind: "split-cell", table: 0, row: 1, col: 1 },
    ]);
  });

  it("renders the fields empty state and queues nothing when there are no slots", async () => {
    const engine = createMockEngine({
      envelope: envelopeOf(["# **1. 회의록**", "본문에 자리표시자가 없습니다."]),
    });
    render(<HwpEditor engine={engine} file={file} />);
    await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });

    fireEvent.click(screen.getByRole("tab", { name: en["tabs.fields"] }));
    expect(await screen.findByText(en["fields.hint"])).toBeTruthy();
    // No per-field control exists, so nothing can queue an op.
    expect(
      screen.queryByRole("button", { name: en["fields.setValue"] }),
    ).toBeNull();
    expect(
      screen.getByText(en["toolbar.pendingEdits"]({ count: 0 })),
    ).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("renders the table empty state and queues nothing when the selection has no table", async () => {
    const engine = createMockEngine();
    await selectPara(engine, 0);
    await screen.findByText(HEADING);

    fireEvent.click(screen.getByRole("tab", { name: en["tabs.table"] }));
    expect(await screen.findByText(en["table.hint"])).toBeTruthy();
    for (const key of ["table.setCell", "table.addRow", "table.deleteTable"] as const) {
      expect(screen.queryByRole("button", { name: en[key] })).toBeNull();
    }
    expect(
      screen.getByText(en["toolbar.pendingEdits"]({ count: 0 })),
    ).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("keeps queued ops in click order", async () => {
    const engine = await openInspector();
    clickBtn("segment.alignCenter");
    clickBtn("segment.deletePara");
    fireEvent.change(screen.getByLabelText(en["segment.insertLabel"]), {
      target: { value: "마지막" },
    });
    clickBtn("segment.insertAfter");

    expect(await applyOps(engine, 3)).toEqual([
      { kind: "set-align", address: { at: { section: 0, paragraph: 0 } }, alignment: "center" },
      { kind: "delete-para", address: { at: { section: 0, paragraph: 0 } } },
      { kind: "insert-para", address: { at: { section: 0, paragraph: 0 } }, text: "마지막" },
    ]);
  });
});

/**
 * The components palette (AC8). An insertion's ids exist only in
 * `edit-report-v1`, so the stub answers with one and the assertions read the
 * rows the panel built from it — a position guessed from the request would
 * pass a weaker test and fail against the engine.
 */
describe("ComponentsPanel (TEST-03)", () => {
  const componentName = "결재란";
  const insertedId = "bbbbbbbbbbbbbbbb.0.1";

  /** A v2 envelope: every segment carries the id an address needs. */
  function addressableEnvelope(): CatEnvelope {
    const blocks = ["# **1. 회의록**", "2026년 8월 정기 회의"];
    let markdown = "";
    const segments: CatEnvelope["segments"] = [];
    blocks.forEach((block, para) => {
      const start = markdown.length;
      markdown += `${block}\n\n`;
      segments.push({
        id: `${"a".repeat(16)}.0.${para}`,
        indices: [para],
        start,
        end: start + block.length,
        kind: "para",
        section: 0,
        para,
      });
    });
    return { markdown, segments };
  }

  const insertReport: EditReport = {
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "edited.hwpx",
    dry_run: false,
    ops: [{
      index: 0,
      op: "insert_blocks",
      status: "applied",
      pieces_touched: 1,
      // One paragraph plus its run: the nesting the selection must collapse.
      changed: [{ before: null, after: insertedId }, { before: null, after: `${insertedId}.0` }],
      reason: null,
      missing_style: "create",
    }],
    applied_count: 1,
    failed_count: 0,
  };

  /** Mock engine that honours the report opt-in, at a component-capable version. */
  function composedEngine(envelope: CatEnvelope = addressableEnvelope()): Engine {
    const engine = createMockEngine({ envelope });
    engine.capabilities = async () => ({ version: "1.6.0", editable: true, editOps: "v1", formats: ["hwp", "hwpx"] });
    const baseEdit = engine.edit.bind(engine);
    engine.edit = async (document, ops, options) => ({
      ...(await baseEdit(document, ops, options)),
      ...(options?.report === true ? { report: insertReport } : {}),
    });
    return engine;
  }

  it("substitutes the palette's values and sends the profile styles the component needs", async () => {
    const engine = composedEngine();
    const envelope = await engine.read(file);
    await selectPara(engine, 1, envelope);
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));
    // The palette shows a component's declared defaults; the user changes one.
    fireEvent.change(
      await screen.findByLabelText(en["components.paramLabel"]({ name: componentName, param: "기안자" })),
      { target: { value: "김기안" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: en["components.insert"]({ name: componentName }) }),
    );

    expect(engine.calls.edit).toHaveLength(1);
    const [op] = engine.calls.edit[0]!.ops;
    expect(op).toMatchObject({
      kind: "insert-blocks",
      address: { id: envelope.segments[1]!.id },
      position: "after",
    });
    // The value the user typed reaches the op, and no placeholder survives: a
    // `{{param}}` in a document is the bug this substitution exists to prevent.
    const sent = JSON.stringify(op);
    expect(sent).toContain("김기안");
    expect(sent).not.toContain("{{");
    // The styles travel with the op: the component's own cell style and the
    // profile style it is based on, which the target may not define.
    expect(Object.keys((op as { styles?: Record<string, unknown> }).styles ?? {}).sort())
      .toEqual(["바탕글", "결재란 셀"].sort());
  });

  it("inserts before the paragraph when the palette is set to before", async () => {
    const engine = composedEngine();
    const envelope = await engine.read(file);
    await selectPara(engine, 1, envelope);
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));
    fireEvent.click(await screen.findByRole("button", { name: en["components.positionBefore"] }));
    fireEvent.click(
      await screen.findByRole("button", { name: en["components.insert"]({ name: componentName }) }),
    );
    expect(engine.calls.edit[0]!.ops[0]).toMatchObject({
      kind: "insert-blocks",
      address: { id: envelope.segments[1]!.id },
      position: "before",
    });
  });

  it("names both widths when the engine refuses the insertion as too wide", async () => {
    // The engine answers a block wider than its insertion point with its own
    // diagnostic, in Korean in every locale; the palette replaces it.
    const engine = composedEngine();
    engine.edit = () => Promise.reject(new Error(
        "Error: insert_blocks 블록 정의가 유효하지 않습니다: layout_overflow at " +
          "$.sections[0].blocks[0].width_mm: table width exceeds body width 46.40 mm.",
    ));
    const envelope = await engine.read(file);
    await selectPara(engine, 1, envelope);
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));
    fireEvent.click(
      await screen.findByRole("button", { name: en["components.insert"]({ name: componentName }) }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en["components.tooWide"]({ width: "120 mm", available: "46.4 mm" }));
    // One report, not two: replaceDocument is the only emitter on this path.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("inserts inside a cell instead of beside the table", async () => {
    // A cell resolves to its own paragraphs, so the insertion lands in the
    // cell. The table's host paragraph is a different segment with its own id,
    // and addressing that one would put the component beside the table.
    const host: Segment = { id: "cell-host", indices: [2], start: 0, end: 5, kind: "para", section: 0, para: 2 };
    const table: Segment = { id: "cell-table", indices: [2, 0], start: 0, end: 5, kind: "table", section: 0, para: 2 };
    const cell: Segment = { id: "cell-two", indices: [2, 0, 0], start: 0, end: 5, kind: "cell", section: 0, para: 2 };
    const first: Segment = { id: "cell-two-p0", indices: [2, 0, 0, 0], start: 0, end: 1, kind: "para", section: 0, para: 2 };
    const second: Segment = { id: "cell-two-p1", indices: [2, 0, 0, 1], start: 3, end: 4, kind: "para", section: 0, para: 2 };
    const envelope: CatEnvelope = { markdown: "가\n\n나\n", segments: [host, table, cell, first, second] };
    const engine = composedEngine(envelope);
    engine.render = async () => [pageWithRow(cell)];
    render(<HwpEditor engine={engine} file={file} />);
    await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });
    clickRow();
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));

    // No false "no segment ids" reason: the cell is addressable.
    expect(screen.queryByText(en["components.noAddress"])).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: en["components.insert"]({ name: componentName }) }),
    );
    expect(engine.calls.edit[0]!.ops[0]).toMatchObject({
      kind: "insert-blocks",
      address: { id: "cell-two-p1" },
    });
  });

  it("names a table as the reason the palette cannot insert", async () => {
    const host: Segment = { id: "cell-host", indices: [2], start: 0, end: 1, kind: "para", section: 0, para: 2 };
    const table: Segment = { id: "cell-table", indices: [2, 0], start: 0, end: 1, kind: "table", section: 0, para: 2 };
    const envelope: CatEnvelope = { markdown: "표\n", segments: [host, table] };
    const engine = composedEngine(envelope);
    engine.render = async () => [pageWithRow(table, "table")];
    render(<HwpEditor engine={engine} file={file} />);
    await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });
    clickRow();
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));
    // The reason is the same one a paragraph edit gives for a table, not the
    // id-less-host sentence that used to appear for every nested selection.
    expect(await screen.findByText(en["segment.tableSelectionRefused"])).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: en["components.insert"]({ name: componentName }) }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("queues an addressed move for the selected paragraph", async () => {
    // Reorder acts on the current selection through the paragraph controls, so
    // the ids an insertion reported never have to be remembered to move it.
    const envelope = addressableEnvelope();
    const engine = composedEngine(envelope);
    await selectPara(engine, 1, envelope);
    fireEvent.click(await screen.findByRole("button", { name: en["segment.moveUp"] }));
    const ops = await applyOps(engine, 1);
    expect(ops).toEqual([
      expect.objectContaining({
        kind: "move-para",
        address: { id: envelope.segments[1]!.id },
        to: { address: { id: envelope.segments[0]!.id }, position: "before" },
      }),
    ]);
  });

  it("selects the paragraphs an insertion created", async () => {
    // The ids exist only in the report, so the selection can be built only
    // against the envelope that reads the new document back.
    const base = addressableEnvelope();
    const text = "새문단";
    const insertedPara: Segment = {
      id: insertedId,
      indices: [2],
      start: base.markdown.length,
      end: base.markdown.length + text.length,
      kind: "para",
      section: 0,
      para: 2,
    };
    const after: CatEnvelope = {
      markdown: `${base.markdown}${text}\n\n`,
      segments: [...base.segments, insertedPara],
    };
    const engine = composedEngine();
    let reads = 0;
    engine.read = async () => (reads++ === 0 ? base : after);
    await selectPara(engine, 1, base);
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));
    fireEvent.click(
      await screen.findByRole("button", { name: en["components.insert"]({ name: componentName }) }),
    );

    // The report named one paragraph, so that paragraph is what the editor now
    // shows: the selection moved off the paragraph the op was addressed to, and
    // its path is the engine's, not one guessed from the request.
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.para"] }));
    expect(await screen.findByText(en["segment.selectedPara"]({ path: "0/2" }))).toBeTruthy();
    const panel = screen.getByRole("region", { name: en["segment.panelAria"] });
    expect(panel.querySelector(".hwped-quote")?.textContent).toContain(text);
    expect(panel.querySelector('[aria-selected="true"]')?.textContent).toContain(text);
  });

  it("disables insertion with a localized reason below hwp-cli 1.4.0", async () => {
    const engine = createMockEngine({ envelope: addressableEnvelope() });
    await selectPara(engine, 1, addressableEnvelope());
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));

    expect(
      await screen.findByText(en["components.disabledVersion"]({ version: "1.4.0" })),
    ).toBeTruthy();
    const insert = screen.getByRole("button", { name: en["components.insert"]({ name: componentName }) });
    expect((insert as HTMLButtonElement).disabled).toBe(true);
    expect(engine.calls.edit).toHaveLength(0);
  });
});
