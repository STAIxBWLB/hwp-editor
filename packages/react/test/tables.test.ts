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
import type { CatEnvelope } from "@hwp-editor/core";
import { findTables, parseMarkdownTable, tableAtRef, tableRows } from "../src/tables.js";

/** An envelope holding one table block as its only segment. */
function envelopeWithTable(block: string): CatEnvelope {
  return {
    markdown: `${block}\n\n`,
    segments: [{ start: 0, end: block.length, kind: "para", section: 0, para: 0 }],
  };
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
    expect(table?.rows[2]).toEqual(["예산"]);
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
    expect(twoColumn?.rows[1]?.[0]).toBe("x | y");
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
