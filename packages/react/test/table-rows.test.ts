/**
 * The table grid's rows, from the GFM projection (#58 item 13b).
 *
 * A GFM delimiter row is the row directly under the header, one cell per
 * column. Everywhere else `---` is data: a one-column table whose cell reads
 * `---` used to lose that row, and every row index after it moved, which is
 * what the delete-row and add-row ops address. A `\|` is a pipe inside a cell,
 * not a cell boundary.
 */
import { describe, expect, it } from "vitest";
import { tableRows } from "../src/TableGrid.js";

describe("table rows from the GFM projection (#58 item 13b)", () => {
  it("keeps a bare --- row in a one-column table", () => {
    // The header, the table's own `| --- |` separator, then a cell that reads
    // `---`. Row 1 is the first data row, so the grid must show it there.
    expect(tableRows("| 항목 |\n| --- |\n| --- |\n| 예산 |")).toEqual([
      ["항목"],
      ["---"],
      ["예산"],
    ]);
    // The same table without an outer pipe on the data line is one cell too,
    // and it is the row the old pattern dropped.
    expect(tableRows("| 항목 |\n| --- |\n---")).toEqual([["항목"], ["---"]]);
  });

  it("drops the delimiter row, and only where GFM puts it", () => {
    // The second row is the separator: dropped, so row 0 stays the header and
    // row 1 is the first data row.
    expect(tableRows("| a | b |\n| --- | :---: |\n| 1 | 2 |")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    // A `---` row further down is data, not a second separator.
    expect(tableRows("| a | b |\n| --- | --- |\n| 1 | 2 |\n| --- | --- |")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["---", "---"],
    ]);
    // A second row whose cell count disagrees with the header cannot be the
    // delimiter, so it stays.
    expect(tableRows("| a | b |\n| --- |")).toEqual([["a", "b"], ["---"]]);
  });

  it("keeps an escaped pipe inside its cell", () => {
    expect(tableRows("| a |\n| --- |\n| x \\| y |")).toEqual([["a"], ["x | y"]]);
    // Two cells, one of which holds the escaped character.
    expect(tableRows("| a | b |\n| --- | --- |\n| x \\| y | z |")).toEqual([
      ["a", "b"],
      ["x | y", "z"],
    ]);
    // Without the escape the same line is two cells.
    expect(tableRows("| a | b |\n| --- | --- |\n| x | y |")).toEqual([["a", "b"], ["x", "y"]]);
    // A trailing escaped pipe is part of the cell, not the row's outer pipe.
    expect(tableRows("| a |\n| --- |\n| x \\|")).toEqual([["a"], ["x |"]]);
  });
});
