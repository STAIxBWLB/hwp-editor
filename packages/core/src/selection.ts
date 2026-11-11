import type { EditAddress, ParagraphAddress } from "./ops.js";
import type { CatEnvelope, Segment, SegmentRef } from "./segments.js";
import { markdownLength, segmentRef } from "./segments.js";
import type { EditorAction, EditorState, MarkdownRangeSelection } from "./state.js";

function segmentKey(segment: Segment): string {
  if (segment.id !== undefined) return `id:${segment.id}`;
  if (segment.indices !== undefined) return `${segment.section}:${segment.indices.join("/")}`;
  return `${segment.section}:${segment.para}`;
}

function uniqueSegments(segments: Segment[]): Segment[] {
  const seen = new Set<string>();
  return segments.filter((segment) => {
    const key = segmentKey(segment);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Why a selection has no single paragraph target of its own. */
export type SelectionRefusal = "table" | "cell" | "container" | "unaddressable";

export interface SelectionTargets {
  /** Paragraphs the selection covers, in envelope order; empty when it covers none. */
  paragraphs: Segment[];
  /** The one paragraph a single-target op (replace, insert, delete) may address. */
  paragraph: Segment | undefined;
  /** Why the single-target ops are off, or null when `paragraph` is set. */
  refusal: SelectionRefusal | null;
}

/**
 * Map a selected segment to the paragraphs an op may address.
 *
 * Every kind is mapped explicitly, because guessing is destructive: a table
 * and a cell sit inside a host paragraph whose range covers the whole table,
 * so aiming a paragraph op at that host edits or deletes the table itself.
 * Nothing here falls back to an enclosing paragraph.
 *
 * - para: itself.
 * - run: the paragraph that directly holds it.
 * - cell: every paragraph inside the cell, since align, spacing and character
 *   format apply to all of them, but no single target: replace, insert and
 *   delete address one paragraph, and the engine refuses to delete a cell's
 *   last one. An empty cell has no paragraph at all.
 * - table, image, field, bookmark: no paragraph target. Any text they touch
 *   belongs to the host paragraph they share with the table control.
 * - a segment with no nesting path (an older projection) that is not a cell:
 *   the id-less paragraph whose range covers it, which is the only coordinate
 *   that projection offers.
 */
export function resolveSelection(envelope: CatEnvelope, segment: Segment): SelectionTargets {
  const refuse = (refusal: SelectionRefusal): SelectionTargets => ({ paragraphs: [], paragraph: undefined, refusal });
  const only = (paragraph: Segment | undefined): SelectionTargets => paragraph === undefined
    ? refuse("unaddressable")
    : { paragraphs: [paragraph], paragraph, refusal: null };
  if (segment.kind === "para") return only(segment);
  if (segment.kind === "table") return refuse("table");
  if (segment.kind === "image" || segment.kind === "field" || segment.kind === "bookmark") return refuse("container");
  const indices = segment.indices;
  if (indices === undefined) {
    if (segment.kind === "cell") return refuse("cell");
    return only(envelope.segments.find((candidate) => candidate.kind === "para" && candidate.indices === undefined &&
      candidate.section === segment.section && candidate.para === segment.para &&
      candidate.start <= segment.start && candidate.end >= segment.end));
  }
  if (segment.kind === "cell") {
    const paragraphs = envelope.segments.filter((candidate) => candidate.kind === "para" &&
      candidate.section === segment.section && candidate.indices !== undefined &&
      candidate.indices.length === indices.length + 1 &&
      indices.every((index, at) => candidate.indices![at] === index));
    return paragraphs.length === 0 ? refuse("cell") : { paragraphs, paragraph: undefined, refusal: "cell" };
  }
  // Only a run is left: the paragraph one level up holds its text.
  return only(envelope.segments.find((candidate) => candidate.kind === "para" &&
    candidate.section === segment.section && candidate.indices !== undefined &&
    candidate.indices.length === indices.length - 1 &&
    candidate.indices.every((index, at) => index === indices[at])));
}

/** Full nesting path of a segment, the identity a label must name: `<section>/<indices>`. */
export function segmentPath(segment: Segment): string {
  return `${segment.section}/${segment.indices?.join(".") ?? segment.para}`;
}

/**
 * Document order, taken from `path`, never from envelope position.
 *
 * segment-envelope-v2 does not promise an ordered segment list, and a point
 * paragraph (`start === end`) is emitted after the ranges that start at the
 * same offset, so envelope order puts it after a paragraph that follows it.
 * Sorting by section and then by `indices` lexicographically is the order the
 * contract defines; a legacy projection without indices falls back to `para`.
 */
export function compareSegments(a: Segment, b: Segment): number {
  if (a.section !== b.section) return a.section - b.section;
  const left = a.indices ?? [a.para];
  const right = b.indices ?? [b.para];
  for (let at = 0; at < Math.min(left.length, right.length); at++) {
    if (left[at] !== right[at]) return left[at]! - right[at]!;
  }
  return left.length - right.length;
}

function segmentForRef(envelope: CatEnvelope, ref: SegmentRef): Segment | undefined {
  return envelope.segments.find((candidate) => ref.id !== undefined
    ? candidate.id === ref.id
    : candidate.section === ref.section && candidate.para === ref.para);
}

export function selectedParagraphs(envelope: CatEnvelope, state: EditorState): Segment[] {
  const refs = state.selections?.length ? state.selections : state.selection ? [state.selection] : [];
  const paragraphs = refs.flatMap((ref) => {
    const segment = segmentForRef(envelope, ref);
    return segment === undefined ? [] : resolveSelection(envelope, segment).paragraphs;
  });
  return uniqueSegments(paragraphs).sort(compareSegments);
}

export function paragraphAddress(segment: Segment): ParagraphAddress {
  return segment.id === undefined
    ? { at: { section: segment.section, paragraph: segment.para } }
    : { id: segment.id };
}

export function paragraphRuns(envelope: CatEnvelope, paragraph: Segment, range?: MarkdownRangeSelection | null): Segment[] {
  if (range !== undefined && range !== null) {
    const matches = range.paragraph.id !== undefined
      ? range.paragraph.id === paragraph.id
      : range.paragraph.section === paragraph.section && range.paragraph.para === paragraph.para;
    if (!matches || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < paragraph.start ||
        range.end > markdownLength(envelope) ||
        range.end > paragraph.end || range.start >= range.end) return [];
  }
  return envelope.segments.filter((run) => {
    if (run.kind !== "run" || run.section !== paragraph.section || run.para !== paragraph.para) return false;
    const immediate = paragraph.indices === undefined
      ? run.start >= paragraph.start && run.end <= paragraph.end
      : run.indices !== undefined && run.indices.length === paragraph.indices.length + 1 &&
        paragraph.indices.every((index, at) => run.indices![at] === index);
    if (!immediate) return false;
    return range === undefined || range === null || (run.start < range.end && run.end > range.start);
  });
}

export function formatAddresses(
  envelope: CatEnvelope,
  paragraphs: readonly Segment[],
  range?: MarkdownRangeSelection | null,
): EditAddress[] {
  if (range !== undefined && range !== null) {
    if (paragraphs.length !== 1 || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
        range.start < 0 || range.start >= range.end || range.end > markdownLength(envelope)) return [];
    const paragraph = resolveSelection(envelope, paragraphs[0]!).paragraph;
    if (paragraph === undefined) return [];
    const matches = range.paragraph.id !== undefined
      ? paragraph.id === range.paragraph.id
      : paragraph.section === range.paragraph.section && paragraph.para === range.paragraph.para;
    if (!matches || range.start < paragraph.start || range.end > paragraph.end) return [];
    return addressesForRuns(envelope, paragraphRuns(envelope, paragraph, range), paragraph, false);
  }
  const out: EditAddress[] = [];
  const targets = new Set<string>();
  for (const selected of paragraphs) {
    if (selected.kind === "run") {
      const address = addressForSelectedRun(envelope, selected);
      if (address === undefined) continue;
      const key = addressKey(address);
      if (!targets.has(key)) { targets.add(key); out.push(address); }
      continue;
    }
    if (selected.kind !== "para") continue;
    const paragraph = selected;
    for (const address of addressesForRuns(envelope, paragraphRuns(envelope, paragraph), paragraph, true)) {
      const key = addressKey(address);
      if (targets.has(key)) continue;
      targets.add(key);
      out.push(address);
    }
  }
  return out;
}

function addressForSelectedRun(envelope: CatEnvelope, run: Segment): EditAddress | undefined {
  if (run.id !== undefined) return { id: run.id };
  const paragraph = resolveSelection(envelope, run).paragraph;
  if (paragraph === undefined) return undefined;
  if (paragraph.indices === undefined && run.indices === undefined) {
    const siblings = paragraphRuns(envelope, paragraph);
    if (!siblings.every((sibling) => sibling.indices === undefined)) return undefined;
    const ordinal = siblings.indexOf(run);
    return ordinal < 0 ? undefined : { at: { section: run.section, paragraph: run.para, run: ordinal } };
  }
  if (paragraph.indices?.length === 1 && run.indices?.length === 2 &&
      paragraph.indices.every((index, at) => run.indices![at] === index)) {
    return { at: { section: run.section, paragraph: run.para, run: run.indices[1]! } };
  }
  return undefined;
}

function addressesForRuns(envelope: CatEnvelope, runs: Segment[], paragraph: Segment, allowLegacyFallback: boolean): EditAddress[] {
  const out: EditAddress[] = [];
  const targets = new Set<string>();
  const legacyProjection = paragraph.indices === undefined && runs.every((run) => run.indices === undefined);
  // A legacy paragraph carries no run indices, so its runs are addressed by
  // position; `runs` may be only the subset a range overlaps, and the index
  // inside that subset is not the run's position in the paragraph.
  const siblings = legacyProjection ? paragraphRuns(envelope, paragraph) : [];
  for (const run of runs) {
    let address: EditAddress | undefined;
    if (run.id !== undefined) {
      address = { id: run.id };
    } else if (legacyProjection) {
      const ordinal = siblings.indexOf(run);
      address = ordinal < 0 ? undefined : { at: { section: run.section, paragraph: run.para, run: ordinal } };
    } else if (paragraph.indices?.length === 1 && run.indices?.length === 2) {
      address = { at: { section: run.section, paragraph: run.para, run: run.indices[1]! } };
    }
    if (address === undefined) continue;
    const key = addressKey(address);
    if (targets.has(key)) continue;
    targets.add(key);
    out.push(address);
  }
  if (allowLegacyFallback && runs.length === 0 && paragraph.indices === undefined) {
    out.push({ at: { section: paragraph.section, paragraph: paragraph.para, run: 0 } });
  }
  return out;
}

function addressKey(address: EditAddress): string {
  return "id" in address ? `id:${address.id}` : `${address.at.section}:${address.at.paragraph}:${address.at.run}`;
}

/**
 * The units a click contributes to the current selection, at the granularity
 * the selection already has. Paragraph level resolves like an edit target; run
 * level, which matching character format produces, keeps runs as runs so a
 * modifier click never hands the format op a whole paragraph.
 */
function selectionUnits(envelope: CatEnvelope, segment: Segment, runLevel: boolean): Segment[] {
  if (!runLevel) return resolveSelection(envelope, segment).paragraphs;
  if (segment.kind === "run") return [segment];
  return resolveSelection(envelope, segment).paragraphs.flatMap((paragraph) => paragraphRuns(envelope, paragraph));
}

export function selectionAction(
  envelope: CatEnvelope,
  state: EditorState,
  target: Segment,
  mode: "single" | "toggle" | "extend",
): EditorAction {
  if (mode === "single") return { type: "select", selection: segmentRef(target) };
  const refs = state.selections?.length ? state.selections : state.selection ? [state.selection] : [];
  const stored = refs.flatMap((ref) => {
    const segment = segmentForRef(envelope, ref);
    return segment === undefined ? [] : [segment];
  });
  // The selection keeps the granularity it was built with: a run-level
  // selection stays run-level, so extending or toggling it cannot widen to the
  // paragraphs around those runs.
  const runLevel = stored.some((segment) => segment.kind === "run");
  const units = selectionUnits(envelope, target, runLevel);
  // A table, an image, an empty cell: nothing to extend across, and widening
  // to the paragraph that encloses it would select that paragraph's text.
  if (units.length === 0) return { type: "select", selection: segmentRef(target) };
  const anchorRef = state.selectionAnchor ?? (state.selection ? state.selection : segmentRef(units[0]!));
  const anchorSegment = segmentForRef(envelope, anchorRef);
  // An anchor with no unit of its own has nothing to measure a range from, so
  // the range starts at the click instead of throwing.
  const anchorUnits = anchorSegment === undefined ? [] : selectionUnits(envelope, anchorSegment, runLevel);
  const anchor = anchorUnits[0] ?? units[0]!;
  const unitKeys = new Set(units.map(segmentKey));
  let selected: Segment[];
  if (mode === "toggle") {
    // Toggling a cell (or a run) takes its whole content, so align and format
    // reach every unit of it rather than the first one.
    selected = stored.some((segment) => unitKeys.has(segmentKey(segment)))
      ? stored.filter((segment) => !unitKeys.has(segmentKey(segment)))
      : [...stored, ...units];
  } else {
    const ordered = uniqueSegments(envelope.segments.filter((s) => s.kind === (runLevel ? "run" : "para"))).sort(compareSegments);
    const position = new Map(ordered.map((unit, index) => [segmentKey(unit), index]));
    const anchorFirst = position.get(segmentKey(anchor)) ?? -1;
    const anchorLast = position.get(segmentKey(anchorUnits[anchorUnits.length - 1] ?? anchor)) ?? anchorFirst;
    const hitFirst = position.get(segmentKey(units[0]!)) ?? -1;
    const hitLast = position.get(segmentKey(units[units.length - 1]!)) ?? hitFirst;
    const from = anchorFirst < 0 || hitFirst < 0 ? Math.max(anchorFirst, hitFirst) : Math.min(anchorFirst, hitFirst);
    const to = anchorFirst < 0 || hitFirst < 0 ? from : Math.max(anchorLast, hitLast);
    // Both endpoints resolve to units the envelope lists, so this slice is the
    // range; the `-1` arms only keep an unlisted endpoint selecting itself.
    selected = from < 0 ? [anchor, ...units] : ordered.slice(from, to + 1);
  }
  // The state is the source of the refs, but never of their order: it keeps
  // the primary first, and a selection reads in document order.
  const selectionList = uniqueSegments(selected).sort(compareSegments).map(segmentRef);
  const primary = segmentRef(units[0]!);
  return { type: "selectMany", selections: selectionList, primary, anchor: mode === "extend" ? segmentRef(anchor) : anchorRef };
}

export function selectSimilar(envelope: CatEnvelope, primary: Segment, level: "char" | "para"): SegmentRef[] {
  const props = level === "char" ? primary.directChar : primary.directPara;
  if (props === undefined) return [];
  const key = stableStructure(props);
  if (level === "char") {
    const hasRuns = envelope.segments.some((segment) => segment.kind === "run");
    const candidates = hasRuns
      ? envelope.segments.filter((segment) => segment.kind === "run")
      : envelope.segments.filter((segment) => segment.kind === "para");
    return uniqueSegments(candidates.filter((segment) => stableStructure(segment.directChar) === key)).sort(compareSegments).map(segmentRef);
  }
  return uniqueSegments(envelope.segments.filter((segment) => segment.kind === "para" &&
    stableStructure(segment.directPara) === key)).sort(compareSegments).map(segmentRef);
}

function stableStructure(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStructure).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStructure(object[key])}`).join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}
