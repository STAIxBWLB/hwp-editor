/**
 * Styles tab: the document's named paragraph styles (issue #53, WP3/T5).
 *
 * Everything here is an edit-ops-v1 style op queued on the store, so a change
 * lands with the toolbar's Apply and shares one undo entry with the rest of
 * the batch. The one exception is the preset switch: `hwp edit` keeps
 * `--style-tables` and `--ops` mutually exclusive, so the switch runs
 * immediately as two engine calls — the body-style `update_style` first, the
 * preset's table styling second — inside ONE `replaceDocument` transaction,
 * which stages one snapshot and is therefore one undo step (AC6/AC7's
 * grouping clause).
 *
 * Paragraph styles only: the engine refuses character-style creation and
 * application (hwp-cli 1.4.0 T3), so a character row is listed but carries no
 * actions rather than offering a button the engine always refuses.
 */
import { useState } from "react";
import type { JSX } from "react";
import {
  paragraphAddress,
  presetStyleOps,
  resolveSelection,
  segmentAtRef,
  selectedParagraphs,
  segmentRef,
  selectSimilar,
  STYLE_TABLE_PRESETS,
} from "@hwp-editor/core";
import type {
  EditOp,
  ParagraphAlignment,
  Segment,
  StyleInfo,
  StyleTablePreset,
} from "@hwp-editor/core";
import { isPlainDecimal } from "./unit-input.js";
import { useHwpEditorContext } from "./context.js";
import type { MessageKey } from "./messages.js";

const ALIGNMENTS: readonly ParagraphAlignment[] = ["justify", "left", "right", "center", "distribute"];
const ALIGN_LABEL: Record<ParagraphAlignment, MessageKey> = {
  justify: "segment.alignJustify",
  left: "segment.alignLeft",
  right: "segment.alignRight",
  center: "segment.alignCenter",
  distribute: "segment.alignJustify",
};
const PRESET_LABEL: Record<StyleTablePreset, MessageKey> = {
  official: "presets.official",
  report: "presets.report",
  plan: "presets.plan",
  notice: "presets.notice",
  minutes: "presets.minutes",
  press: "presets.press",
};

/** A paragraph alignment this editor can write, or the default when the host reports another. */
function alignmentOf(value: string): ParagraphAlignment {
  return (ALIGNMENTS as readonly string[]).includes(value) ? (value as ParagraphAlignment) : "justify";
}

/** The first font family a shape carries, in the engine's own spelling. */
function firstFace(shape: StyleInfo["attrs"]): string | undefined {
  return shape.char.faces.find((face): face is string => face !== null);
}

