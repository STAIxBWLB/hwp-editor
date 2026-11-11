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

export function selectedParagraphs(envelope: CatEnvelope, state: EditorState): Segment[] {
  const refs = state.selections?.length ? state.selections : state.selection ? [state.selection] : [];
  const paragraphs = refs.flatMap((ref) => {
    const segment = envelope.segments.find((candidate) => ref.id !== undefined
      ? candidate.id === ref.id
      : candidate.section === ref.section && candidate.para === ref.para);
    return segment === undefined ? [] : resolveSelection(envelope, segment).paragraphs;
  });
  const orderedParagraphs = uniqueSegments(envelope.segments.filter((s) => s.kind === "para"));
  const order = new Map(orderedParagraphs.map((s, i) => [segmentKey(s), i]));
  return uniqueSegments(paragraphs).sort((a, b) =>
    (order.get(segmentKey(a)) ?? 0) - (order.get(segmentKey(b)) ?? 0));
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

export function selectionAction(
  envelope: CatEnvelope,
  state: EditorState,
  target: Segment,
  mode: "single" | "toggle" | "extend",
): EditorAction {
  if (mode === "single") return { type: "select", selection: segmentRef(target) };
  const hitTargets = resolveSelection(envelope, target).paragraphs;
  // A table, an image, an empty cell: nothing to extend across, and widening
  // to the paragraph that encloses it would select that paragraph's text.
  if (hitTargets.length === 0) return { type: "select", selection: segmentRef(target) };
  const current = selectedParagraphs(envelope, state);
  const anchorRef = state.selectionAnchor ?? (state.selection ? state.selection : segmentRef(hitTargets[0]!));
  const anchorHit = envelope.segments.find((s) => anchorRef.id ? s.id === anchorRef.id : s.section === anchorRef.section && s.para === anchorRef.para);
  // An anchor with no paragraph target of its own has nothing to measure a
  // range from, so the range starts at the click instead of throwing.
  const anchorTargets = anchorHit === undefined ? [] : resolveSelection(envelope, anchorHit).paragraphs;
  const anchor = anchorTargets[0] ?? hitTargets[0]!;
  const paragraphKeys = new Set(hitTargets.map(segmentKey));
  let selected: Segment[];
  if (mode === "toggle") {
    // Toggling a cell takes its whole content, so align and format reach every
    // paragraph of it rather than the first one.
    selected = current.some((p) => paragraphKeys.has(segmentKey(p)))
      ? current.filter((p) => !paragraphKeys.has(segmentKey(p)))
      : [...current, ...hitTargets];
  } else {
    const paragraphs = uniqueSegments(envelope.segments.filter((s) => s.kind === "para"));
    const position = new Map(paragraphs.map((p, i) => [segmentKey(p), i]));
    const anchorFirst = position.get(segmentKey(anchor)) ?? -1;
    const anchorLast = position.get(segmentKey(anchorTargets[anchorTargets.length - 1] ?? anchor)) ?? anchorFirst;
    const hitFirst = position.get(segmentKey(hitTargets[0]!)) ?? -1;
    const hitLast = position.get(segmentKey(hitTargets[hitTargets.length - 1]!)) ?? hitFirst;
    const from = anchorFirst < 0 || hitFirst < 0 ? Math.max(anchorFirst, hitFirst) : Math.min(anchorFirst, hitFirst);
    const to = anchorFirst < 0 || hitFirst < 0 ? from : Math.max(anchorLast, hitLast);
    // Both endpoints resolve to paragraphs the envelope lists, so this slice is
    // the range; the `-1` arms only keep an unlisted endpoint selecting itself.
    selected = from < 0 ? [anchor, ...hitTargets] : paragraphs.slice(from, to + 1);
  }
  const refs = selected.map(segmentRef);
  const primary = segmentRef(hitTargets[0]!);
  return { type: "selectMany", selections: refs, primary, anchor: mode === "extend" ? segmentRef(anchor) : anchorRef };
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
    return uniqueSegments(candidates.filter((segment) => stableStructure(segment.directChar) === key)).map(segmentRef);
  }
  return uniqueSegments(envelope.segments.filter((segment) => segment.kind === "para" &&
    stableStructure(segment.directPara) === key)).map(segmentRef);
}

function stableStructure(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStructure).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStructure(object[key])}`).join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}
