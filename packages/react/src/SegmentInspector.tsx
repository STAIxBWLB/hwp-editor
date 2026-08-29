import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { ParagraphAlignment } from "@hwp-editor/core";
import { segmentAtRef, segmentText } from "@hwp-editor/core";
import { plainSegmentText } from "./text.js";
import { useHwpEditorContext } from "./context.js";
import type { MessageKey } from "./messages.js";

/**
 * Alignment buttons. The array stays at module scope but now carries message
 * KEYS instead of label literals, so the labels resolve through `t()` at
 * render time without reallocating the array on every render.
 */
const ALIGNMENTS: { value: ParagraphAlignment; key: MessageKey }[] = [
  { value: "left", key: "segment.alignLeft" },
  { value: "center", key: "segment.alignCenter" },
  { value: "right", key: "segment.alignRight" },
  { value: "justify", key: "segment.alignJustify" },
];

/**
 * Inspector for a selected paragraph segment: current text plus op builders
 * (replace, insert before/after, delete, alignment, minimal char-format).
 * All controls queue EditOps; nothing touches the engine until Apply.
 */
export function SegmentInspector(): JSX.Element {
  const { state, store, envelope, editable, t } = useHwpEditorContext();
  const { selection } = state;

  const segment =
    envelope !== null && selection !== null
      ? segmentAtRef(envelope, selection)
      : undefined;
  const currentText =
    envelope !== null && segment !== undefined
      ? plainSegmentText(segmentText(envelope, segment))
      : "";

  const [replaceWith, setReplaceWith] = useState("");
  const [insertText, setInsertText] = useState("");
  const [bold, setBold] = useState(false);
  const [fontSize, setFontSize] = useState("");
  const [color, setColor] = useState("");

  // Reset drafts when the selection moves.
  useEffect(() => {
    setReplaceWith("");
    setInsertText("");
    setBold(false);
    setFontSize("");
    setColor("");
  }, [selection]);

  if (segment === undefined || selection === null) {
    return (
      <div
        className="hwped-panel"
        role="region"
        aria-label={t("segment.panelAria")}
      >
        <p className="hwped-hint">{t("segment.hint")}</p>
      </div>
    );
  }

  const find = currentText;
  const disabled = !editable;

  return (
    <div
      className="hwped-panel"
      role="region"
      aria-label={t("segment.panelAria")}
    >
      <div className="hwped-field">
        <span className="hwped-label">
          {t("segment.selectedPara", {
            section: selection.section,
            para: selection.para,
          })}
        </span>
        <div className="hwped-quote">
          {currentText || t("segment.emptyPara")}
        </div>
      </div>

      <div className="hwped-field">
        <label className="hwped-label" htmlFor="hwped-replace">
          {t("segment.replaceLabel")}
        </label>
        <div className="hwped-row">
          <input
            id="hwped-replace"
            className="hwped-input"
            type="text"
            value={replaceWith}
            disabled={disabled}
            onChange={(e) => setReplaceWith(e.target.value)}
            placeholder={t("segment.replacePlaceholder")}
          />
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || replaceWith === "" || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "replace", find, replace: replaceWith },
              })
            }
          >
            {t("segment.replaceSubmit")}
          </button>
        </div>
      </div>

      <div className="hwped-field">
        <label className="hwped-label" htmlFor="hwped-insert">
          {t("segment.insertLabel")}
        </label>
        <textarea
          id="hwped-insert"
          className="hwped-textarea"
          value={insertText}
          disabled={disabled}
          onChange={(e) => setInsertText(e.target.value)}
          placeholder={t("segment.insertPlaceholder")}
          rows={2}
        />
        <div className="hwped-row">
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || insertText === "" || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para-before", anchor: find, text: insertText },
              })
            }
          >
            {t("segment.insertBefore")}
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || insertText === "" || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para", anchor: find, text: insertText },
              })
            }
          >
            {t("segment.insertAfter")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-danger"
            disabled={disabled || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "delete-para", text: find },
              })
            }
          >
            {t("segment.deletePara")}
          </button>
        </div>
      </div>

      <div className="hwped-field">
        <span className="hwped-label">{t("segment.alignLabel")}</span>
        <div
          className="hwped-row"
          role="group"
          aria-label={t("segment.alignGroupAria")}
        >
          {ALIGNMENTS.map((align) => (
            <button
              key={align.value}
              type="button"
              className="hwped-btn"
              disabled={disabled || find === ""}
              onClick={() =>
                store.dispatch({
                  type: "queueOp",
                  op: { kind: "set-align", find, alignment: align.value },
                })
              }
            >
              {t(align.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="hwped-field">
        <span className="hwped-label">{t("segment.formatLabel")}</span>
        <div className="hwped-row">
          <label className="hwped-check">
            <input
              type="checkbox"
              checked={bold}
              disabled={disabled}
              onChange={(e) => setBold(e.target.checked)}
            />
            {t("segment.bold")}
          </label>
          <input
            className="hwped-input hwped-input-narrow"
            type="number"
            min={1}
            value={fontSize}
            disabled={disabled}
            onChange={(e) => setFontSize(e.target.value)}
            placeholder={t("segment.sizePlaceholder")}
            aria-label={t("segment.sizeAria")}
          />
          <input
            className="hwped-input hwped-input-narrow"
            type="text"
            value={color}
            disabled={disabled}
            onChange={(e) => setColor(e.target.value)}
            // A sample hex value, not chrome: never a message key (I18N-05).
            placeholder="#FF0000"
            aria-label={t("segment.colorAria")}
          />
          <button
            type="button"
            className="hwped-btn"
            disabled={
              disabled ||
              find === "" ||
              (!bold && fontSize === "" && color === "")
            }
            onClick={() => {
              const props: Record<string, string> = {};
              if (bold) props["bold"] = "on";
              if (fontSize !== "") props["size"] = fontSize;
              if (color !== "") props["color"] = color;
              store.dispatch({
                type: "queueOp",
                op: { kind: "set-format", find, props },
              });
            }}
          >
            {t("segment.formatSubmit")}
          </button>
        </div>
      </div>
    </div>
  );
}
