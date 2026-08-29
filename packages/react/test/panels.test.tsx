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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CatEnvelope, DocumentHandle, EditOp } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en } from "../src/messages.js";
import { clientYForPara, createMockEngine, makeEnvelope } from "./mock-engine.js";

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

describe("SegmentInspector op emission (TEST-03)", () => {
  it("queues insert-para-before with the selection anchor and typed text", async () => {
    const engine = await openInspector();
    fireEvent.change(screen.getByLabelText(en["segment.insertLabel"]), {
      target: { value: "머리말" },
    });
    clickBtn("segment.insertBefore");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "insert-para-before", anchor: HEADING, text: "머리말" },
    ]);
  });

  it("queues insert-para with the selection anchor and typed text", async () => {
    const engine = await openInspector();
    fireEvent.change(screen.getByLabelText(en["segment.insertLabel"]), {
      target: { value: "꼬리말" },
    });
    clickBtn("segment.insertAfter");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "insert-para", anchor: HEADING, text: "꼬리말" },
    ]);
  });

  it("queues delete-para carrying the selected paragraph's text", async () => {
    const engine = await openInspector();
    clickBtn("segment.deletePara");

    expect(await applyOps(engine, 1)).toEqual([
      { kind: "delete-para", text: HEADING },
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
        { kind: "set-align", find: HEADING, alignment },
      ]);
    },
  );

  it("queues set-format with ONLY the props that were set", async () => {
    const engine = await openInspector();
    fireEvent.change(screen.getByLabelText(en["segment.sizeAria"]), {
      target: { value: "12" },
    });
    clickBtn("segment.formatSubmit");

    // bold and color were never touched: their keys must be absent, not
    // present-and-empty — the conditional spread is the contract.
    expect(await applyOps(engine, 1)).toEqual([
      { kind: "set-format", find: HEADING, props: { size: "12" } },
    ]);
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
        find: HEADING,
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
      { kind: "set-align", find: HEADING, alignment: "center" },
      { kind: "delete-para", text: HEADING },
      { kind: "insert-para", anchor: HEADING, text: "마지막" },
    ]);
  });
});
