import { isPlainDecimal } from "./unit-input.js";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { CatEnvelope, EditAddress, ParagraphAlignment, ParaShapeKey, Segment } from "@hwp-editor/core";
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
const SHAPE_KEYS: { value: ParaShapeKey; key: MessageKey }[] = [
  { value: "line-spacing", key: "segment.shape.lineSpacing" },
  { value: "indent", key: "segment.shape.indent" },
  { value: "left", key: "segment.shape.left" },
  { value: "right", key: "segment.shape.right" },
  { value: "top", key: "segment.shape.top" },
  { value: "bottom", key: "segment.shape.bottom" },
];

/**
 * Inspector for a selected paragraph segment: current text plus op builders
 * (replace, insert before/after, delete, alignment, minimal char-format).
 * All controls queue EditOps; nothing touches the engine until Apply.
 */
export function SegmentInspector(): JSX.Element {
  const { state, store, envelope, editable, capabilities, t } = useHwpEditorContext();
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
  const [shapeKey, setShapeKey] = useState<ParaShapeKey>("line-spacing");
  const [shapeValue, setShapeValue] = useState("");
  const [lineSpacingUnit, setLineSpacingUnit] = useState<"%" | "pt">("%");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");

  // Reset drafts when the selection moves.
  useEffect(() => {
    setReplaceWith("");
    setInsertText("");
    setBold(false);
    setFontSize("");
    setColor("");
    setShapeValue("");
    setLinkUrl("");
    setLinkText("");
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
  const address = segment.id !== undefined
    ? { id: segment.id }
    : { at: { section: selection.section, paragraph: selection.para } };
  const addressedUnavailable = capabilities?.editOps !== "v1";
  const disabled = !editable || addressedUnavailable || state.status === "applying";
  const anchorDisabled = !editable || state.status === "applying";
  const legacyLinkSeparator = capabilities?.editOps !== "v1" && [currentText, linkText, linkUrl].some(value => value.includes("=>"));
  const validShape = isPlainDecimal(shapeValue) && (shapeKey !== "line-spacing" || Number(shapeValue) > 0);
  const validFontSize = fontSize.trim() === "" || (isPlainDecimal(fontSize) && Number(fontSize) > 0);
  const formatTargets = formatAddresses(envelope!, segment);

  return (
    <div
      className="hwped-panel"
      role="region"
      aria-label={t("segment.panelAria")}
    >
      {addressedUnavailable && <p className="hwped-hint" role="status">{t("segment.addressedUnavailable")}</p>}
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
                op: { kind: "replace", address, find, replace: replaceWith },
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
            disabled={disabled || insertText === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para-before", address, text: insertText },
              })
            }
          >
            {t("segment.insertBefore")}
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || insertText === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para", address, text: insertText },
              })
            }
          >
            {t("segment.insertAfter")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-danger"
            disabled={disabled}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "delete-para", address },
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
              disabled={disabled}
              onClick={() =>
                store.dispatch({
                  type: "queueOp",
                  op: { kind: "set-align", address, alignment: align.value },
                })
              }
            >
              {t(align.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="hwped-field">
        <span className="hwped-label">{t("segment.paraShapeLabel")}</span>
        <div className="hwped-row">
          <select className="hwped-input" value={shapeKey} disabled={disabled} aria-label={t("segment.paraShapeKeyAria")}
            onChange={(e) => setShapeKey(e.target.value as ParaShapeKey)}>
            {SHAPE_KEYS.map(({ value, key }) => <option key={value} value={value}>{t(key)}</option>)}
          </select>
          <input className="hwped-input" type="text" inputMode="decimal" value={shapeValue} disabled={disabled} placeholder={shapeKey === "line-spacing" ? (lineSpacingUnit === "%" ? "%" : "pt") : "mm"}
            aria-label={t("segment.paraShapeValueAria")} onChange={(e) => setShapeValue(e.target.value)} />
          {shapeKey === "line-spacing"
            ? <select className="hwped-input" value={lineSpacingUnit} disabled={disabled} aria-label={t("segment.paraShapeUnitAria")} onChange={(e) => setLineSpacingUnit(e.target.value as "%" | "pt")}>
                <option value="%">{t("segment.unitPercent")}</option><option value="pt">{t("segment.unitPoints")}</option>
              </select>
            : <span className="hwped-label">mm</span>}
          <button type="button" className="hwped-btn" disabled={disabled || !validShape}
            onClick={() => store.dispatch({ type: "queueOp", op: { kind: "set-para", address, key: shapeKey, value: `${shapeValue.trim()}${shapeKey === "line-spacing" ? lineSpacingUnit : "mm"}` } })}>{t("segment.setPara")}</button>
        </div>
      </div>

      {shapeValue !== "" && !validShape && <p role="alert" className="hwped-hint">{t(isPlainDecimal(shapeValue) ? "unit.positive" : "unit.invalid")}</p>}
      <div className="hwped-field">
        <span className="hwped-label">{t("segment.hyperlinkLabel")}</span>
        <p className="hwped-hint">{t("segment.hyperlinkHint")}</p>
        {legacyLinkSeparator && <p role="alert" className="hwped-hint">{t("segment.legacyHyperlinkSeparator")}</p>}
        <input className="hwped-input" type="url" value={linkUrl} disabled={anchorDisabled} placeholder={t("segment.hyperlinkUrlPlaceholder")}
          aria-label={t("segment.hyperlinkUrlAria")} onChange={(e) => setLinkUrl(e.target.value)} />
        <input className="hwped-input" type="text" value={linkText} disabled={anchorDisabled} placeholder={t("segment.hyperlinkTextPlaceholder")}
          aria-label={t("segment.hyperlinkTextAria")} onChange={(e) => setLinkText(e.target.value)} />
        <button type="button" className="hwped-btn" disabled={anchorDisabled || legacyLinkSeparator || currentText === "" || linkUrl.trim() === ""}
          onClick={() => store.dispatch({ type: "queueOp", op: { kind: "create-hyperlink", anchor: currentText, url: linkUrl.trim(), ...(linkText.trim() === "" ? {} : { text: linkText.trim() }) } })}>{t("segment.createHyperlink")}</button>
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
            type="text"
            inputMode="decimal"
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
              disabled || !validFontSize || formatTargets.length === 0 ||
              (!bold && fontSize.trim() === "" && color === "")
            }
            onClick={() => {
              const props: Record<string, string> = {};
              if (bold) props["bold"] = "on";
              if (fontSize.trim() !== "") props["size"] = fontSize.trim();
              if (color !== "") props["color"] = color;
              for (const target of formatTargets) {
                store.dispatch({ type: "queueOp", op: { kind: "set-format", address: target, props } });
              }
            }}
          >
            {t("segment.formatSubmit")}
          </button>
          {!validFontSize && <p role="alert" className="hwped-hint">{t(isPlainDecimal(fontSize) ? "unit.positive" : "unit.invalid")}</p>}
        </div>
      </div>
    </div>
  );
}


/** set_format addresses runs; paragraph operations keep the paragraph id. */
function formatAddresses(envelope: CatEnvelope, segment: Segment): EditAddress[] {
  const runs = envelope.segments.filter((run) => {
    if (run.kind !== "run" || run.section !== segment.section || run.para !== segment.para) return false;
    if (run.start < segment.start || run.end > segment.end) return false;
    if (segment.indices === undefined || run.indices === undefined) return true;
    return run.indices.length === segment.indices.length + 1 &&
      segment.indices.every((index, at) => run.indices![at] === index);
  });
  const at = { section: segment.section, paragraph: segment.para };
  return runs.length > 0
    ? runs.map((run, index) => run.id !== undefined ? { id: run.id } : { at: { ...at, run: index } })
    : segment.indices === undefined ? [{ at: { ...at, run: 0 } }] : [];
}
