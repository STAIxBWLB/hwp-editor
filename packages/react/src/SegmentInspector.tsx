import { isPlainDecimal } from "./unit-input.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { JSX } from "react";
import type { ParagraphAlignment, ParaShapeKey, SelectionRefusal, Segment } from "@hwp-editor/core";
import { compareSegments, formatAddresses, paragraphAddress, paragraphRuns, resolveSelection, segmentAtRef, segmentPath, segmentRef, segmentText, selectSimilar, selectedParagraphs, selectionAction } from "@hwp-editor/core";
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

  const paragraphKeys = new Set<string>();
  // Path order, not envelope order: a v2 point paragraph is emitted after the
  // ranges that start at its own offset.
  const paragraphs = (envelope?.segments.filter(candidate => {
    if (candidate.kind !== "para") return false;
    const key = candidate.id ?? `${candidate.section}:${candidate.para}`;
    if (paragraphKeys.has(key)) return false;
    paragraphKeys.add(key);
    return true;
  }) ?? []).sort(compareSegments);
  const selected = envelope === null ? [] : selectedParagraphs(envelope, state);
  const segment =
    envelope !== null && selection !== null
      ? segmentAtRef(envelope, selection)
      : undefined;
  // What the selection actually covers: a cell resolves to every paragraph in
  // it, and a table, image, field or bookmark to none of them.
  const targets = envelope !== null && segment !== undefined ? resolveSelection(envelope, segment) : undefined;
  const paragraphTargets = targets?.paragraphs ?? [];
  const singleParagraph = targets?.paragraph;
  // One table of reasons serves both the current selection and a refused
  // click, so a segment kind names its own obstacle either way.
  const refusalText = (reason: SelectionRefusal | null | undefined): string | null =>
    reason === null || reason === undefined ? null
      : reason === "cell" ? t("segment.cellSelectionRefused")
      : reason === "table" ? t("segment.tableSelectionRefused")
      : reason === "container" ? t("segment.containerSelectionRefused")
      : t("segment.noParagraphSelection");
  const refusalReason = refusalText(targets?.refusal);
  const targetLabel = segment === undefined ? "" : segment.kind === "cell"
    ? t("segment.selectedCell", { path: segmentPath(segment), count: paragraphTargets.length })
    : singleParagraph === undefined ? "" : t("segment.selectedPara", { path: segmentPath(singleParagraph) });
  const currentText =
    envelope !== null && paragraphTargets.length > 0
      ? plainSegmentText(paragraphTargets.map(candidate => segmentText(envelope, candidate)).join("\n"))
      : "";

  const markdownText = envelope !== null && singleParagraph !== undefined ? segmentText(envelope, singleParagraph) : "";
  const supplementaryStarts = useMemo(() => {
    const positions: number[] = [];
    let offset = 0;
    for (const point of markdownText) {
      if (point.length === 2) positions.push(offset);
      offset += point.length;
    }
    return positions;
  }, [markdownText]);
  const rangeInput = useRef<HTMLTextAreaElement>(null);
  const [rangeInvalid, setRangeInvalid] = useState(false);
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
    setRangeInvalid(false);
    setReplaceWith("");
    setInsertText("");
    setBold(false);
    setFontSize("");
    setColor("");
    setShapeValue("");
    setLinkUrl("");
    setLinkText("");
  }, [selection]);

  const find = currentText;
  const address = singleParagraph === undefined ? undefined : paragraphAddress(singleParagraph);
  /**
   * The paragraph's own siblings: same section, same parent path, one nesting
   * level deep. A move swaps with one of them, so a component inserted into a
   * cell is reordered among that cell's paragraphs rather than out of the cell.
   */
  const siblings = singleParagraph?.indices === undefined
    ? []
    : paragraphs.filter(candidate =>
        candidate.section === singleParagraph.section &&
        candidate.id !== undefined &&
        candidate.indices !== undefined &&
        candidate.indices.length === singleParagraph.indices!.length &&
        singleParagraph.indices!.slice(0, -1).every((index, at) => candidate.indices![at] === index));
  const siblingAt = siblings.findIndex(candidate => candidate.id === singleParagraph?.id);
  const addressedUnavailable = capabilities?.editOps !== "v1";
  const disabled = !editable || addressedUnavailable || state.status === "applying";
  const selectedRefs = state.selections?.length ? state.selections : selection === null ? [] : [selection];
  const explicitSegments = envelope === null ? [] : selectedRefs.flatMap(ref => {
    const item = segmentAtRef(envelope, ref);
    return item === undefined ? [] : [item];
  });
  const hasRunSelection = explicitSegments.some(item => item.kind === "run");
  // One selection is one entry in the list, even when it is a cell that covers
  // several paragraphs.
  const multiSelection = explicitSegments.length > 1;
  const textSelectionRestricted = multiSelection || hasRunSelection || state.range != null;
  const singleTargetDisabled = disabled || textSelectionRestricted || address === undefined;
  const anchorDisabled = !editable || state.status === "applying" || textSelectionRestricted;
  const legacyLinkSeparator = capabilities?.editOps !== "v1" && [currentText, linkText, linkUrl].some(value => value.includes("=>"));
  const validShape = isPlainDecimal(shapeValue) && (shapeKey !== "line-spacing" || Number(shapeValue) > 0);
  const validFontSize = fontSize.trim() === "" || (isPlainDecimal(fontSize) && Number(fontSize) > 0);
  // The state keeps the primary first; the ops read in document order.
  const formatInputs = envelope === null ? [] : explicitSegments.flatMap(item =>
    item.kind === "run" ? [item] : resolveSelection(envelope, item).paragraphs).sort(compareSegments);
  const formatTargets = envelope === null ? [] : formatAddresses(envelope, formatInputs, state.range);
  const runs = envelope === null || singleParagraph === undefined ? [] : paragraphRuns(envelope, singleParagraph);
  const rangeAvailable = !multiSelection && runs.some(run => run.id !== undefined || (singleParagraph?.indices?.length === 1 && run.indices?.length === 2));
  const charPrimary = segment?.kind === "run" ? segment
    : envelope !== null && state.range != null && formatTargets[0]?.id !== undefined
      ? segmentAtRef(envelope, { id: formatTargets[0].id, section: 0, para: 0 }) ?? singleParagraph
      : singleParagraph;

  const activateSelection = (target: Segment, mode: "single" | "toggle" | "extend"): void => {
    if (envelope === null) return;
    store.dispatch(selectionAction(envelope, store.getState(), target, mode));
  };
  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, target: Segment): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activateSelection(target, event.shiftKey ? "extend" : event.ctrlKey || event.metaKey ? "toggle" : "single");
  };
  const selectLikePrimary = (level: "char" | "para"): void => {
    if (envelope === null || singleParagraph === undefined) return;
    const match = level === "char" ? charPrimary : singleParagraph;
    if (match === undefined) return;
    const refs = selectSimilar(envelope, match, level);
    if (refs.length === 0) return;
    const activeMatch = refs.find(ref => {
      const item = segmentAtRef(envelope, ref);
      const parent = item === undefined ? undefined : resolveSelection(envelope, item).paragraph;
      return parent === singleParagraph || (parent?.id !== undefined && parent.id === singleParagraph.id) ||
        (parent !== undefined && parent.id === undefined && singleParagraph.id === undefined && parent.section === singleParagraph.section && parent.para === singleParagraph.para);
    });
    const primary = activeMatch ?? refs[0]!;
    store.dispatch({
      type: "selectMany",
      selections: refs,
      primary,
      ...(state.selectionAnchor === null || state.selectionAnchor === undefined
        ? { anchor: primary }
        : { anchor: state.selectionAnchor }),
    });
  };

  return (
    <div
      className="hwped-panel"
      role="region"
      aria-label={t("segment.panelAria")}
    >
      <div className="hwped-field">
        <span className="hwped-label">{t("segment.paragraphChoices")}</span>
        <div
          role="listbox"
          aria-label={t("segment.paragraphChoices")}
          aria-multiselectable="true"
          style={{ maxHeight: "12rem", overflowY: "auto" }}
        >
          {paragraphs.map((candidate, index) => {
            const isSelected = selected.some((item) => item === candidate ||
              (item.id !== undefined && item.id === candidate.id) ||
              (item.id === undefined && candidate.id === undefined && item.section === candidate.section && item.para === candidate.para));
            const snippet = plainSegmentText(segmentText(envelope!, candidate)).trim().replace(/\s+/g, " ");
            const text = snippet.length > 96 ? `${snippet.slice(0, 93)}...` : snippet || t("segment.emptyPara");
            const label = t("segment.choiceLabel", { index: index + 1, text });
            return (
              <button
                key={candidate.id ?? `${candidate.section}:${candidate.para}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                className="hwped-btn"
                onClick={(event) => activateSelection(candidate, event.shiftKey ? "extend" : event.ctrlKey || event.metaKey ? "toggle" : "single")}
                onKeyDown={(event) => handleOptionKeyDown(event, candidate)}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="hwped-hint" role="status">{
          // A run-level selection has to count runs: those are the refs the
          // state holds and the targets the format op will address.
          hasRunSelection
            ? t("segment.selectedRunCount", { count: explicitSegments.length })
            : t("segment.selectedCount", { count: selected.length })
        }</p>
        {// A run-level selection formats runs, and a modifier click from it
         // starts a paragraph selection over instead of joining the runs.
        hasRunSelection && <p className="hwped-hint" role="status">{t("segment.runSelectionTerminal")}</p>}
        {// A modifier click that had no paragraph to add left the selection
         // alone; say why, unless the selection itself is what was clicked and
         // its own reason is already below.
        state.selectionRefusal != null && state.selectionRefusal !== targets?.refusal &&
          <p className="hwped-hint" role="status">{refusalText(state.selectionRefusal)}</p>}
      </div>
      {segment === undefined || selection === null ? (
        <p className="hwped-hint">{t("segment.hint")}</p>
      ) : paragraphTargets.length === 0 ? (
        <p className="hwped-hint" role="status">{refusalReason}</p>
      ) : <>
      {addressedUnavailable && <p className="hwped-hint" role="status">{t("segment.addressedUnavailable")}</p>}
      {textSelectionRestricted && <p className="hwped-hint" role="status">{
        // Name the cause that is actually holding the controls off: a range
        // waits for the whole paragraph, a run-level selection for a paragraph
        // at all, and several paragraphs for just one.
        state.range != null ? t("segment.rangeTextEditHint")
          : hasRunSelection ? t("segment.runTextEditHint")
          : t("segment.multiTextEditHint")
      }</p>}
      {refusalReason !== null && <p className="hwped-hint" role="status">{refusalReason}</p>}
      <div className="hwped-field">
        <span className="hwped-label">{targetLabel}</span>
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
            disabled={singleTargetDisabled}
            onChange={(e) => setReplaceWith(e.target.value)}
            placeholder={t("segment.replacePlaceholder")}
          />
          <button
            type="button"
            className="hwped-btn"
            disabled={singleTargetDisabled || replaceWith === "" || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "replace", address: address!, find, replace: replaceWith },
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
          disabled={singleTargetDisabled}
          onChange={(e) => setInsertText(e.target.value)}
          placeholder={t("segment.insertPlaceholder")}
          rows={2}
        />
        <div className="hwped-row">
          <button
            type="button"
            className="hwped-btn"
            disabled={singleTargetDisabled || insertText === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para-before", address: address!, text: insertText },
              })
            }
          >
            {t("segment.insertBefore")}
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={singleTargetDisabled || insertText === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para", address: address!, text: insertText },
              })
            }
          >
            {t("segment.insertAfter")}
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={singleTargetDisabled || siblingAt <= 0}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: {
                  kind: "move-para",
                  address: address!,
                  to: { address: paragraphAddress(siblings[siblingAt - 1]!), position: "before" },
                },
              })
            }
          >
            {t("segment.moveUp")}
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={singleTargetDisabled || siblingAt < 0 || siblingAt >= siblings.length - 1}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: {
                  kind: "move-para",
                  address: address!,
                  to: { address: paragraphAddress(siblings[siblingAt + 1]!), position: "after" },
                },
              })
            }
          >
            {t("segment.moveDown")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-danger"
            disabled={singleTargetDisabled}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "delete-para", address: address! },
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
              disabled={disabled || selected.length === 0}
              onClick={() => store.dispatch({
                type: "queueOps",
                ops: selected.map((target) => ({ kind: "set-align" as const, address: paragraphAddress(target), alignment: align.value })),
              })}
            >
              {t(align.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="hwped-field">
        <span className="hwped-label">{t("segment.paraShapeLabel")}</span>
        <div className="hwped-row">
          <select className="hwped-input" value={shapeKey} disabled={disabled || selected.length === 0} aria-label={t("segment.paraShapeKeyAria")}
            onChange={(e) => setShapeKey(e.target.value as ParaShapeKey)}>
            {SHAPE_KEYS.map(({ value, key }) => <option key={value} value={value}>{t(key)}</option>)}
          </select>
          <input className="hwped-input" type="text" inputMode="decimal" value={shapeValue} disabled={disabled || selected.length === 0} placeholder={shapeKey === "line-spacing" ? (lineSpacingUnit === "%" ? "%" : "pt") : "mm"}
            aria-label={t("segment.paraShapeValueAria")} onChange={(e) => setShapeValue(e.target.value)} />
          {shapeKey === "line-spacing"
            ? <select className="hwped-input" value={lineSpacingUnit} disabled={disabled || selected.length === 0} aria-label={t("segment.paraShapeUnitAria")} onChange={(e) => setLineSpacingUnit(e.target.value as "%" | "pt")}>
                <option value="%">{t("segment.unitPercent")}</option><option value="pt">{t("segment.unitPoints")}</option>
              </select>
            : <span className="hwped-label">mm</span>}
          <button type="button" className="hwped-btn" disabled={disabled || selected.length === 0 || !validShape}
            onClick={() => store.dispatch({ type: "queueOps", ops: selected.map((target) => ({ kind: "set-para" as const, address: paragraphAddress(target), key: shapeKey, value: `${shapeValue.trim()}${shapeKey === "line-spacing" ? lineSpacingUnit : "mm"}` })) })}>{t("segment.setPara")}</button>
        </div>
      </div>

      {shapeValue !== "" && !validShape && <p role="alert" className="hwped-hint">{t(isPlainDecimal(shapeValue) ? "unit.positive" : "unit.invalid")}</p>}
      {singleParagraph !== undefined && <div className="hwped-field">
        <span className="hwped-label">{t("segment.selectSimilar")}</span>
        <div className="hwped-row">
          <button type="button" className="hwped-btn" disabled={charPrimary?.directChar === undefined} onClick={() => selectLikePrimary("char")}>{t("segment.similarChar")}</button>
          <button type="button" className="hwped-btn" disabled={singleParagraph.directPara === undefined} onClick={() => selectLikePrimary("para")}>{t("segment.similarPara")}</button>
        </div>
        {charPrimary?.directChar === undefined && <p className="hwped-hint">{t("segment.similarCharUnavailable")}</p>}
        {singleParagraph.directPara === undefined && <p className="hwped-hint">{t("segment.similarParaUnavailable")}</p>}
      </div>}
      {singleParagraph !== undefined && <div className="hwped-field">
        <span className="hwped-label">{t("segment.hyperlinkLabel")}</span>
        <p className="hwped-hint">{t("segment.hyperlinkHint")}</p>
        {legacyLinkSeparator && <p role="alert" className="hwped-hint">{t("segment.legacyHyperlinkSeparator")}</p>}
        <input className="hwped-input" type="url" value={linkUrl} disabled={anchorDisabled} placeholder={t("segment.hyperlinkUrlPlaceholder")}
          aria-label={t("segment.hyperlinkUrlAria")} onChange={(e) => setLinkUrl(e.target.value)} />
        <input className="hwped-input" type="text" value={linkText} disabled={anchorDisabled} placeholder={t("segment.hyperlinkTextPlaceholder")}
          aria-label={t("segment.hyperlinkTextAria")} onChange={(e) => setLinkText(e.target.value)} />
        <button type="button" className="hwped-btn" disabled={anchorDisabled || legacyLinkSeparator || currentText === "" || linkUrl.trim() === ""}
          onClick={() => store.dispatch({ type: "queueOp", op: { kind: "create-hyperlink", anchor: currentText, url: linkUrl.trim(), ...(linkText.trim() === "" ? {} : { text: linkText.trim() }) } })}>{t("segment.createHyperlink")}</button>
      </div>}

      {singleParagraph !== undefined && <div className="hwped-field">
        <label className="hwped-label" htmlFor="hwped-run-range">{t("segment.rangeTextAria")}</label>
        <p className="hwped-hint">{t("segment.rangeWholeRunHint")}</p>
        {!rangeAvailable && <p className="hwped-hint">{
          // An empty or v2 point paragraph has no runs at all: nothing about the
          // host is missing, so the host-upgrade remedy would be wrong.
          runs.length === 0 ? t("segment.rangeUnavailableNoRuns") : t("segment.rangeUnavailable")
        }</p>}
        <textarea ref={rangeInput} id="hwped-run-range" className="hwped-textarea" rows={3} readOnly value={markdownText}
          disabled={disabled || !rangeAvailable} onSelect={event => {
            if (!rangeAvailable) return;
            const field = event.currentTarget;
            const start = scalarAtUtf16(field.selectionStart, supplementaryStarts);
            const end = scalarAtUtf16(field.selectionEnd, supplementaryStarts);
            if (start === undefined || end === undefined) { setRangeInvalid(true); return; }
            setRangeInvalid(false);
            store.dispatch({ type: "setRange", range: start === end ? null : {
              paragraph: segmentRef(singleParagraph), start: singleParagraph.start + start, end: singleParagraph.start + end,
            } });
          }} />
        {(rangeInvalid || (state.range != null && formatTargets.length === 0)) && <p role="alert" className="hwped-hint">{t("segment.rangeInvalid")}</p>}
        {state.range != null && <>
          <p className="hwped-hint" role="status">{t("segment.rangeRunCount", { count: formatTargets.length })}</p>
          <button type="button" className="hwped-btn" onClick={() => {
            setRangeInvalid(false); rangeInput.current?.setSelectionRange(0, 0);
            if (hasRunSelection) store.dispatch({ type: "select", selection: segmentRef(singleParagraph) });
            else store.dispatch({ type: "setRange", range: null });
          }}>{t("segment.rangeClear")}</button>
        </>}
      </div>}
      <div className="hwped-field">
        <span className="hwped-label">{t("segment.formatLabel")}</span>
        <p className="hwped-hint">{t("segment.formatRunCount", { count: formatTargets.length })}</p>
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
              disabled || rangeInvalid || !validFontSize || formatTargets.length === 0 ||
              (!bold && fontSize.trim() === "" && color === "")
            }
            onClick={() => {
              const props: Record<string, string> = {};
              if (bold) props["bold"] = "on";
              if (fontSize.trim() !== "") props["size"] = fontSize.trim();
              if (color !== "") props["color"] = color;
              store.dispatch({ type: "queueOps", ops: formatTargets.map((target) => ({ kind: "set-format" as const, address: target, props })) });
            }}
          >
            {t("segment.formatSubmit")}
          </button>
          {!validFontSize && <p role="alert" className="hwped-hint">{t(isPlainDecimal(fontSize) ? "unit.positive" : "unit.invalid")}</p>}
        </div>
      </div>
      </>}
    </div>
  );
}

/** Convert the Inspector's DOM UTF-16 selection to emitted Markdown scalar offsets. */
function scalarAtUtf16(offset: number, supplementaryStarts: readonly number[]): number | undefined {
  let low = 0, high = supplementaryStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (supplementaryStarts[middle]! + 2 <= offset) low = middle + 1;
    else high = middle;
  }
  if (supplementaryStarts[low] !== undefined && supplementaryStarts[low]! + 1 === offset) return undefined;
  return offset - low;
}
