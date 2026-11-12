/**
 * Table extraction from the `hwp cat --with-segments` envelope.
 *
 * The CLI emits one `table` segment per table control, covering the whole
 * markdown that table projects to: a GFM pipe table, or the HTML `<table>` a
 * merged cell or a block-content cell forces. A table's index is its position
 * among the `table` segments, which is the order hwp-cli's own nth-table walk
 * (`walk_nth_table_root`) assigns - with one gap: that walk also counts a table
 * inside a footnote, a header, a footer or a hidden comment, and the envelope
 * publishes no segment for any of those. One such table shifts every later
 * published index onto another table, so the panel must not trust the count on
 * its own. The engine's own count arrives as `bodyTables`, and the table panel
 * refuses index-addressed ops when the two disagree (#97 item 1). Table indices
 * are 0-based in document order, matching the `hwp edit --set-cell
 * "table:row:col=value"` coordinate grammar; within a table, row 0 is the
 * header row and the `---` separator row is skipped.
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
   * included.
   *
   * `null` when the engine projected this table as HTML instead (a merged cell,
   * or a cell holding block content). Such a table has no grid to draw here but
   * still occupies its index slot, because the engine counts it too (#95).
   */
  rows: string[][] | null;
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

/**
 * Every table in the envelope, in document order, numbered as the engine
 * numbers them.
 *
 * The index comes from the segment's kind, never from whether a grid could be
 * parsed: the engine's nth-table walk counts a merged-cell table and a plain
 * one alike, and a panel that skipped the HTML one put every later table one
 * slot early - set-cell, delete-row, delete-table and clone then reached a
 * different table than the reader picked (#95).
 */
export function findTables(envelope: CatEnvelope): TableModel[] {
  const tables: TableModel[] = [];
  for (const segment of envelope.segments) {
    if (segment.kind !== "table") continue;
    tables.push({
      tableIndex: tables.length,
      segment,
      rows: parseMarkdownTable(segmentText(envelope, segment)),
    });
  }
  return tables;
}

/**
 * Whether this segment is a table's own paragraph: the paragraph a reader
 * selects when they click the table itself.
 *
 * Such a paragraph and its `table` segment start at the same offset, because
 * the table is that paragraph's whole content. A paragraph inside a cell (or in
 * a cell of a nested table) answers the same `{section, para}` yet starts
 * later, inside the table's span, so selecting text in a cell keeps the
 * paragraph tab. Deciding by the published segment is what keeps a paragraph
 * that merely mentions `<table>` out of the table tab (#97 item 2c).
 */
export function hostsTable(envelope: CatEnvelope, segment: Segment): boolean {
  if (segment.kind === "table") return true;
  // Only a top-level paragraph can be a table's own paragraph. A cell, a
  // paragraph inside one and a run all answer the same `{section, para}`, and a
  // cell can even start where the table does, so the nesting path - published
  // as `indices`, whose length 1 means "top-level paragraph" - is what rules
  // them out.
  if (segment.kind !== "para") return false;
  if (segment.indices !== undefined && segment.indices.length > 1) return false;
  return envelope.segments.some(
    (candidate) =>
      candidate.kind === "table" &&
      candidate.section === segment.section &&
      candidate.para === segment.para &&
      candidate.start === segment.start,
  );
}

/**
 * The table a source coordinate names, if any.
 *
 * The segment id is the precise answer, and it is what a selection carries: the
 * engine numbers a table's host paragraph by the top-level paragraph, so two
 * tables under one paragraph (a table nested in a cell, a text-box table) answer
 * the same `{section, para}` (#97 item 2d). The coordinate is the fallback for a
 * ref without an id, and even then a paragraph holding several tables resolves
 * to the innermost one whose span encloses the ref's own segment, so the grid
 * the panel shows and the coordinate it queues still name the same table.
 */
export function tableAtRef(
  envelope: CatEnvelope,
  ref: SegmentRef,
): TableModel | undefined {
  const tables = findTables(envelope);
  if (ref.id !== undefined) {
    const byId = tables.find((table) => table.segment.id === ref.id);
    if (byId !== undefined) return byId;
  }
  const candidates = tables.filter(
    (table) =>
      table.segment.section === ref.section && table.segment.para === ref.para,
  );
  if (candidates.length <= 1) return candidates[0];
  const own =
    ref.id === undefined
      ? undefined
      : envelope.segments.find((segment) => segment.id === ref.id);
  if (own === undefined) return candidates[0];
  // A table nested in a cell starts after its host's segment, so the greatest
  // start among the enclosing spans is the closest one.
  const enclosing = candidates
    .filter(
      (table) =>
        table.segment.start <= own.start && own.end <= table.segment.end,
    )
    .sort((a, b) => b.segment.start - a.segment.start);
  return enclosing[0] ?? candidates[0];
}
