/**
 * The components palette: fill a component's values and insert it beside the
 * selected paragraph.
 *
 * The panel holds no document state and no list of what it inserted. An
 * inserted paragraph's id exists only in the engine's edit report and
 * describes the document as it was written, so a list kept here would carry
 * the ids of shifted slots after the first move or removal, and two insertions
 * of one component would collide. The editor selects what the report named
 * instead, and reorder and removal act on that selection through the paragraph
 * panel's addressed controls.
 *
 * Substitution happens in the editor before the op is built, from the values
 * rendered here, so a `{{param}}` never reaches the engine.
 *
 * `disabledReason` is a localized sentence rather than a version number: the
 * editor knows why the palette cannot act (an old engine, a host without the
 * typed-ops channel, a selection that is a table) and the panel only renders it.
 */
import { useState } from "react";
import type { JSX } from "react";
import type { Component } from "@hwp-editor/core";
import { EDIT_REPORT_MIN_VERSION, editReportSupported, STARTER_COMPONENTS } from "@hwp-editor/core";
import { useHwpEditorContext } from "./context.js";

/** Where a component goes relative to the selected paragraph. */
export type InsertPosition = "before" | "after";

export interface ComponentsPanelProps {
  /** Catalogue to offer; the shipped starters by default. */
  components?: readonly Component[];
  /** Localized reason the palette cannot insert; empty when it can. */
  disabledReason?: string;
  /**
   * Localized reason the "before" position is unavailable for this selection;
   * empty when it is. Only before is refused — a section's definition
   * paragraph takes no insertion ahead of it — so the palette stays usable.
   */
  beforeDisabledReason?: string;
  /** True while an engine call owns the document. */
  busy?: boolean;
  onInsert?: (component: Component, values: Record<string, string>, position: InsertPosition) => void;
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
  disabledReason = "",
  beforeDisabledReason = "",
  busy = false,
  onInsert,
}: ComponentsPanelProps): JSX.Element {
  const { t } = useHwpEditorContext();
  const disabled = busy || disabledReason !== "";
  /**
   * Values per component name. A param the user has not touched keeps the
   * component's own default, which is what the input shows and what the
   * substitution falls back to.
   */
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [position, setPosition] = useState<InsertPosition>("after");

  const valueOf = (component: Component, param: string): string =>
    values[component.name]?.[param] ?? component.params[param] ?? "";

  const edit = (component: Component, param: string, value: string): void => {
    setValues((previous) => ({
      ...previous,
      [component.name]: { ...previous[component.name], [param]: value },
    }));
  };

  /** Every declared param at its rendered value, so the op carries what is shown. */
  const filled = (component: Component): Record<string, string> =>
    Object.fromEntries(
      Object.keys(component.params).map((param) => [param, valueOf(component, param)]),
    );

  /**
   * Why this position is unavailable for the current selection, or "". The
   * engine refuses an insertion before a section's definition paragraph, which
   * the editor can see coming; that closes one edge only, so the palette stays
   * usable from the other rather than reporting the whole panel as blocked.
   */
  const positionRefused = (direction: InsertPosition): string =>
    direction === "before" ? beforeDisabledReason : "";

  return (
    <div className="hwped-panel hwped-components" role="region" aria-label={t("components.panelAria")}>
      <p className="hwped-hint">{t("components.hint")}</p>
      {disabledReason !== "" && <p className="hwped-hint" role="status">{disabledReason}</p>}
      <div className="hwped-field">
        <span className="hwped-label">{t("components.positionLabel")}</span>
        <div className="hwped-row" role="group" aria-label={t("components.positionAria")}>
          {(["before", "after"] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              className={"hwped-btn" + (position === direction ? " hwped-preset-active" : "")}
              aria-pressed={position === direction}
              disabled={disabled || positionRefused(direction) !== ""}
              onClick={() => setPosition(direction)}
            >
              {t(direction === "before" ? "components.positionBefore" : "components.positionAfter")}
            </button>
          ))}
        </div>
        {beforeDisabledReason !== "" && (
          <p className="hwped-hint" role="status">{beforeDisabledReason}</p>
        )}
      </div>
      <ul className="hwped-component-list" aria-label={t("components.catalogueAria")}>
        {components.map((component) => {
          const params = Object.entries(component.params);
          return (
            <li key={component.name} className="hwped-component-item">
              <div>
                <strong>{component.name}</strong>
                <p className="hwped-hint">{component.description}</p>
              </div>
              {params.length > 0 && (
                <div
                  className="hwped-fields"
                  role="group"
                  aria-label={t("components.paramAria", { name: component.name })}
                >
                  {params.map(([param]) => (
                    <label key={param} className="hwped-label">
                      {param}
                      <input
                        className="hwped-input"
                        type="text"
                        aria-label={t("components.paramLabel", { name: component.name, param })}
                        disabled={disabled}
                        value={valueOf(component, param)}
                        onChange={(event) => edit(component, param, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="hwped-btn"
                disabled={disabled || onInsert === undefined || positionRefused(position) !== ""}
                aria-label={t("components.insert", { name: component.name })}
                onClick={() => onInsert?.(component, filled(component), position)}
              >
                {t("components.insert", { name: component.name })}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
