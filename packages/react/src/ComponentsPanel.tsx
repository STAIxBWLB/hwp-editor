/**
 * The components palette: insert a component beside the selected paragraph,
 * then reorder or remove what the insertion reported.
 *
 * The palette holds no document state of its own. Insertion goes through
 * `onInsert`, which the editor runs as one engine call with `report: true` and
 * answers with the ids the report named — the engine assigns them against the
 * document it just wrote, so they cannot be predicted here. Reorder and remove
 * arrive back as the current rows, addressed by those ids.
 *
 * `disabledReason` is a localized sentence rather than a version number: the
 * editor knows why the palette cannot act (an old engine, a host without the
 * typed-ops channel, no selected paragraph) and the panel only renders it.
 */
import type { JSX } from "react";
import type { Component } from "@hwp-editor/core";
import { EDIT_REPORT_MIN_VERSION, editReportSupported, STARTER_COMPONENTS } from "@hwp-editor/core";
import { useHwpEditorContext } from "./context.js";

/** One inserted component, keyed by the paragraph id its insertion created. */
export interface InsertedComponent {
  id: string;
  /** The component it came from, for the row's own label. */
  name: string;
}

export interface ComponentsPanelProps {
  /** Catalogue to offer; the shipped starters by default. */
  components?: readonly Component[];
  /** Rows the editor holds for this document, oldest first. */
  inserted?: readonly InsertedComponent[];
  /** Localized reason the palette cannot insert; empty when it can. */
  disabledReason?: string;
  /** True while an engine call owns the document. */
  busy?: boolean;
  onInsert?: (component: Component) => void;
  onMove?: (id: string, direction: -1 | 1) => void;
  onRemove?: (id: string) => void;
}

/** Why this engine cannot insert components, or "" when it can. */
export function componentsSupportReason(
  capabilities: { version: string; editOps?: "v1" } | null,
  t: ReturnType<typeof useHwpEditorContext>["t"],
): string {
  if (capabilities === null) return "";
  if (capabilities.editOps !== "v1") return t("components.disabledChannel");
  if (!editReportSupported(capabilities.version)) {
    return t("components.disabledVersion", { version: EDIT_REPORT_MIN_VERSION });
  }
  return "";
}

export function ComponentsPanel({
  components = STARTER_COMPONENTS,
  inserted = [],
  disabledReason = "",
  busy = false,
  onInsert,
  onMove,
  onRemove,
}: ComponentsPanelProps): JSX.Element {
  const { t } = useHwpEditorContext();
  const disabled = busy || disabledReason !== "";
  return (
    <div className="hwped-panel hwped-components" aria-label={t("components.panelAria")}>
      <p className="hwped-hint">{t("components.hint")}</p>
      {disabledReason !== "" && <p className="hwped-hint" role="status">{disabledReason}</p>}
      <ul className="hwped-component-list" aria-label={t("components.catalogueAria")}>
        {components.map((component) => (
          <li key={component.name} className="hwped-component-item">
            <div>
              <strong>{component.name}</strong>
              <p className="hwped-hint">{component.description}</p>
            </div>
            <button
              type="button"
              className="hwped-btn"
              disabled={disabled || onInsert === undefined}
              aria-label={t("components.insert", { name: component.name })}
              onClick={() => onInsert?.(component)}
            >
              {t("components.insert", { name: component.name })}
            </button>
          </li>
        ))}
      </ul>
      <h3 className="hwped-label">{t("components.insertedTitle")}</h3>
      {inserted.length === 0 ? (
        <p className="hwped-hint">{t("components.insertedEmpty")}</p>
      ) : (
        <ol className="hwped-inserted-list">
          {inserted.map((row, index) => (
            <li key={row.id} className="hwped-component-item">
              <span>{row.name}</span>
              <div>
                <button
                  type="button"
                  className="hwped-btn"
                  disabled={disabled || index === 0 || onMove === undefined}
                  aria-label={t("components.moveUp", { name: row.name })}
                  onClick={() => onMove?.(row.id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="hwped-btn"
                  disabled={disabled || index === inserted.length - 1 || onMove === undefined}
                  aria-label={t("components.moveDown", { name: row.name })}
                  onClick={() => onMove?.(row.id, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="hwped-btn"
                  disabled={disabled || onRemove === undefined}
                  aria-label={t("components.remove", { name: row.name })}
                  onClick={() => onRemove?.(row.id)}
                >
                  {t("components.remove", { name: row.name })}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
