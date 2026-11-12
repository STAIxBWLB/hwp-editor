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
  const { state, store, envelope, editable, capabilities, t } = useHwpEditorContext();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [anchor, setAnchor] = useState("");
  const [name, setName] = useState("");
  const [initialValue, setInitialValue] = useState("");
  const [bookmarkAnchor, setBookmarkAnchor] = useState("");
  const [bookmarkName, setBookmarkName] = useState("");
  const [deleteFieldName, setDeleteFieldName] = useState("");
  const [deleteBookmarkName, setDeleteBookmarkName] = useState("");

  const slots = useMemo(
    () => (envelope === null ? [] : extractFieldSlots(envelope)),
    [envelope],
  );

  const legacy = capabilities?.editOps !== "v1";
  const badFieldSeparator = legacy && (anchor.includes("=>") || name.includes("=>") || name.includes("="));
  // The bookmark name is the tail of a single split, so only the anchor can
  // carry the separator into the wrong field (#58 item 10).
  const badBookmarkAnchor = legacy && bookmarkAnchor.includes("=>");
  const disabled = !editable || state.document === null || envelope === null || state.status === "applying";

  return (
    <div
      className="hwped-panel"
      role="region"
      aria-label={t("fields.panelAria")}
    >
      {legacy && <p className="hwped-hint">{t("fields.legacySeparatorHint")}</p>}
      {slots.length === 0 ? <p className="hwped-hint">{t("fields.hint")}</p> : <ul className="hwped-fields">
        {slots.map((slot) => {
          const segment = envelope === null ? undefined : segmentAtRef(envelope, slot.segment);
          const snippet =
            envelope === null || segment === undefined
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
                  disabled={!editable || state.status === "applying"}
                  placeholder={t("fields.valuePlaceholder")}
                  aria-label={t("fields.fieldValueAria", { name: slot.name })}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [slot.name]: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="hwped-btn"
                  disabled={!editable || state.status === "applying" || draft === "" || (legacy && slot.name.includes("="))}
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
      </ul>}
      <div className="hwped-field">
        <span className="hwped-label">{t("fields.createField")}</span>
        <input className="hwped-input" value={anchor} disabled={disabled} placeholder={t("fields.anchorPlaceholder")} aria-label={t("fields.anchorAria")} onChange={(e) => setAnchor(e.target.value)} />
        <input className="hwped-input" value={name} disabled={disabled} placeholder={t("fields.namePlaceholder")} aria-label={t("fields.nameAria")} onChange={(e) => setName(e.target.value)} />
        <input className="hwped-input" value={initialValue} disabled={disabled} placeholder={t("fields.valuePlaceholder")} aria-label={t("fields.initialValueAria")} onChange={(e) => setInitialValue(e.target.value)} />
        <button type="button" className="hwped-btn" disabled={disabled || badFieldSeparator || anchor.trim() === "" || name.trim() === ""} onClick={() => store.dispatch({ type: "queueOp", op: { kind: "create-field", anchor: anchor.trim(), name: name.trim(), ...(initialValue === "" ? {} : { value: initialValue }) } })}>{t("fields.createFieldSubmit")}</button>
      </div>
      <div className="hwped-field">
        <p id="hwped-delete-field-hint" className="hwped-hint">{t("fields.deleteAllHint")}</p>
        <input aria-describedby="hwped-delete-field-hint" className="hwped-input" value={deleteFieldName} disabled={disabled} placeholder={t("fields.namePlaceholder")} aria-label={t("fields.deleteFieldNameAria")} onChange={(e) => setDeleteFieldName(e.target.value)} />
        <button type="button" className="hwped-btn hwped-btn-danger" disabled={disabled || deleteFieldName.trim() === ""} onClick={() => store.dispatch({ type: "queueOp", op: { kind: "delete-field", name: deleteFieldName.trim() } })}>{t("fields.deleteField")}</button>
      </div>
      <div className="hwped-field">
        <input className="hwped-input" value={bookmarkAnchor} disabled={disabled} placeholder={t("fields.anchorPlaceholder")} aria-label={t("fields.bookmarkAnchorAria")} onChange={(e) => setBookmarkAnchor(e.target.value)} />
        <input className="hwped-input" value={bookmarkName} disabled={disabled} placeholder={t("fields.bookmarkNamePlaceholder")} aria-label={t("fields.bookmarkNameAria")} onChange={(e) => setBookmarkName(e.target.value)} />
        <button type="button" className="hwped-btn" disabled={disabled || badBookmarkAnchor || bookmarkAnchor.trim() === "" || bookmarkName.trim() === ""} onClick={() => store.dispatch({ type: "queueOp", op: { kind: "create-bookmark", anchor: bookmarkAnchor.trim(), name: bookmarkName.trim() } })}>{t("fields.createBookmark")}</button>
        <p id="hwped-delete-bookmark-hint" className="hwped-hint">{t("fields.deleteAllBookmarksHint")}</p>
        <input aria-describedby="hwped-delete-bookmark-hint" className="hwped-input" value={deleteBookmarkName} disabled={disabled} placeholder={t("fields.bookmarkNamePlaceholder")} aria-label={t("fields.deleteBookmarkNameAria")} onChange={(e) => setDeleteBookmarkName(e.target.value)} />
        <button type="button" className="hwped-btn hwped-btn-danger" disabled={disabled || deleteBookmarkName.trim() === ""} onClick={() => store.dispatch({ type: "queueOp", op: { kind: "delete-bookmark", name: deleteBookmarkName.trim() } })}>{t("fields.deleteBookmark")}</button>
      </div>
    </div>
  );
}
