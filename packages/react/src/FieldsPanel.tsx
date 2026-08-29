import { useMemo, useState } from "react";
import type { JSX } from "react";
import { segmentAtRef, segmentText } from "@hwp-editor/core";
import { extractFieldSlots } from "./fields.js";
import { useHwpEditorContext } from "./context.js";

/**
 * Lists `{{field}}` placeholder slots found in the read() envelope, with
 * set-field editing and jump-to-segment on click. (The engine contract has
 * no native field/bookmark listing; see fields.ts.)
 */
export function FieldsPanel(): JSX.Element {
  const { store, envelope, editable, t } = useHwpEditorContext();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const slots = useMemo(
    () => (envelope === null ? [] : extractFieldSlots(envelope)),
    [envelope],
  );

  if (envelope === null || slots.length === 0) {
    return (
      <div
        className="hwped-panel"
        role="region"
        aria-label={t("fields.panelAria")}
      >
        {/* The `{{name}}` / `{{이름}}` template marker lives inside the
            message value: it is per-locale copy, not a runtime param. */}
        <p className="hwped-hint">{t("fields.hint")}</p>
      </div>
    );
  }

  return (
    <div
      className="hwped-panel"
      role="region"
      aria-label={t("fields.panelAria")}
    >
      <ul className="hwped-fields">
        {slots.map((slot) => {
          const segment = segmentAtRef(envelope, slot.segment);
          const snippet =
            segment === undefined
              ? ""
              : segmentText(envelope, segment).trim().slice(0, 40);
          const draft = drafts[slot.name] ?? "";
          return (
            <li key={slot.name} className="hwped-field-item">
              <div className="hwped-row">
                <button
                  type="button"
                  className="hwped-btn hwped-btn-link"
                  title={snippet}
                  onClick={() =>
                    store.dispatch({ type: "select", selection: slot.segment })
                  }
                >
                  {slot.name}
                </button>
              </div>
              <div className="hwped-row">
                <input
                  className="hwped-input"
                  type="text"
                  value={draft}
                  disabled={!editable}
                  placeholder={t("fields.valuePlaceholder")}
                  aria-label={t("fields.fieldValueAria", { name: slot.name })}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [slot.name]: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="hwped-btn"
                  disabled={!editable || draft === ""}
                  onClick={() =>
                    store.dispatch({
                      type: "queueOp",
                      op: { kind: "set-field", name: slot.name, value: draft },
                    })
                  }
                >
                  {t("fields.setValue")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
