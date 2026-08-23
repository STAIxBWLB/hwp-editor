/**
 * GFM table extraction from the `hwp cat --with-segments` envelope.
 *
 * The CLI emits one para segment per table, covering the whole markdown
 * table block. Table indices are 0-based in document order, matching the
 * `hwp edit --set-cell "table:row:col=value"` coordinate grammar; within a
 * table, row 0 is the header row and the `---` separator row is skipped.
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
  const rows: string[][] = [];
  let sawSeparator = false;
  for (const line of lines) {
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      sawSeparator = true;
      continue;
    }
    rows.push(cells);
  }
  return sawSeparator && rows.length > 0 ? rows : null;
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
