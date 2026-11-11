import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { CloneTableMode } from "@hwp-editor/core";
import { tableAtRef } from "./tables.js";
import { plainSegmentText } from "./text.js";
import { useHwpEditorContext } from "./context.js";

interface CellCoord {
  row: number;
  col: number;
}

/** GFM's delimiter cell: `---` with optional alignment colons. */
const GFM_DELIMITER_CELL = /^:?-{3,}:?$/;

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
 * dropped rather than becoming a cell.
 */
function splitCells(row: string): string[] {
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

/**
 * The rows of a GFM table, or of a tab-separated legacy one.
 *
 * A GFM delimiter row is the row directly under the header and carries one
 * cell per column, so `---` is data wherever else it appears: a one-column
 * table whose cell reads `---` keeps its row, and only a second row matching
 * the header's cell count is dropped (#58 item 13b). Dropping every matching
 * line shifted every row index after it, and those indices are what the delete
 * and add ops address.
 */
export function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  // GFM puts the delimiter exactly once, under the header. Counting the lines
  // rather than the kept rows is what lets a second `---` stay data: a
  // one-column table whose cell reads `---` cannot be told from the delimiter
  // by its text, only by where it sits.
  let lines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const cells = line.includes("\t")
      // A legacy tab-separated row keeps its cells as written; only GFM rows
      // trim, because there the padding is the delimiter's whitespace.
      ? line.split("\t")
      : splitCells(line);
    const second = lines === 1;
    lines += 1;
    const header = rows[0];
    if (
      second && header !== undefined && cells.length === header.length &&
      cells.every((cell) => GFM_DELIMITER_CELL.test(cell))
    ) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * Table-aware editor for a selected table segment. The cell grid comes from
 * the GFM table in the read() envelope; addressing follows the CLI's
 * 0-based "table:row:col" grammar (row 0 = header row).
 */
export function TableGrid(): JSX.Element {
  const { state, store, envelope, editable, capabilities, t } = useHwpEditorContext();
  const { selection } = state;

  const table =
    envelope !== null && selection !== null
      ? tableAtRef(envelope, selection)
      : undefined;

  const [cell, setCell] = useState<CellCoord | null>(null);
  const [mergeAnchor, setMergeAnchor] = useState<CellCoord | null>(null);
  const [cellValue, setCellValue] = useState("");
  const [tableAnchor, setTableAnchor] = useState("");
  const [newRows, setNewRows] = useState("");
  const [cloneAnchor, setCloneAnchor] = useState("");
  const [cloneMode, setCloneMode] = useState<CloneTableMode>("keep");

  useEffect(() => {
    setCell(null);
    setMergeAnchor(null);
    setCellValue("");
  }, [selection]);

  const legacy = capabilities?.editOps !== "v1";
  const disabled = !editable || state.document === null || envelope === null || state.status === "applying";
  const queue = store.dispatch.bind(store);
  const rows = tableRows(newRows);
  const addTablePanel = (
    <div className="hwped-field">
      {legacy && <p className="hwped-hint">{t("table.legacySeparatorHint")}</p>}
      <label className="hwped-label" htmlFor="hwped-table-anchor">{t("table.anchorAria")}</label>
      <input id="hwped-table-anchor" className="hwped-input" value={tableAnchor} disabled={disabled} placeholder={t("table.anchorPlaceholder")} onChange={(e) => setTableAnchor(e.target.value)} />
      <label className="hwped-label" htmlFor="hwped-table-rows">{t("table.addTableRowsLabel")}</label>
      <textarea id="hwped-table-rows" className="hwped-textarea" rows={3} value={newRows} disabled={disabled} placeholder={t("table.addTableRowPlaceholder")} onChange={(e) => setNewRows(e.target.value)} />
      <button type="button" className="hwped-btn" disabled={disabled || (legacy && tableAnchor.includes("=>")) || tableAnchor.trim() === "" || rows.length === 0}
        onClick={() => queue({ type: "queueOp", op: { kind: "add-table", anchor: tableAnchor.trim(), rows } })}>{t("table.addTable")}</button>
    </div>
  );

  if (table === undefined) {
    return (
      <div className="hwped-panel" role="region" aria-label={t("table.panelAria")}>
        <p className="hwped-hint">{t("table.hint")}</p>
        {addTablePanel}
      </div>
    );
  }

  const tableIndex = table.tableIndex;
  // The panel numbers the table the reader is looking at, so it counts from
  // one like every other label in this editor, and the queued row for a table
  // states the same ordinal so the two surfaces can be matched. The ops below
  // keep the engine's own index, which is what the engine reports refusals
  // against.
  const tableNumber = tableIndex + 1;

  return (
    <div className="hwped-panel" role="region" aria-label={t("table.panelAria")}>
      <div className="hwped-field">
        <span className="hwped-label">
          {t("table.tableLabel", { index: tableNumber })}
        </span>
        <table className="hwped-grid">
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((text, colIndex) => {
                  const active =
                    cell !== null &&
                    cell.row === rowIndex &&
                    cell.col === colIndex;
                  const anchor =
                    mergeAnchor !== null &&
                    mergeAnchor.row === rowIndex &&
                    mergeAnchor.col === colIndex;
                  return (
                    <td key={colIndex}>
                      <button
                        type="button"
                        className={
                          "hwped-cell" +
                          (active ? " hwped-cell-selected" : "") +
                          (anchor ? " hwped-cell-anchor" : "")
                        }
                        onClick={() => {
                          setCell({ row: rowIndex, col: colIndex });
                          setCellValue(plainSegmentText(text));
                        }}
                      >
                        {plainSegmentText(text) || " "}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cell !== null && (
        <div className="hwped-field">
          <label className="hwped-label" htmlFor="hwped-cell">
            {t("table.cellLabel", { row: cell.row, col: cell.col })}
          </label>
          <div className="hwped-row">
            <input
              id="hwped-cell"
              className="hwped-input"
              type="text"
              value={cellValue}
              disabled={disabled}
              onChange={(e) => setCellValue(e.target.value)}
            />
            <button
              type="button"
              className="hwped-btn"
              disabled={disabled}
              onClick={() =>
                queue({
                  type: "queueOp",
                  op: {
                    kind: "set-cell",
                    table: tableIndex,
                    row: cell.row,
                    col: cell.col,
                    value: cellValue,
                  },
                })
              }
            >
              {t("table.setCell")}
            </button>
          </div>
          <div className="hwped-row">
            <button
              type="button"
              className="hwped-btn"
              disabled={disabled}
              onClick={() => setMergeAnchor({ ...cell })}
            >
              {t("table.mergeAnchor")}
            </button>
            <button
              type="button"
              className="hwped-btn"
              disabled={
                disabled ||
                mergeAnchor === null ||
                (mergeAnchor.row === cell.row && mergeAnchor.col === cell.col)
              }
              onClick={() => {
                if (mergeAnchor === null) return;
                queue({
                  type: "queueOp",
                  op: {
                    kind: "merge-cells",
                    table: tableIndex,
                    r1: Math.min(mergeAnchor.row, cell.row),
                    c1: Math.min(mergeAnchor.col, cell.col),
                    r2: Math.max(mergeAnchor.row, cell.row),
                    c2: Math.max(mergeAnchor.col, cell.col),
                  },
                });
                setMergeAnchor(null);
              }}
            >
              {t("table.mergeWithAnchor")}
            </button>
            <button
              type="button"
              className="hwped-btn"
              disabled={disabled}
              onClick={() =>
                queue({
                  type: "queueOp",
                  op: {
                    kind: "split-cell",
                    table: tableIndex,
                    row: cell.row,
                    col: cell.col,
                  },
                })
              }
            >
              {t("table.splitCell")}
            </button>
          </div>
        </div>
      )}

      <div className="hwped-field">
        <span className="hwped-label">{t("table.rowsCols")}</span>
        <div className="hwped-row">
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled}
            onClick={() =>
              queue({
                type: "queueOp",
                op:
                  cell === null
                    ? { kind: "add-row", table: tableIndex }
                    : { kind: "add-row", table: tableIndex, at: cell.row + 1 },
              })
            }
          >
            {t("table.addRow")}
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled}
            onClick={() =>
              queue({
                type: "queueOp",
                op:
                  cell === null
                    ? { kind: "add-col", table: tableIndex }
                    : { kind: "add-col", table: tableIndex, at: cell.col + 1 },
              })
            }
          >
            {t("table.addCol")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-danger"
            disabled={disabled || cell === null}
            onClick={() => {
              if (cell === null) return;
              queue({
                type: "queueOp",
                op: { kind: "delete-row", table: tableIndex, row: cell.row },
              });
            }}
          >
            {t("table.deleteRow")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-danger"
            disabled={disabled || cell === null}
            onClick={() => {
              if (cell === null) return;
              queue({
                type: "queueOp",
                op: { kind: "delete-col", table: tableIndex, col: cell.col },
              });
            }}
          >
            {t("table.deleteCol")}
          </button>
        </div>
      </div>

      <div className="hwped-field">
        <button
          type="button"
          className="hwped-btn hwped-btn-danger"
          disabled={disabled}
          onClick={() =>
            queue({
              type: "queueOp",
              op: { kind: "delete-table", target: tableIndex },
            })
          }
        >
          {t("table.deleteTable")}
        </button>
      </div>
      {addTablePanel}
      <div className="hwped-field">
        <span className="hwped-label">{t("table.sourceTable", { index: tableNumber })}</span>
        <label className="hwped-label" htmlFor="hwped-clone-anchor">{t("table.cloneAnchorAria")}</label>
        <input id="hwped-clone-anchor" className="hwped-input" value={cloneAnchor} disabled={disabled} placeholder={t("table.anchorPlaceholder")} onChange={(e) => setCloneAnchor(e.target.value)} />
        <label className="hwped-label" htmlFor="hwped-clone-mode">{t("table.cloneModeAria")}</label>
        <select id="hwped-clone-mode" className="hwped-input" value={cloneMode} disabled={disabled} onChange={(e) => setCloneMode(e.target.value as CloneTableMode)}>
          <option value="keep">{t("table.cloneKeep")}</option><option value="blank">{t("table.cloneBlank")}</option>
        </select>
        <button type="button" className="hwped-btn" disabled={disabled || (legacy && cloneAnchor.includes("=>")) || cloneAnchor.trim() === ""}
          onClick={() => queue({ type: "queueOp", op: { kind: "clone-table", sourceTable: tableIndex, anchor: cloneAnchor.trim(), mode: cloneMode } })}>{t("table.cloneTable")}</button>
      </div>
    </div>
  );
}
