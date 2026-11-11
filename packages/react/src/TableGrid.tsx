import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { CloneTableMode } from "@hwp-editor/core";
import { tableAtRef, tableRows } from "./tables.js";
import { plainSegmentText } from "./text.js";
import { useHwpEditorContext } from "./context.js";

interface CellCoord {
  row: number;
  col: number;
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
  const rows = tableRows(newRows).rows;
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