export function StylesPanel(): JSX.Element {
  const { store, engine, state, envelope, editable, capabilities, styles, replaceDocument, t } = useHwpEditorContext();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [size, setSize] = useState("");
  const [font, setFont] = useState("");
  const [bold, setBold] = useState(false);
  const [align, setAlign] = useState<ParagraphAlignment>("justify");
  const [spacing, setSpacing] = useState("");
  const [promoteName, setPromoteName] = useState("");
  const [preset, setPreset] = useState<StyleTablePreset>("official");

  // Before 1.4.0 the command family does not exist, and the tab says which
  // version is missing rather than showing controls that can only fail.
  if (capabilities?.styles !== "v1") {
    return (
      <div className="hwped-panel" role="region" aria-label={t("tabs.styles")}>
        <p className="hwped-hint" role="status">{t("styles.unavailable", { version: capabilities?.version ?? "" })}</p>
      </div>
    );
  }

  const paragraphs = envelope === null ? [] : selectedParagraphs(envelope, state);
  const rows = styles?.styles ?? [];
  const row = rows.find((item) => item.id === selectedId) ?? null;
  const busy = state.status === "applying";
  const disabled = !editable || busy || envelope === null;

  /**
   * Select a style and highlight the paragraphs that use it, seeding the
   * definition form from the style itself so an untouched field rewrites the
   * value it already had instead of inventing one.
   */
  const choose = (item: StyleInfo): void => {
    setSelectedId(item.id);
    setSize(String(item.attrs.char.size_pt));
    setFont(firstFace(item.attrs) ?? "");
    setBold(item.attrs.char.bold);
    setAlign(alignmentOf(item.attrs.para.alignment));
    setSpacing("");
    if (envelope === null || item.used_by.length === 0) return;
    const refs = item.used_by.flatMap((id) => {
      // The id is the whole coordinate; `section`/`para` are placeholders the
      // lookup never reads when an id is present.
      const segment = segmentAtRef(envelope, { id, section: 0, para: 0 });
      return segment === undefined ? [] : [segmentRef(segment)];
    });
    if (refs.length === 0) return;
    store.dispatch({ type: "selectMany", selections: refs, primary: refs[0]!, anchor: refs[0]! });
  };

  const sizeValid = size.trim() === "" || (isPlainDecimal(size.trim()) && Number(size.trim()) > 0);
  const spacingValid = spacing.trim() === "" || (isPlainDecimal(spacing.trim()) && Number(spacing.trim()) > 0);

  const queueDefinition = (): void => {
    if (row === null || !sizeValid || !spacingValid) return;
    store.dispatch({
      type: "queueOp",
      op: {
        kind: "update-style",
        style: row.name,
        size: size.trim(),
        ...(font.trim() === "" ? {} : { font: font.trim() }),
        bold,
        align,
        ...(spacing.trim() === "" ? {} : { lineSpacingPct: spacing.trim() }),
      },
    });
  };

  const queueApply = (): void => {
    if (row === null || paragraphs.length === 0) return;
    store.dispatch({
      type: "queueOps",
      ops: paragraphs.map((paragraph): EditOp => ({
        kind: "apply-style",
        address: paragraphAddress(paragraph),
        style: row.name,
      })),
    });
  };

  /**
   * Promote: one `create_style` describing the selected paragraph as it
   * renders, then an `apply_style` for every paragraph T3's select-similar
   * finds at the paragraph level. Both go into one queue action, so the pair
   * is one engine call and one undo step.
   */
  const queuePromote = (): void => {
    const name = promoteName.trim();
    const base: Segment | undefined = paragraphs[0];
    const shape = base === undefined ? undefined : base.direct ?? base.style;
    if (name === "" || base === undefined || shape === undefined || envelope === null) return;
    const face = firstFace(shape);
    const paragraph = resolveSelection(envelope, base).paragraph ?? base;
    const targets = selectSimilar(envelope, paragraph, "para")
      .flatMap((ref) => {
        const segment = segmentAtRef(envelope, ref);
        return segment === undefined ? [] : [paragraphAddress(segment)];
      });
    store.dispatch({
      type: "queueOps",
      ops: [
        {
          kind: "create-style",
          name,
          bold: shape.char.bold,
          size: String(shape.char.size_pt),
          color: shape.char.color,
          align: alignmentOf(shape.para.alignment),
          ...(row === null ? {} : { basedOn: row.name }),
          ...(face === undefined ? {} : { font: face }),
        },
        ...targets.map((address): EditOp => ({ kind: "apply-style", address, style: name })),
      ],
    });
    setPromoteName("");
  };

  /**
   * The preset switch. `replaceDocument` is the grouping: it stages one
   * snapshot and commits one `applySucceeded`, whatever number of engine
   * calls the producer makes. A refusal (queued edits, a load in flight) is
   * already reported by the editor, so this awaits rather than repeating it.
   */
  const switchPreset = (): void => {
    if (styles === null || envelope === null) return;
    // The envelope is what separates the body paragraphs from table cells when
    // the body style is picked; the table alone cannot tell them apart.
    const ops = presetStyleOps(styles, preset, envelope);
    void replaceDocument(async (current) => {
      const styled = ops.length === 0 ? current : await engine.edit(current, ops, { verify: true });
      return engine.edit(styled, [], { styleTables: preset });
    }).catch(() => undefined);
  };

  const promoteDisabled = disabled || paragraphs.length === 0 || promoteName.trim() === "";
  const nameInvalid = promoteName.trim() !== "" && /[{}]/.test(promoteName);

  return (
    <div className="hwped-panel" role="region" aria-label={t("tabs.styles")}>
      <div className="hwped-field">
        <span className="hwped-label">{t("styles.definition")}</span>
        {styles === null && <p className="hwped-hint" role="status">{t("styles.loading")}</p>}
        {styles !== null && rows.length === 0 && <p className="hwped-hint">{t("styles.empty")}</p>}
        {rows.length > 0 && (
          <ul className="hwped-list">
            {rows.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="hwped-btn"
                  aria-pressed={item.id === selectedId}
                  disabled={envelope === null}
                  onClick={() => choose(item)}
                >
                  {item.name}
                  <span className="hwped-hint">{` ${t("styles.usage", { count: item.used_by.length })}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 0 && <p className="hwped-hint">{t("styles.selectHint")}</p>}
      </div>

      {row !== null && row.kind === "paragraph" && (
        <div className="hwped-field">
          <span className="hwped-label">{row.name}</span>
          <div className="hwped-row">
            <input
              className="hwped-input hwped-input-narrow"
              type="text"
              inputMode="decimal"
              value={size}
              disabled={disabled}
              aria-label={t("styles.size")}
              placeholder={t("styles.size")}
              onChange={(e) => setSize(e.target.value)}
            />
            <input
              className="hwped-input hwped-input-narrow"
              type="text"
              value={font}
              disabled={disabled}
              aria-label={t("styles.font")}
              placeholder={t("styles.font")}
              onChange={(e) => setFont(e.target.value)}
            />
            <label className="hwped-check">
              <input type="checkbox" checked={bold} disabled={disabled} onChange={(e) => setBold(e.target.checked)} />
              {t("styles.bold")}
            </label>
          </div>
          <div className="hwped-row">
            <select
              className="hwped-input"
              value={align}
              disabled={disabled}
              aria-label={t("segment.alignGroupAria")}
              onChange={(e) => setAlign(alignmentOf(e.target.value))}
            >
              {ALIGNMENTS.map((value) => <option key={value} value={value}>{t(ALIGN_LABEL[value])}</option>)}
            </select>
            <input
              className="hwped-input hwped-input-narrow"
              type="text"
              inputMode="decimal"
              value={spacing}
              disabled={disabled}
              aria-label={t("styles.lineSpacing")}
              placeholder={t("styles.lineSpacing")}
              onChange={(e) => setSpacing(e.target.value)}
            />
          </div>
          <div className="hwped-row">
            <button
              type="button"
              className="hwped-btn"
              disabled={disabled || !sizeValid || !spacingValid}
              onClick={queueDefinition}
            >{t("styles.updateSubmit")}</button>
            <button
              type="button"
              className="hwped-btn"
              disabled={disabled || paragraphs.length === 0}
              onClick={queueApply}
            >{t("styles.applyToSelection")}</button>
          </div>
          {!sizeValid && <p className="hwped-hint" role="alert">{t("unit.positive")}</p>}
          {!spacingValid && <p className="hwped-hint" role="alert">{t("unit.positive")}</p>}
          {paragraphs.length === 0 && <p className="hwped-hint">{t("styles.needsParagraph")}</p>}
        </div>
      )}

      <div className="hwped-field">
        <span className="hwped-label">{t("styles.promoteName")}</span>
        <p className="hwped-hint">{t("styles.promoteHint")}</p>
        <div className="hwped-row">
          <input
            className="hwped-input"
            type="text"
            value={promoteName}
            disabled={disabled}
            aria-label={t("styles.promoteName")}
            onChange={(e) => setPromoteName(e.target.value)}
          />
          <button type="button" className="hwped-btn" disabled={promoteDisabled || nameInvalid} onClick={queuePromote}>
            {t("styles.promoteSubmit")}
          </button>
        </div>
        {nameInvalid && <p className="hwped-hint" role="alert">{t("segment.placeholderNameInvalid")}</p>}
        {!disabled && paragraphs.length === 0 && <p className="hwped-hint">{t("styles.needsParagraph")}</p>}
      </div>

      <div className="hwped-field">
        <span className="hwped-label">{t("styles.presetLabel")}</span>
        <p className="hwped-hint">{t("styles.presetHint")}</p>
        <div className="hwped-row">
          <select
            className="hwped-input"
            value={preset}
            disabled={disabled}
            aria-label={t("styles.presetLabel")}
            onChange={(e) => setPreset(e.target.value as StyleTablePreset)}
          >
            {STYLE_TABLE_PRESETS.map((value) => <option key={value} value={value}>{t(PRESET_LABEL[value])}</option>)}
          </select>
          <button type="button" className="hwped-btn" disabled={disabled || styles === null} onClick={switchPreset}>
            {t("styles.presetSubmit")}
          </button>
        </div>
      </div>
    </div>
  );
}
