import { useEffect, useState } from "react";
import type { JSX } from "react";
import { tableAtRef } from "./tables.js";
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
  const { state, store, envelope, editable, t } = useHwpEditorContext();
  const { selection } = state;

  const table =
    envelope !== null && selection !== null
      ? tableAtRef(envelope, selection)
      : undefined;

  const [cell, setCell] = useState<CellCoord | null>(null);
  const [mergeAnchor, setMergeAnchor] = useState<CellCoord | null>(null);
  const [cellValue, setCellValue] = useState("");

  useEffect(() => {
    setCell(null);
    setMergeAnchor(null);
    setCellValue("");
  }, [selection]);

  if (table === undefined) {
    return (
      <div
        className="hwped-panel"
        role="region"
        aria-label={t("table.panelAria")}
      >
        <p className="hwped-hint">{t("table.hint")}</p>
      </div>
    );
  }

  const disabled = !editable;
  const tableIndex = table.tableIndex;
  const queue = store.dispatch.bind(store);

  return (
    <div className="hwped-panel" role="region" aria-label={t("table.panelAria")}>
      <div className="hwped-field">
        <span className="hwped-label">
          {t("table.tableLabel", { index: tableIndex })}
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
    </div>
  );
}
