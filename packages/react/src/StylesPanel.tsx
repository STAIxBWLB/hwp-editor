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
import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  HwpEngineError,
  paragraphAddress,
  presetBatchOptions,
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

/**
 * The same test without the fallback, for a caller that must NOT invent one:
 * the engine publishes `divide` and its own spellings, and writing `justify`
 * for either rewrites the paragraph's alignment to a value it never had.
 */
function writableAlignment(value: string): ParagraphAlignment | undefined {
  return (ALIGNMENTS as readonly string[]).includes(value) ? (value as ParagraphAlignment) : undefined;
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

/**
 * The row's own values, as the form opens on them. Derived during render and
 * never stored: the table is re-read after every applied edit, undo and new
 * document, so a seed taken at one moment goes stale the moment a read lands.
 * An effect that repairs a stored seed leaves a frame in which the form
 * compares the user's typing against a value the style no longer has, which is
 * a race the render cannot lose.
 */
function seedOf(row: StyleInfo): Seed {
  const char = row.attrs.char;
  const para = row.attrs.para;
  return {
    size: char === undefined ? "" : String(char.size_pt),
    font: (char === undefined ? undefined : firstFace(row.attrs)) ?? "",
    bold: char === undefined ? false : char.bold,
    align: para === undefined ? "justify" : alignmentOf(para.alignment),
  };
}

/**
 * The definition form for ONE row, holding only what the user typed. The
 * caller keys it on the row's id and attribute content, so a re-read that
 * changed the style re-mounts the form on the new values (after Apply the form
 * offers nothing, after undo it shows what the restored document carries),
 * while a re-read that changed nothing (another locale, a host's inline
 * `messages` object) leaves the typing in place.
 */
function DefinitionForm(
  props: { row: StyleInfo; paragraphs: Segment[]; disabled: boolean },
): JSX.Element {
  const { row, paragraphs, disabled } = props;
  const { store, t } = useHwpEditorContext();
  const seed = seedOf(row);
  // A side the document could not resolve (the contract's `null`) is not a
  // value this form may seed from or write over: it is absent, and the control
  // says so rather than showing a default the document never stated.
  const charKnown = row.attrs.char !== undefined;
  const paraKnown = row.attrs.para !== undefined;
  const [size, setSize] = useState(seed.size);
  const [font, setFont] = useState(seed.font);
  const [bold, setBold] = useState(seed.bold);
  const [align, setAlign] = useState(seed.align);
  const [spacing, setSpacing] = useState("");

  const sizeValid = size.trim() === "" || (isPlainDecimal(size.trim()) && Number(size.trim()) > 0);
  const spacingValid = spacing.trim() === "" || (isPlainDecimal(spacing.trim()) && Number(spacing.trim()) > 0);

  /**
   * What the form asks the style to become: only fields that differ from the
   * definition it was opened on, and never an empty one. An empty size used to
   * travel as `size: ""`, which `withUnit` refuses at Apply and takes the whole
   * pending batch down with it.
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
    if (definitionEmpty || !sizeValid || !spacingValid) return;
    store.dispatch({
      type: "queueOp",
      // The row's own id, not its name: a styles-v1 name can be empty and two
      // rows can share one, while the id is the row.
      op: { kind: "update-style", style: row.id, ...definition },
    });
  };

  const queueApply = (): void => {
    if (paragraphs.length === 0) return;
    store.dispatch({
      type: "queueOps",
      ops: paragraphs.map((paragraph): EditOp => ({
        kind: "apply-style",
        address: paragraphAddress(paragraph),
        style: row.id,
      })),
    });
  };

  return (
    <div className="hwped-field">
      <span className="hwped-label">{row.name}</span>
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
  );
}

export function StylesPanel(): JSX.Element {
  const {
    store, engine, state, envelope, editable, capabilities,
    styles, stylesStatus, replaceDocument, noteNotice, documentOrigin, t,
  } = useHwpEditorContext();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [promoteName, setPromoteName] = useState("");
  const [preset, setPreset] = useState<StyleTablePreset>("official");

  // Every hook sits above the capability returns: a host that answers its
  // capabilities a beat late would otherwise change the hook count mid-mount.
  //
  // A row id is only meaningful inside the document it was read from. While a
  // read is in flight (`styles === null`) the rows are simply not here yet, so
  // the highlight stays; once a table has arrived without it, the style is gone
  // from this document and the choice goes with it.
  useEffect(() => {
    if (selectedId === null || styles === null) return;
    if (styles.styles.some((item) => item.id === selectedId)) return;
    setSelectedId(null);
  }, [selectedId, styles]);

  // A NEW document retires the highlight: the next document's row with the
  // same id is another style. This is the editor's own counter and not the
  // host's file name: a compose takes on a document without changing the file,
  // and two files can share one name. An applied edit or an undo does not move
  // it, so the choice survives working on the same document.
  useEffect(() => {
    setSelectedId(null);
  }, [documentOrigin]);

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
  const busy = state.status === "applying";
  const disabled = !editable || busy || envelope === null;

  /**
   * Select a style and highlight the paragraphs that use it. The definition
   * form reads the row's own values when it is keyed, so an untouched field
   * rewrites the value it already had instead of inventing one.
   */
  const choose = (item: StyleInfo): void => {
    setSelectedId(item.id);
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
   * base's shapes: everything the promote op does not set (the fields this
   * form has no control for) would then come from that unrelated row. What the
   * paragraph carries as its own direct override — italic, a percentage line
   * height — travels in the op, so the paragraph's look is not lost to the
   * clone either.
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
    const align = shape.para === undefined ? undefined : writableAlignment(shape.para.alignment);
    store.dispatch({
      type: "queueOps",
      ops: [
        {
          kind: "create-style",
          name,
          ...(shape.char === undefined ? {} : {
            bold: shape.char.bold,
            italic: shape.char.italic,
            size: String(shape.char.size_pt),
            color: shape.char.color,
          }),
          // Only an alignment this editor can write: `divide` and a host's own
          // spelling are not justify, and the style inherits the base's
          // alignment rather than being given one the paragraph never had.
          ...(align === undefined ? {} : { align }),
          // A percentage line height is published as the percentage with type
          // 0, which is the unit `line_spacing_pct` takes. Any other type is a
          // value this editor cannot read back as a unit it may write, so the
          // style keeps the base's spacing instead of a converted guess.
          ...(shape.para === undefined || shape.para.line_spacing_type !== 0
            ? {}
            : { lineSpacingPct: String(shape.para.line_spacing) }),
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
   * (queued edits, a load in flight) is put on the notice line by
   * `replaceDocument` itself, so this awaits rather than repeating it; the
   * button is disabled while edits are queued, which is the state the user
   * can see and clear.
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
    // the body style is picked; the table alone cannot tell them apart. A
    // document that defines no paragraph style sends the preset alone, and the
    // sentence a quiet outcome gets depends on whether that write was in the
    // batch at all.
    const styleOps = presetStyleOps(styles, preset, envelope);
    const carriedStyleOp = styleOps.length > 0;
    const batch: EditOp[] = [
      ...styleOps,
      { kind: "style-tables", preset },
    ];
    const before = state.document;
    let unstyled = false;
    let changed = false;
    void replaceDocument(async (current) => {
      // The options travel through the shared rule rather than being spelled
      // here: a host-supplied engine that never saw `presetBatchOptions`
      // answers such a batch with no readable report, which the reader below
      // then refuses as an unknowable outcome.
      const styled = await engine.edit(current, batch, presetBatchOptions(batch, { verify: true }));
      const reading = readPresetBatch(styled.report);
      // The transports refuse this themselves; a host that supplies its own
      // engine may not, and the caller here is the one that knows the batch is
      // a preset batch.
      if (reading.refusal !== null) {
        throw new HwpEngineError(reading.refusal.code, reading.refusal.message);
      }
      unstyled = reading.unstyledTable;
      changed = !reading.unchanged;
      return reading.unchanged ? current : styled;
    })
      .then((applied) => {
        // Only when this attempt still owns the document: an unchanged switch
        // leaves the one it started from, and a result a load superseded says
        // nothing about the document now on screen.
        if (!applied && store.getState().document !== before) return;
        // A switch that did style something, on a document that has a table
        // to style, is the quiet outcome: the tables moved.
        if (changed && !unstyled) return;
        // Every other answer says something, chosen from what the batch
        // carried: with no paragraph style in the document there was no style
        // change to apply, so a sentence about the body style already matching
        // would describe a write the batch never sent.
        noteNotice(
          changed
            ? t("styles.noTableToStyle")
            : unstyled
              ? t(carriedStyleOp ? "styles.noTableToStyleNoChange" : "styles.noBodyStyleToUpdate")
              : t("styles.presetUnchanged"),
        );
      })
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
        <DefinitionForm
          key={`${paragraphRow.id}:${JSON.stringify(paragraphRow.attrs)}`}
          row={paragraphRow}
          paragraphs={paragraphs}
          disabled={disabled}
        />
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
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || styles === null || state.pendingOps.length > 0}
            onClick={switchPreset}
          >
            {t("styles.presetSubmit")}
          </button>
        </div>
        {state.pendingOps.length > 0 && <p className="hwped-hint">{t("styles.pendingEdits")}</p>}
      </div>
    </div>
  );
}
