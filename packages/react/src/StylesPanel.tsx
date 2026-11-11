/**
 * Styles tab: the document's named paragraph styles (issue #53, WP3/T5).
 *
 * Everything here is an edit-ops-v1 style op queued on the store, so a change
 * lands with the toolbar's Apply and shares one undo entry with the rest of
 * the batch. The preset switch is the one action that runs immediately: it is
 * a single engine call carrying the body-style update and the `style_tables`
 * op together, inside one `replaceDocument` transaction, which stages one
 * snapshot and is therefore one undo step (AC6/AC7's grouping clause).
 *
 * The preset travels as an op rather than as `--style-tables` because the flag
 * and `--ops` are mutually exclusive AND the flag form aborts the whole edit
 * when the document has no multi-column table. Those two facts together made
 * the two-call switch lose the style update on any table-less document.
 *
 * Paragraph styles only: the engine refuses character-style creation and
 * application (hwp-cli 1.4.0 T3), so a character row, and a row whose kind the
 * document does not answer, is listed but carries no actions rather than
 * offering a button the engine always refuses.
 */
import { useState } from "react";
import type { JSX } from "react";
import {
  HwpEngineError,
  paragraphAddress,
  presetStyleOps,
  readPresetBatch,
  resolveSelection,
  segmentAtRef,
  selectedParagraphs,
  segmentRef,
  selectSimilar,
  STYLE_TABLE_PRESETS,
  stylesVersionSupported,
} from "@hwp-editor/core";
import type {
  EditOp,
  ParagraphAlignment,
  Segment,
  StyleInfo,
  StyleProps,
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
  distribute: "segment.alignDistribute",
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
  return shape.char?.faces.find((face): face is string => face !== null);
}

/**
 * The definition the form was seeded from, so a submit sends only what the
 * user changed. The engine writes a supplied field into the style's whole
 * definition: a `font` reaches every language slot, so re-sending the seeded
 * face turns a size change into a font rewrite, and a `bold`/`align` the user
 * never touched rewrites a value the document had.
 */
interface Seed {
  size: string;
  font: string;
  bold: boolean;
  align: ParagraphAlignment;
}

