/**
 * The table grid's rows, from the GFM projection (#58 item 13b).
 *
 * Every row and column number a table op addresses comes from the parse these
 * cases pin: `parseMarkdownTable` feeds `tableAtRef`, which is what the grid
 * shows and what set-cell, merge, split, add-row, delete-row and delete-col
 * are numbered by. A GFM delimiter row is the row directly under the header,
 * one cell per column; everywhere else `---` is data. A `\|` is a pipe inside
 * a cell, not a cell boundary.
 */
import { describe, expect, it } from "vitest";
import type { CatEnvelope, Segment } from "@hwp-editor/core";
import { findTables, parseMarkdownTable, tableAtRef, tableRows } from "../src/tables.js";

/** An envelope holding one table block as its only segment. */
function envelopeWithTable(block: string): CatEnvelope {
  return {
    markdown: `${block}\n\n`,
    segments: [{ start: 0, end: block.length, kind: "table", section: 0, para: 0 }],
  };
}

/** An envelope holding one segment per block, of the kind the block projects to. */
function envelopeOf(blocks: { kind: Segment["kind"]; text: string }[]): CatEnvelope {
  let markdown = "";
  const segments: CatEnvelope["segments"] = [];
  blocks.forEach((block, para) => {
    const start = markdown.length;
    markdown += `${block.text}\n\n`;
    segments.push({ start, end: start + block.text.length, kind: block.kind, section: 0, para });
  });
  return { markdown, segments };
}

describe("table rows from the GFM projection (#58 item 13b)", () => {
  it("keeps a bare --- row in a one-column table", () => {
    // The header, the table's own `| --- |` separator, then a cell that reads
    // `---`. Row 1 is the first data row, so the grid must show it there.
    const block = "| 항목 |\n| --- |\n| --- |\n| 예산 |";
    expect(parseMarkdownTable(block)).toEqual([["항목"], ["---"], ["예산"]]);
    // The grid the panel draws, and the row a click addresses: dropping the
    // `---` row would make 예산 row 1 and send delete-row or set-cell to the
    // wrong row.
    const table = tableAtRef(envelopeWithTable(block), { section: 0, para: 0 });
    expect(table?.rows).toEqual([["항목"], ["---"], ["예산"]]);
    expect(table?.rows?.[2]).toEqual(["예산"]);
    // The same table without an outer pipe on the data line is one cell too,
    // and it is the row the old pattern dropped.
    expect(tableRows("| 항목 |\n| --- |\n---").rows).toEqual([["항목"], ["---"]]);
  });

  it("drops the delimiter row, and only where GFM puts it", () => {
    // The second row is the separator: dropped, so row 0 stays the header and
    // row 1 is the first data row.
    expect(parseMarkdownTable("| a | b |\n| --- | :---: |\n| 1 | 2 |")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    // A `---` row further down is data, not a second separator.
    expect(parseMarkdownTable("| a | b |\n| --- | --- |\n| 1 | 2 |\n| --- | --- |")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["---", "---"],
    ]);
    // A second row whose cell count disagrees with the header cannot be the
    // delimiter, so it stays - and the slice is still a table.
    expect(parseMarkdownTable("| a | b |\n| --- |")).toEqual([["a", "b"], ["---"]]);
    expect(findTables(envelopeWithTable("| a | b |\n| --- |"))).toHaveLength(1);
  });

  it("keeps an escaped pipe inside its cell", () => {
    expect(parseMarkdownTable("| a |\n| --- |\n| x \\| y |")).toEqual([["a"], ["x | y"]]);
    // Two cells, one of which holds the escaped character: the grid must see
    // one cell at column 0, not two cells with a stray backslash.
    const twoColumn = tableAtRef(
      envelopeWithTable("| a | b |\n| --- | --- |\n| x \\| y | z |"),
      { section: 0, para: 0 },
    );
    expect(twoColumn?.rows).toEqual([["a", "b"], ["x | y", "z"]]);
    expect(twoColumn?.rows?.[1]?.[0]).toBe("x | y");
    // Without the escape the same line is two cells.
    expect(parseMarkdownTable("| a | b |\n| --- | --- |\n| x | y |")).toEqual([["a", "b"], ["x", "y"]]);
    // A trailing escaped pipe is part of the cell, not the row's outer pipe.
    expect(parseMarkdownTable("| a |\n| --- |\n| x \\|")).toEqual([["a"], ["x |"]]);
  });

  it("keeps a legacy tab row as written, delimiter-looking cells included", () => {
    // The add-table input accepts tab-separated rows too, and those are cells
    // as written: `---\t---` is a two-cell row, never the separator.
    expect(tableRows("a\tb\n---\t---\n1\t2").rows).toEqual([
      ["a", "b"],
      ["---", "---"],
      ["1", "2"],
    ]);
  });
});

describe("table index matches the engine's count (#95)", () => {
  // A merged cell makes the engine project the table as HTML, and that table
  // is still the engine's table 0: measured with ahwp 1.6.1 on this shape,
  // `hwp edit --set-cell 1:1:0=...` reaches the second, plain table.
  const htmlTable =
    '<table>\n<tr><td colspan="2">병합 셀</td></tr>\n<tr><td>가</td><td>나</td></tr>\n</table>';
  const gfmTable = "| 이름 | 수량 |\n| --- | --- |\n| 연필 | 3 |";

  it("gives the GFM table after an HTML table the engine's index 1", () => {
    const envelope = envelopeOf([
      { kind: "para", text: "# 표 두 개" },
      { kind: "table", text: htmlTable },
      { kind: "table", text: gfmTable },
    ]);
    const tables = findTables(envelope);
    expect(tables).toHaveLength(2);
    // The HTML table has no grid to draw, and dropping it from the count is
    // what put every later table one slot early: set-cell, delete-row,
    // delete-table and clone reached the merged-cell table instead of the one
    // the reader picked.
    expect(tables[0]?.rows).toBeNull();
    expect(tables[1]?.tableIndex).toBe(1);
    expect(tables[1]?.rows).toEqual([["이름", "수량"], ["연필", "3"]]);
    // The ordinal the panel prints is one more than the engine's index.
    expect(tables[1]!.tableIndex + 1).toBe(2);
    // Addressing goes through the same entry, so a click in the plain table
    // queues table 1.
    expect(tableAtRef(envelope, { section: 0, para: 2 })?.tableIndex).toBe(1);
    expect(tableAtRef(envelope, { section: 0, para: 1 })?.rows).toBeNull();
  });

  it("counts an HTML table as a slot even when it is the only table", () => {
    // Otherwise the panel reports "not a table" for a document that has one,
    // and the next table it does show takes index 0 by accident.
    const only = envelopeOf([{ kind: "table", text: htmlTable }]);
    expect(findTables(only).map((table) => [table.tableIndex, table.rows])).toEqual([[0, null]]);
    expect(tableAtRef(only, { section: 0, para: 0 })?.tableIndex).toBe(0);
  });

  it("keeps a GFM-only document's indices as they were", () => {
    const envelope = envelopeOf([
      { kind: "table", text: gfmTable },
      { kind: "para", text: "사이 문단" },
      { kind: "table", text: "| a |\n| --- |\n| 1 |" },
    ]);
    expect(findTables(envelope).map((table) => table.tableIndex)).toEqual([0, 1]);
  });
});
