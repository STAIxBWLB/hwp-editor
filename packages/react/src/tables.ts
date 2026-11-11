/**
 * GFM table extraction from the `hwp cat --with-segments` envelope.
 *
 * The CLI emits one para segment per table, covering the whole markdown
 * table block. Table indices are 0-based in document order, matching the
 * `hwp edit --set-cell "table:row:col=value"` coordinate grammar; within a
 * table, row 0 is the header row and the `---` separator row is skipped.
 *
 * The row and column numbers this module produces are the ones every table op
 * addresses, so the grid the panel shows and the coordinate it queues come
 * from this one parse.
 */

import type { CatEnvelope, Segment, SegmentRef } from "@hwp-editor/core";
import { segmentText } from "@hwp-editor/core";

export interface TableModel {
  /** 0-based table index in document order (the CLI's `table` coordinate). */
  tableIndex: number;
  /** Segment covering the table block. */
  segment: Segment;
  /**
   * Cell grid. Row 0 is the header row; the markdown separator row is not
   * included. Merged cells cannot be represented in markdown, so spans are
   * flattened to their anchor cell text.
   */
  rows: string[][];
}

/** GFM's delimiter cell: two or more hyphens, with optional alignment colons. */
const GFM_DELIMITER_CELL = /^:?-{2,}:?$/;

/** Whether the row's final `|` delimits the row rather than being a `\|`. */
function endsWithCellDelimiter(row: string): boolean {
  if (!row.endsWith("|")) return false;
  let backslashes = 0;
  for (let i = row.length - 2; i >= 0 && row[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * One GFM row's cells.
 *
 * An unescaped `|` separates cells and `\|` is a pipe inside one, which is how
 * the engine escapes a cell holding the character (#58 item 13b). The optional
 * outer pipe delimits the row, so the empty piece it leaves on either end is
 * dropped rather than becoming a cell - and a trailing `\|` is a cell's last
 * character, not the row's outer pipe.
 */
export function splitTableRow(row: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === "\\" && row[i + 1] === "|") { current += "|"; i += 1; continue; }
    if (char === "|") { pieces.push(current); current = ""; continue; }
    current += char;
  }
  pieces.push(current);
  const trimmed = row.trim();
  if (pieces.length > 1 && trimmed.startsWith("|")) pieces.shift();
  if (pieces.length > 1 && endsWithCellDelimiter(trimmed)) pieces.pop();
  return pieces.map((cell) => cell.trim());
}

/** A parsed block: its rows, and whether it carried a GFM delimiter row. */
export interface TableBlock {
  rows: string[][];
  /** Whether a GFM delimiter row appeared at all; what makes a slice a table. */
  sawDelimiter: boolean;
}

/**
 * The rows of a GFM table block, or of a tab-separated legacy one.
 *
 * A GFM delimiter row is the row directly under the header and carries one
 * cell per column, so `---` is data wherever else it appears: a one-column
 * table whose cell reads `---` keeps its row, and only a second row matching
 * the header's cell count is dropped (#58 item 13b). Dropping every matching
 * line shifted every row index after it, and those indices are what the delete
 * and add ops address.
 *
 * Legacy tab-separated input keeps its cells as written and never has a
 * delimiter row, so the rule is applied to GFM rows only: a tab row reading
 * `---\t---` is data.
 */
export function tableRows(text: string): TableBlock {
  const rows: string[][] = [];
  let sawDelimiter = false;
  let header: string[] | undefined;
  // GFM puts the delimiter exactly once, under the header. Counting the lines
  // rather than the kept rows is what lets a second `---` stay data: a
  // one-column table whose cell reads `---` cannot be told from the delimiter
  // by its text, only by where it sits.
  let lines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    // A legacy tab-separated row keeps its cells as written; only GFM rows
    // trim, because there the padding is the delimiter's whitespace.
    const legacy = line.includes("\t");
    const cells = legacy ? line.split("\t") : splitTableRow(line);
    const position = lines;
    lines += 1;
    header ??= cells;
    if (!legacy && cells.every((cell) => GFM_DELIMITER_CELL.test(cell))) {
      sawDelimiter = true;
      if (position === 1 && cells.length === header.length) continue;
    }
    rows.push(cells);
  }
  return { rows, sawDelimiter };
}

/** True when a segment's markdown slice is a GFM table block. */
export function isTableSlice(slice: string): boolean {
  return parseMarkdownTable(slice) !== null;
}

/** Parse a GFM table slice into a cell grid; null when not a table. */
export function parseMarkdownTable(slice: string): string[][] | null {
  const lines = slice
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (lines.length < 2) return null;
  const { rows, sawDelimiter } = tableRows(lines.join("\n"));
  return sawDelimiter && rows.length > 0 ? rows : null;
}

/** All tables in the envelope, in document order. */
export function findTables(envelope: CatEnvelope): TableModel[] {
  const tables: TableModel[] = [];
  for (const segment of envelope.segments) {
    const rows = parseMarkdownTable(segmentText(envelope, segment));
    if (rows !== null) {
      tables.push({ tableIndex: tables.length, segment, rows });
    }
  }
  return tables;
}

/** The table whose segment sits at the given source coordinate, if any. */
export function tableAtRef(
  envelope: CatEnvelope,
  ref: SegmentRef,
): TableModel | undefined {
  return findTables(envelope).find(
    (table) =>
      table.segment.section === ref.section && table.segment.para === ref.para,
  );
}