export function StylesPanel(): JSX.Element {
  const {
    store, engine, state, envelope, editable, capabilities,
    styles, stylesStatus, replaceDocument, noteNotice, t,
  } = useHwpEditorContext();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [size, setSize] = useState("");
  const [font, setFont] = useState("");
  const [bold, setBold] = useState(false);
  const [align, setAlign] = useState<ParagraphAlignment>("justify");
  const [spacing, setSpacing] = useState("");
  const [promoteName, setPromoteName] = useState("");
  const [preset, setPreset] = useState<StyleTablePreset>("official");
  const [seed, setSeed] = useState<Seed>({ size: "", font: "", bold: false, align: "justify" });

  // Before 1.4.0 the command family does not exist. Each way of not having it
  // names its own cause and its own next step: a host still being asked, an
  // adapter that never learned the command, and a binary below the floor are
  // three different situations, and one sentence blaming the version is wrong
  // for two of them.
  if (capabilities === null) {
    return (
      <div className="hwped-panel" role="region" aria-label={t("tabs.styles")}>
        <p className="hwped-hint" role="status">{t("styles.checkingHost")}</p>
      </div>
    );
  }
  if (capabilities.styles !== "v1") {
    return (
      <div className="hwped-panel" role="region" aria-label={t("tabs.styles")}>
        <p className="hwped-hint" role="status">{
          stylesVersionSupported(capabilities.version)
            ? t("styles.unavailableHost")
            : t("styles.unavailable", { version: capabilities.version })
        }</p>
      </div>
    );
  }
  // The capability is advertised and the engine object has nothing to call for
  // it: the same sentence as an adapter that never learned the command, and
  // not a read that is still running.
  if (engine.styles === undefined) {
    return (
      <div className="hwped-panel" role="region" aria-label={t("tabs.styles")}>
        <p className="hwped-hint" role="status">{t("styles.unavailableHost")}</p>
      </div>
    );
  }

  const paragraphs = envelope === null ? [] : selectedParagraphs(envelope, state);
  const rows = styles?.styles ?? [];
  const row = rows.find((item) => item.id === selectedId) ?? null;
  const paragraphRow = row !== null && row.kind === "paragraph" ? row : null;
  // A side the document could not resolve (the contract's `null`) is not a
  // value this form may seed from or write over: it is absent, and the control
  // says so rather than showing a default the document never stated.
  const charKnown = paragraphRow?.attrs.char !== undefined;
  const paraKnown = paragraphRow?.attrs.para !== undefined;
  const busy = state.status === "applying";
  const disabled = !editable || busy || envelope === null;

  /**
   * Select a style and highlight the paragraphs that use it, seeding the
   * definition form from the style itself so an untouched field rewrites the
   * value it already had instead of inventing one.
   */
  const choose = (item: StyleInfo): void => {
    setSelectedId(item.id);
    const char = item.attrs.char;
    const para = item.attrs.para;
    const seeded: Seed = {
      size: char === undefined ? "" : String(char.size_pt),
      font: (char === undefined ? undefined : firstFace(item.attrs)) ?? "",
      bold: char === undefined ? false : char.bold,
      align: para === undefined ? "justify" : alignmentOf(para.alignment),
    };
    setSeed(seeded);
    setSize(seeded.size);
    setFont(seeded.font);
    setBold(seeded.bold);
    setAlign(seeded.align);
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

  /**
   * What the form asks the style to become: only fields that differ from the
   * definition it was seeded with, and never an empty one. An empty size used
   * to travel as `size: ""`, which `withUnit` refuses at Apply and takes the
   * whole pending batch down with it.
   */
  const definition: StyleProps = {
    ...(charKnown && size.trim() !== "" && size.trim() !== seed.size ? { size: size.trim() } : {}),
    ...(charKnown && font.trim() !== "" && font.trim() !== seed.font ? { font: font.trim() } : {}),
    ...(charKnown && bold !== seed.bold ? { bold } : {}),
    ...(paraKnown && align !== seed.align ? { align } : {}),
    ...(spacing.trim() === "" ? {} : { lineSpacingPct: spacing.trim() }),
  };
  const definitionEmpty = Object.keys(definition).length === 0;

  const queueDefinition = (): void => {
    if (paragraphRow === null || definitionEmpty || !sizeValid || !spacingValid) return;
    store.dispatch({
      type: "queueOp",
      // The row's own id, not its name: a styles-v1 name can be empty and
      // two rows can share one, while the id is the row.
      op: { kind: "update-style", style: paragraphRow.id, ...definition },
    });
  };

  const queueApply = (): void => {
    if (paragraphRow === null || paragraphs.length === 0) return;
    store.dispatch({
      type: "queueOps",
      ops: paragraphs.map((paragraph): EditOp => ({
        kind: "apply-style",
        address: paragraphAddress(paragraph),
        style: paragraphRow.id,
      })),
    });
  };

  /**
   * Promote: one `create_style` describing the selected paragraph as it
   * renders, then an `apply_style` for every paragraph T3's select-similar
   * finds at the paragraph level. Both go into one queue action, so the pair
   * is one engine call and one undo step.
   *
   * The new style is based on the SELECTED PARAGRAPH's own style, found by the
   * table's `used_by` join — not on the highlighted list row. The highlight
   * can be a character row, a row whose kind the document does not answer, or
   * simply a row this paragraph does not use, and `create_style` clones its
   * base's shapes: everything the promote op does not set (line spacing,
   * indent, the fields this form has no control for) would then come from that
   * unrelated row.
   */
  const queuePromote = (): void => {
    const name = promoteName.trim();
    const base: Segment | undefined = paragraphs[0];
    const shape = base === undefined ? undefined : base.direct ?? base.style;
    if (name === "" || base === undefined || shape === undefined || envelope === null) return;
    const face = firstFace(shape);
    const paragraph = resolveSelection(envelope, base).paragraph ?? base;
    const id = paragraph.id;
    const own = id === undefined
      ? undefined
      : rows.find((item) => item.kind === "paragraph" && item.used_by.includes(id));
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
          ...(shape.char === undefined ? {} : {
            bold: shape.char.bold,
            size: String(shape.char.size_pt),
            color: shape.char.color,
          }),
          ...(shape.para === undefined ? {} : { align: alignmentOf(shape.para.alignment) }),
          ...(own === undefined ? {} : { basedOn: own.id }),
          ...(face === undefined ? {} : { font: face }),
        },
        // The style this batch creates has no id yet, so the applies name it.
        ...targets.map((address): EditOp => ({ kind: "apply-style", address, style: name })),
      ],
    });
    setPromoteName("");
  };

  /**
   * The preset switch: ONE engine call carrying the body-style update and the
   * `style_tables` op, inside one `replaceDocument` transaction — one
   * snapshot, one `applySucceeded`, therefore one undo entry. A refusal
   * (queued edits, a load in flight) is already reported by the editor, so
   * this awaits rather than repeating it.
   *
   * The preset's outcome is read from the report the engine returns, through
   * the same core rule every transport obeys. "No styleable table" is not a
   * failed switch: the style update landed, the document simply has no
   * multi-column table, and the user hears it once the replacement has
   * actually been applied. A batch the engine reports as changing nothing
   * hands back the document it was given, so an already-applied preset does
   * not become an undo entry that restores the document to itself.
   */
  const switchPreset = (): void => {
    if (styles === null || envelope === null) return;
    // The envelope is what separates the body paragraphs from table cells when
    // the body style is picked; the table alone cannot tell them apart.
    const batch: EditOp[] = [
      ...presetStyleOps(styles, preset, envelope),
      { kind: "style-tables", preset },
    ];
    let unstyled = false;
    void replaceDocument(async (current) => {
      const styled = await engine.edit(current, batch, { verify: true });
      const reading = readPresetBatch(styled.report);
      // The transports refuse this themselves; a host that supplies its own
      // engine may not, and the caller here is the one that knows the batch is
      // a preset batch.
      if (reading.refusal !== null) {
        throw new HwpEngineError(reading.refusal.code, reading.refusal.message);
      }
      unstyled = reading.unstyledTable;
      return reading.unchanged ? current : styled;
    })
      .then((applied) => { if (applied && unstyled) noteNotice(t("styles.noTableToStyle")); })
      .catch(() => undefined);
  };

  // The styleName contract is one or more characters with no control
  // characters; braces and punctuation are names like any other.
  const nameInvalid = promoteName.trim() !== "" && /[\u0000-\u001f\u007f]/.test(promoteName);
  const promoteDisabled = disabled || paragraphs.length === 0 || promoteName.trim() === "";

  return (
    <div className="hwped-panel" role="region" aria-label={t("tabs.styles")}>
      <div className="hwped-field">
        <span className="hwped-label">{t("styles.definition")}</span>
        {styles === null && <p className="hwped-hint" role="status">{
          stylesStatus === "failed" ? t("styles.loadFailed") : t("styles.loading")
        }</p>}
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

      {row !== null && row.kind === null && (
        <p className="hwped-hint">{t("styles.kindUnknown")}</p>
      )}

      {paragraphRow !== null && (
        <div className="hwped-field">
          <span className="hwped-label">{paragraphRow.name}</span>
          <div className="hwped-row">
            <input
              className="hwped-input hwped-input-narrow"
              type="text"
              inputMode="decimal"
              value={size}
              disabled={disabled || !charKnown}
              aria-label={t("styles.size")}
              placeholder={t("styles.size")}
              onChange={(e) => setSize(e.target.value)}
            />
            <input
              className="hwped-input hwped-input-narrow"
              type="text"
              value={font}
              disabled={disabled || !charKnown}
              aria-label={t("styles.font")}
              placeholder={t("styles.font")}
              onChange={(e) => setFont(e.target.value)}
            />
            <label className="hwped-check">
              <input type="checkbox" checked={bold} disabled={disabled || !charKnown} onChange={(e) => setBold(e.target.checked)} />
              {t("styles.bold")}
            </label>
          </div>
          <div className="hwped-row">
            <select
              className="hwped-input"
              value={align}
              disabled={disabled || !paraKnown}
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
          {(!charKnown || !paraKnown) && <p className="hwped-hint">{t("styles.attrsUnresolved")}</p>}
          <div className="hwped-row">
            <button
              type="button"
              className="hwped-btn"
              disabled={disabled || definitionEmpty || !sizeValid || !spacingValid}
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
        {nameInvalid && <p className="hwped-hint" role="alert">{t("styles.nameInvalid")}</p>}
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
