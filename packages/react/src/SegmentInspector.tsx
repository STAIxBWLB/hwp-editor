import { isPlainDecimal } from "./unit-input.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { JSX } from "react";
import type { ParagraphAlignment, ParaShapeKey, SelectionRefusal, Segment } from "@hwp-editor/core";
import { compareSegments, documentFormat, formatTargets as collectFormatTargets, hasDirectFormatting, hasOwnRef, isSectionDefinitionParagraph, paragraphAddress, paragraphRuns, resolveSelection, segmentAtRef, segmentPath, segmentRef, segmentText, selectSimilar, selectedParagraphs, selectionAction, stylesVersionSupported } from "@hwp-editor/core";
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
  const { state, store, envelope, editable, capabilities, styles, stylesStatus, t } = useHwpEditorContext();
  const { selection } = state;

  const paragraphKeys = new Set<string>();
  // Path order, not envelope order: a v2 point paragraph is emitted after the
  // ranges that start at its own offset.
  const paragraphs = (envelope?.segments.filter(candidate => {
    if (candidate.kind !== "para") return false;
    // A nested paragraph with no id of its own would be offered under a ref
    // that names its host, so a click would select the host and an op would
    // edit it.
    if (!hasOwnRef(candidate)) return false;
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
  /**
   * The row describing the style this paragraph inherits. `styles-v1` publishes
   * each row's name and the segment ids that use it (`used_by`), which is the
   * only join this host offers: the segment's `style` level carries the
   * resolved attributes and shape ids, never the style's own name. The row is
   * kept whole because the op addresses it by id — a styles-v1 name can be
   * empty or shared between two rows, while the id is the row.
   */
  const directStyleRow = (() => {
    const id = singleParagraph?.id;
    if (id === undefined || styles === null) return undefined;
    return styles.styles.find((item) => item.kind === "paragraph" && item.used_by.includes(id));
  })();
  /**
   * Why there is no name to clear with, when there is none. A table still on
   * its way, one that failed to read, a host that advertises the command and
   * has no engine method for it, an engine below the styles floor, a host
   * still being asked, and a table that simply does not list this paragraph
   * are six different situations with six different remedies, and telling the
   * user the engine "does not publish" the name is wrong for most of them.
   */
  const directStyleWhy: MessageKey | null = directStyleRow !== undefined ? null
    : stylesStatus === "loading" ? "segment.directStyleLoading"
    : stylesStatus === "failed" ? "segment.directStyleFailed"
    : stylesStatus === "unsupported" ? "styles.unavailableHost"
    : capabilities === null ? "styles.checkingHost"
    : capabilities.styles !== "v1"
      ? (stylesVersionSupported(capabilities.version) ? "styles.unavailableHost" : "segment.directStyleUnavailable")
    : "segment.directStyleUnknown";
  // One reason vocabulary serves both the current selection and a refused
  // click, so a segment kind names its own obstacle either way.
  const refusalText = (reason: SelectionRefusal | null | undefined): string | null =>
    reason === null || reason === undefined ? null
      : reason === "cell" ? t("segment.cellSelectionRefused")
      : reason === "table" ? t("segment.tableSelectionRefused")
      : reason === "container" ? t("segment.containerSelectionRefused")
      : t("segment.noParagraphSelection");
  /**
   * A refused click, worded as the click it was.
   *
   * The sentences above say what the SELECTION is, so reusing one for a click
   * answered the wrong question - and a click whose reason matched the
   * primary's was dropped from the list entirely, which left a cell primary
   * plus Ctrl on an empty cell saying nothing at all. The two reports are now
   * separate sentences, and the click's is never suppressed (#58 item 19b).
   */
  const clickRefusedText = (reason: SelectionRefusal | null | undefined): string | null =>
    reason === null || reason === undefined ? null
      : reason === "cell" ? t("segment.clickRefusedCell")
      : reason === "table" ? t("segment.clickRefusedTable")
      : reason === "container" ? t("segment.clickRefusedContainer")
      : t("segment.clickRefusedUnaddressable");
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
  /**
   * A range whose edge fell inside a surrogate pair.
   *
   * The textarea reports UTF-16 offsets, and half a pair has no scalar to
   * address, so the selection cannot be placed at all: a state of its own,
   * because the sentence that says "select inside one run" describes a
   * different mistake.
   */
  const [rangeSplit, setRangeSplit] = useState(false);
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
  const [placeholderName, setPlaceholderName] = useState("");

  // Reset drafts when the selection moves.
  useEffect(() => {
    setRangeSplit(false);
    setReplaceWith("");
    setInsertText("");
    setBold(false);
    setFontSize("");
    setColor("");
    setShapeValue("");
    setLinkUrl("");
    setLinkText("");
    setPlaceholderName("");
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
  /**
   * The paragraph run a multi-selection covers, in document order, or null
   * when the selection is not a set of paragraphs. A component that inserts
   * several paragraphs leaves exactly this: its paragraphs are the selection,
   * and moving or deleting it has to act on the run rather than on one
   * paragraph of it.
   */
  const paragraphRun = multiSelection && explicitSegments.every(item => item.kind === "para")
    ? [...explicitSegments].sort(compareSegments)
    : null;
  /**
   * Contiguity is what makes one move or one delete mean something: the run's
   * members must be the next siblings of one another, or the op would act on a
   * set the user did not select. Same section, same parent path, no gaps.
   */
  const runStart = paragraphRun === null ? -1 : siblings.findIndex(candidate => candidate.id === paragraphRun[0]?.id);
  const runContiguous = paragraphRun !== null && runStart >= 0 &&
    paragraphRun.every((item, at) => siblings[runStart + at]?.id === item.id);
  const runEnd = runContiguous ? runStart + paragraphRun!.length - 1 : -1;
  const textSelectionRestricted = multiSelection || hasRunSelection || state.range != null;
  const singleTargetDisabled = disabled || textSelectionRestricted || address === undefined;
  // Delete and move serve one paragraph, or a contiguous run of them; every
  // other multi-selection keeps them off and says why.
  const reorderRefused = multiSelection && !runContiguous;
  /**
   * A section's definition paragraph is a fixed point: the engine will not move
   * it, will not delete it, and will not move anything above it either. All
   * three are needed, because the move of a neighbour is expressed as that
   * neighbour's address — moving paragraph 1 up addresses paragraph 0, and
   * moving a run at 1..n up addresses it too.
   */
  const definitionLocked = paragraphRun === null
    ? singleParagraph !== undefined && isSectionDefinitionParagraph(singleParagraph)
    : paragraphRun.some(isSectionDefinitionParagraph);
  const moveUpNeighbour = siblings[(paragraphRun === null ? siblingAt : runStart) - 1];
  const definitionAbove = moveUpNeighbour !== undefined && isSectionDefinitionParagraph(moveUpNeighbour);
  const deleteDisabled = disabled || definitionLocked ||
    (paragraphRun === null ? textSelectionRestricted || address === undefined : !runContiguous);
  const moveUpDisabled = deleteDisabled || definitionAbove ||
    (paragraphRun === null ? siblingAt <= 0 : runStart <= 0);
  const moveDownDisabled = deleteDisabled ||
    (paragraphRun === null ? siblingAt < 0 || siblingAt >= siblings.length - 1 : runEnd >= siblings.length - 1);
  const anchorDisabled = !editable || state.status === "applying" || textSelectionRestricted;
  const legacyLinkSeparator = capabilities?.editOps !== "v1" && [currentText, linkText, linkUrl].some(value => value.includes("=>"));
  const validShape = isPlainDecimal(shapeValue) && (shapeKey !== "line-spacing" || Number(shapeValue) > 0);
  const validFontSize = fontSize.trim() === "" || (isPlainDecimal(fontSize) && Number(fontSize) > 0);
  // The state keeps the primary first; the ops read in document order.
  const formatInputs = envelope === null ? [] : explicitSegments.flatMap(item =>
    item.kind === "run" ? [item] : resolveSelection(envelope, item).paragraphs).sort(compareSegments);
  // The format decides the one place the two coordinate spaces may differ by a
  // character (an HWP5 paragraph break), so it comes from the document handle
  // and never from the numbers: an HWPX last piece whose edge space was
  // trimmed publishes the same span an HWP5 break does.
  const formatTargets = envelope === null ? [] : collectFormatTargets(envelope, formatInputs, state.range, documentFormat(state.document?.name, state.document?.data));
  const runs = envelope === null || singleParagraph === undefined ? [] : paragraphRuns(envelope, singleParagraph);
  /**
   * The whole-paragraph format this host cannot address.
   *
   * The envelope publishes no run for the paragraph and no nesting path
   * either, so `formatTargets` has nothing to name: `edit-ops-v1` addresses
   * character format per run, and `run: 0` would format one run of a
   * paragraph the panel promised whole. A v2 paragraph without immediate runs
   * is refused the same way, so the reason has to be said rather than left as
   * a dead button (#58 item 19e). An empty paragraph is not this case: it has
   * no runs to publish, and its own sentence already names the whole
   * paragraph, so the length check keeps it out (t71-2).
   */
  const formatNoRuns = state.range == null && singleParagraph !== undefined &&
    singleParagraph.start !== singleParagraph.end && singleParagraph.indices === undefined && runs.length === 0;
  const rangeAvailable = !multiSelection && runs.some(run => run.id !== undefined || (singleParagraph?.indices?.length === 1 && run.indices?.length === 2));
  const charPrimary = segment?.kind === "run" ? segment
    : envelope !== null && state.range != null && formatTargets[0]?.address.id !== undefined
      ? segmentAtRef(envelope, { id: formatTargets[0].address.id, section: 0, para: 0 }) ?? singleParagraph
      : singleParagraph;

  /**
   * Whether the selected runs can become a `{{name}}` placeholder.
   *
   * `replace` matches the paragraph's own DOCUMENT text and rewrites every
   * match there, and edit-ops-v1 addresses it by paragraph alone, so the find
   * string is the only selector it has. The client cannot rebuild that text
   * from Markdown in general: the projection trims each fragment, joins what a
   * control held, escapes `&` and `<` inside a cell, and renders emphasis,
   * links and fields to something other than the text the engine matches. So
   * this is an ALLOW list. A paragraph qualifies only when the projection is
   * the identity on it and nothing in it can hide or move a match; refusing a
   * paragraph that would have worked is the accepted cost of never rewriting
   * text the user did not select.
   */
  const plainParagraph = ((): { runs: Segment[]; texts: string[]; text: string } | undefined => {
    if (envelope === null || singleParagraph === undefined) return undefined;
    // (1) A top-level body paragraph. A cell and a text box report a deeper
    // path (and a container holding this range), and a list's projected
    // lead-in is not text, so all three are out.
    const depth = singleParagraph.indices?.length;
    if (depth !== undefined && depth !== 1) return undefined;
    const inContainer = envelope.segments.some(item =>
      (item.kind === "table" || item.kind === "cell") &&
      item.start <= singleParagraph.start && item.end >= singleParagraph.end);
    if (inContainer) return undefined;
    // The paragraph's projection ends with its separator, which is structure.
    const points = [...markdownText.replace(/[\r\n]+$/, "")];
    const contentEnd = singleParagraph.start + points.length;
    // A field, image or bookmark here holds text of its own, and an edit
    // addressed to this paragraph can write over it: out.
    const holdsControl = envelope.segments.some(item =>
      (item.kind === "field" || item.kind === "image" || item.kind === "bookmark") &&
      item.start < contentEnd && item.end > singleParagraph.start);
    if (holdsControl) return undefined;
    // The runs must tile the paragraph exactly. A gap is text the projection
    // does not show, so a find cut from it would not be the engine's text.
    const ordered = paragraphRuns(envelope, singleParagraph);
    let cursor = singleParagraph.start;
    for (const run of ordered) {
      if (run.start !== cursor || run.end < run.start || run.end > contentEnd) return undefined;
      cursor = run.end;
    }
    if (ordered.length === 0 || cursor !== contentEnd) return undefined;
    const slices = ordered.map(run =>
      points.slice(run.start - singleParagraph.start, run.end - singleParagraph.start).join(""));
    const texts = runTexts(ordered, slices);
    if (texts === undefined) return undefined;
    // (2) Plain text only. The characters below are the ones the projection
    // writes as themselves; everything Markdown gives a second meaning to is
    // refused, and so is a doubled space, which a collapsed fragment cannot be
    // told apart from. An edge space is allowed: the find is trimmed to the
    // selection's non-space core (see below), and a match that starts and
    // ends on a non-space can never span a space the projection trimmed away.
    const text = texts.join("");
    if (text.trim() === "" || text.includes("  ")) return undefined;
    if (!/^[\p{L}\p{N} .,:;'"!?()\-]*$/u.test(text)) return undefined;
    if (/^(?:[-+]|\d{1,3}[.)])\s/u.test(text)) return undefined;
    return { runs: ordered, texts, text };
  })();
  const rangeRuns = envelope !== null && singleParagraph !== undefined && state.range != null
    ? paragraphRuns(envelope, singleParagraph, state.range)
    : [];
  const rangeFrom = rangeRuns.length === 0 ? -1 : Math.min(...rangeRuns.map(item => item.start));
  const rangeTo = rangeRuns.length === 0 ? -1 : Math.max(...rangeRuns.map(item => item.end));
  const wholeRuns = state.range != null && rangeRuns.length > 0 &&
    rangeFrom === state.range.start && rangeTo === state.range.end;
  const firstCoveredAt = plainParagraph === undefined || rangeRuns.length === 0
    ? -1
    : plainParagraph.runs.findIndex(item => item.start === rangeRuns[0]!.start);
  const rangeContiguous = plainParagraph !== undefined && firstCoveredAt >= 0 &&
    rangeRuns.every((item, at) => plainParagraph.runs[firstCoveredAt + at]?.start === item.start);
  // `find` is the engine's text for the selected runs, which (2) has already
  // made identical to their projection.
  const coveredText = plainParagraph === undefined || !wholeRuns || !rangeContiguous
    ? ""
    : plainParagraph.texts.slice(firstCoveredAt, firstCoveredAt + rangeRuns.length).join("");
  // (3) The selection's edge spaces stay in the paragraph: the slot replaces
  // the non-space core, so the words beside it keep their separator and a
  // space at the paragraph's edge is not left orphaned inside the find.
  const findText = coveredText.trim();
  const leadingSpace = coveredText.length - coveredText.trimStart().length;
  const paragraphText = plainParagraph?.text ?? "";
  const expectedAt = leadingSpace + (plainParagraph === undefined || firstCoveredAt <= 0
    ? 0
    : plainParagraph.texts.slice(0, firstCoveredAt).reduce((total, item) => total + item.length, 0));
  // (4) Exactly one match counting overlaps, starting where the selection's
  // core starts: a single match elsewhere would rewrite text never selected.
  const occurrences: number[] = [];
  for (let at = 0; findText !== "" && at + findText.length <= paragraphText.length; at += 1) {
    if (paragraphText.startsWith(findText, at)) occurrences.push(at);
  }
  const uniqueAtSelection = occurrences.length === 1 && occurrences[0] === expectedAt;
  // (5) Any queued op can change this document's text — a `set-field` writes its
  // value into a paragraph, a `set-cell` replaces a cell's — so the control
  // waits for an empty queue rather than for one class of op.
  const queuedEdits = state.pendingOps.length > 0;
  const placeholderRefused = plainParagraph === undefined || !wholeRuns || !rangeContiguous ||
    findText === "" || !uniqueAtSelection || queuedEdits;

  const placeholderNameTrimmed = placeholderName.trim();
  const placeholderNameEmpty = placeholderNameTrimmed === "";
  const placeholderNameValid = !placeholderNameEmpty &&
    !/[{}]/.test(placeholderNameTrimmed) && !/[\u0000-\u001f\u007f-\u009f]/.test(placeholderNameTrimmed);
  const placeholderReason = placeholderRefused ? t("segment.placeholderRefused") : "";
  const placeholderNameReason = placeholderNameEmpty
    ? t("segment.placeholderNameEmpty")
    : placeholderNameValid ? "" : t("segment.placeholderNameInvalid");
  const placeholderDisabled = disabled || address === undefined ||
    placeholderReason !== "" || placeholderNameReason !== "";

  const makePlaceholder = (): void => {
    if (placeholderDisabled || address === undefined) return;
    store.dispatch({
      type: "queueOp",
      op: { kind: "replace", address, find: findText, replace: `{{${placeholderNameTrimmed}}}` },
    });
  };

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

  /**
   * Move up / down: one paragraph swaps with its neighbour, while a run of
   * them moves as a block — the neighbour is the paragraph that moves, across
   * the whole run, which keeps the run intact and one apply one undo.
   */
  const moveParagraph = (direction: -1 | 1): void => {
    if (paragraphRun === null) {
      const neighbour = siblings[direction === -1 ? siblingAt - 1 : siblingAt + 1];
      if (address === undefined || neighbour === undefined) return;
      store.dispatch({
        type: "queueOp",
        op: {
          kind: "move-para",
          address,
          to: { address: paragraphAddress(neighbour), position: direction === -1 ? "before" : "after" },
        },
      });
      return;
    }
    if (!runContiguous) return;
    const neighbour = siblings[direction === -1 ? runStart - 1 : runEnd + 1];
    const anchor = direction === -1 ? paragraphRun[paragraphRun.length - 1] : paragraphRun[0];
    if (neighbour === undefined || anchor === undefined) return;
    store.dispatch({
      type: "queueOp",
      op: {
        kind: "move-para",
        address: paragraphAddress(neighbour),
        to: { address: paragraphAddress(anchor), position: direction === -1 ? "after" : "before" },
      },
    });
  };

  /**
   * Delete: one addressed `delete-para` for the paragraph, or one per
   * paragraph of the run in a single queue action, so the batch is one engine
   * call and one undo. The engine resolves every address against the document
   * it loaded, so a batch of addresses is safe.
   */
  const deleteParagraphs = (): void => {
    if (paragraphRun === null) {
      if (address !== undefined) store.dispatch({ type: "queueOp", op: { kind: "delete-para", address } });
      return;
    }
    if (!runContiguous) return;
    store.dispatch({
      type: "queueOps",
      ops: paragraphRun.map(item => ({ kind: "delete-para" as const, address: paragraphAddress(item) })),
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
         // alone, and reports the click here whatever the selection's own
         // reason is: the reader's action is what was refused, and a click
         // that shares the primary's obstacle is still a click that did
         // nothing (#58 item 19b).
        state.selectionRefusal != null &&
          <p className="hwped-hint" role="status">{clickRefusedText(state.selectionRefusal)}</p>}
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
            // hwp-cli 1.6.0+ refuses an insert before the section definition
            // paragraph (agent-hwp#451), the same fixed point move and delete honour.
            disabled={singleTargetDisabled || definitionLocked || insertText === ""}
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
            disabled={moveUpDisabled}
            onClick={() => moveParagraph(-1)}
          >
            {t("segment.moveUp")}
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={moveDownDisabled}
            onClick={() => moveParagraph(1)}
          >
            {t("segment.moveDown")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-danger"
            disabled={deleteDisabled}
            onClick={deleteParagraphs}
          >
            {t("segment.deletePara")}
          </button>
        </div>
        {reorderRefused && <p className="hwped-hint" role="status">{t("segment.multiReorderRefused")}</p>}
        {(definitionLocked || definitionAbove) && !reorderRefused && (
          <p className="hwped-hint" role="status">{t("segment.sectionDefinitionLocked")}</p>
        )}
      </div>

      <div className="hwped-field">
        <span className="hwped-label">{t("segment.alignLabel")}</span>
        {// A run-level selection formats runs, but these two controls act on
         // the paragraphs that hold them, so the count is the reach of the
         // press below - not the number of runs the hint above counted.
        hasRunSelection && (
          <p className="hwped-hint" role="status">
            {t("segment.runSelectionParagraphs", { count: selected.length })}
          </p>
        )}
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
      {singleParagraph !== undefined && hasDirectFormatting(singleParagraph) && <div className="hwped-field">
        <span className="hwped-label">{t("segment.directFormatting")}</span>
        <p className="hwped-hint">{t("segment.directFormattingHint")}</p>
        {directStyleRow === undefined
          // The style comes from `styles-v1`'s `used_by` join, which is the
          // only place this host publishes it: without it there is no row to
          // pass to `apply_style`, and inventing one would rewrite the
          // paragraph into some other style instead of clearing its overrides.
          ? <p className="hwped-hint">{t(directStyleWhy ?? "segment.directStyleUnknown")}</p>
          : <button type="button" className="hwped-btn" disabled={disabled}
              onClick={() => store.dispatch({ type: "queueOp", op: { kind: "apply-style", address: paragraphAddress(singleParagraph), style: directStyleRow.id, clearDirect: true } })}>
              {t("segment.clearDirect")}
            </button>}
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
            if (start === undefined || end === undefined) { setRangeSplit(true); return; }
            setRangeSplit(false);
            store.dispatch({ type: "setRange", range: start === end ? null : {
              paragraph: segmentRef(singleParagraph), start: singleParagraph.start + start, end: singleParagraph.start + end,
            } });
          }} />
        {/* Two causes, two sentences: a selection edge inside a surrogate
            pair cannot be placed on a character boundary at all, while one
            that lands on characters and covers none of a run is a selection
            the user can widen. */}
        {rangeSplit && <p role="alert" className="hwped-hint">{t("segment.rangeSplit")}</p>}
        {state.range != null && formatTargets.length === 0 && <p role="alert" className="hwped-hint">{t("segment.rangeInvalid")}</p>}
        {state.range != null && <>
          {formatTargets.length > 0 &&
            <p className="hwped-hint" role="status">{t("segment.rangeRunCount", { count: formatTargets.length })}</p>}
          {/* A target the range was widened to formats the whole run, and the
              coverage answer says so: a split run emits every piece with its
              own window, so the op shape cannot tell the two apart. A range
              that covers the piece whole widens nothing, so it is not counted
              here - the reader is warned about characters the selection did
              not reach, and there are none. */}
          {formatTargets.some(target => target.widened) &&
            <p className="hwped-hint">{t("segment.rangeWholeRunTargets",
              { count: formatTargets.filter(target => target.widened).length })}</p>}
          <button type="button" className="hwped-btn" onClick={() => {
            setRangeSplit(false); rangeInput.current?.setSelectionRange(0, 0);
            if (hasRunSelection) store.dispatch({ type: "select", selection: segmentRef(singleParagraph) });
            else store.dispatch({ type: "setRange", range: null });
          }}>{t("segment.rangeClear")}</button>
        </>}
      </div>}
      {singleParagraph !== undefined && <div className="hwped-field">
        <span className="hwped-label">{t("segment.placeholderLabel")}</span>
        <p className="hwped-hint">{t("segment.placeholderHint")}</p>
        <input className="hwped-input" type="text" value={placeholderName} disabled={disabled}
          placeholder={t("segment.placeholderNamePlaceholder")} aria-label={t("segment.placeholderNameAria")}
          onChange={(e) => setPlaceholderName(e.target.value)} />
        <button type="button" className="hwped-btn" disabled={placeholderDisabled} onClick={makePlaceholder}>
          {t("segment.placeholderCreate")}
        </button>
        {placeholderReason !== "" && <p className="hwped-hint" role="status">{placeholderReason}</p>}
        {placeholderReason === "" && placeholderNameReason !== "" &&
          <p role="alert" className="hwped-hint">{placeholderNameReason}</p>}
      </div>}
      <div className="hwped-field">
        <span className="hwped-label">{t("segment.formatLabel")}</span>
        <p className="hwped-hint">{t("segment.formatRunCount", { count: formatTargets.length })}</p>
        {formatNoRuns && <p className="hwped-hint" role="status">{t("segment.formatUnavailableNoRuns")}</p>}
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
              disabled || rangeSplit || !validFontSize || formatTargets.length === 0 ||
              (!bold && fontSize.trim() === "" && color === "")
            }
            onClick={() => {
              const props: Record<string, string> = {};
              if (bold) props["bold"] = "on";
              if (fontSize.trim() !== "") props["size"] = fontSize.trim();
              if (color !== "") props["color"] = color;
              store.dispatch({ type: "queueOps", ops: formatTargets.map((target) => ({ kind: "set-format" as const, address: target.address, props })) });
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

/**
 * The engine text of each run, or undefined when any run's projection cannot
 * be vouched for.
 *
 * hwp-cli opens a span only when the marks change, so every maximal sequence
 * of runs with the same bold/italic pair (runs that differ only in colour,
 * size or face) projects under ONE `**...**` or `*...*`, and close_span moves
 * the span's edge spaces outside the markers. So each such group must read,
 * as a whole, as optional spaces, the marker, a non-empty core, the marker,
 * optional spaces; the four marker positions are then cut out of whichever
 * runs hold them. A plain group carries no markers and each run is read on
 * its own. Bold and italic together, or a missing directChar, refuse.
 */
function runTexts(runs: Segment[], slices: string[]): string[] | undefined {
  const texts: string[] = [];
  for (let at = 0; at < runs.length;) {
    const first = runs[at]!.directChar;
    if (first === undefined) return undefined;
    let end = at;
    while (end + 1 < runs.length) {
      const next = runs[end + 1]!.directChar;
      if (next === undefined) return undefined;
      if (next.bold !== first.bold || next.italic !== first.italic) break;
      end += 1;
    }
    if (!first.bold && !first.italic) {
      for (let inner = at; inner <= end; inner += 1) {
        const plain = wholeRunText(runs[inner]!, slices[inner]!);
        if (plain === undefined) return undefined;
        texts.push(plain);
      }
    } else {
      if (first.bold && first.italic) return undefined;
      const marker = first.bold ? "**" : "*";
      const points = [...slices.slice(at, end + 1).join("")];
      const joined = points.join("");
      const lead = joined.length - joined.trimStart().length;
      const trail = joined.length - joined.trimEnd().length;
      const core = joined.slice(lead, joined.length - trail);
      const m = marker.length;
      if (core.length <= 2 * m || !core.startsWith(marker) || !core.endsWith(marker)) return undefined;
      // A bold core opening with a third `*` would be read as italic inside
      // bold, and an italic core opening with `*` as bold: refuse both.
      const inner = core.slice(m, core.length - m);
      if (inner.startsWith("*") || inner.endsWith("*") || inner.trim() !== inner) return undefined;
      // Spaces and markers are ASCII, so code-unit offsets equal point offsets
      // at the edges; the cut set is in point offsets over `points`.
      const leadPoints = [...joined.slice(0, lead)].length;
      const trailPoints = [...joined.slice(joined.length - trail)].length;
      const cut = new Set<number>();
      for (let k = 0; k < m; k += 1) {
        cut.add(leadPoints + k);
        cut.add(points.length - trailPoints - 1 - k);
      }
      let offset = 0;
      for (let inner = at; inner <= end; inner += 1) {
        const own = [...slices[inner]!];
        texts.push(own.filter((_, k) => !cut.has(offset + k)).join(""));
        offset += own.length;
      }
    }
    at = end + 1;
  }
  return texts;
}

/**
 * One run's document text, or undefined when its markers cannot be trusted.
 *
 * hwp-cli wraps a whole run in `**` when it is bold and `*` when it is italic,
 * and it does not escape a literal `*`, so a run whose text is literally
 * `*Note*` projects exactly like an italic one. The run's own published
 * `directChar` is what tells them apart: a marker is stripped only when the
 * formatting says it is one, and any disagreement — or a missing `directChar`,
 * which an older host may omit — refuses the paragraph.
 */
function wholeRunText(run: Segment, markdown: string): string | undefined {
  const bold = /^\*\*([\s\S]+)\*\*$/u.exec(markdown);
  const italic = bold === null ? /^\*([\s\S]+)\*$/u.exec(markdown) : null;
  const direct = run.directChar;
  if (direct === undefined) return undefined;
  if (bold !== null) return direct.bold && !direct.italic ? bold[1]! : undefined;
  if (italic !== null) return direct.italic && !direct.bold ? italic[1]! : undefined;
  // No marker, so the run has to be plain: a bold or italic run carries one.
  return direct.bold || direct.italic ? undefined : markdown;
}
