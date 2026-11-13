import type { EditAddress, ParagraphAddress } from "./ops.js";
import type { CatEnvelope, DocumentFormat, Segment, SegmentRef } from "./segments.js";
import { formattedSpan, markdownLength, runCoverage, segmentRef } from "./segments.js";
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

/**
 * Why a click or a selection has no paragraph target. `noRuns` is a modifier
 * click at run level on a unit (a paragraph or a cell) that publishes no run
 * (#71): an empty or point paragraph has nothing to add to a run selection.
 */
export type SelectionRefusal = "table" | "cell" | "container" | "unaddressable" | "noRuns";

export interface SelectionTargets {
  /** Paragraphs the selection covers, in envelope order; empty when it covers none. */
  paragraphs: Segment[];
  /** The one paragraph a single-target op (replace, insert, delete) may address. */
  paragraph: Segment | undefined;
  /** Why the single-target ops are off, or null when `paragraph` is set. */
  refusal: SelectionRefusal | null;
}

/**
 * Whether a segment's own ref names it and nothing else.
 *
 * A `SegmentRef` carries a section, a paragraph and an optional id, and
 * `segmentForRef` falls back to the coordinate when the id is absent. A
 * nested segment with no id therefore names the paragraph that hosts it:
 * selecting it and pressing Delete would remove the host, taking whatever the
 * projection nested inside it, and answering a format op would apply to the
 * host's runs. No shipped transport emits that shape (v2 requires ids, v1
 * has no indices), so such a segment is refused rather than resolved to
 * something it is not.
 */
export function hasOwnRef(segment: Segment): boolean {
  return segment.id !== undefined || segment.indices === undefined || segment.indices.length <= 1;
}

/**
 * Map a selected segment to the paragraphs an op may address.
 *
 * Every kind is mapped explicitly, because guessing is destructive: a table
 * and a cell sit inside a host paragraph whose range covers the whole table,
 * so aiming a paragraph op at that host edits or deletes the table itself.
 * Nothing here falls back to an enclosing paragraph.
 *
 * - para: itself, unless it is nested without an id of its own: its ref then
 *   names the host paragraph, so it is unaddressable rather than the host.
 * - run: the paragraph that directly holds it, if that paragraph names itself.
 * - cell: every paragraph inside the cell, since align, spacing and character
 *   format apply to all of them, but no single target: replace, insert and
 *   delete address one paragraph, and the engine refuses to delete a cell's
 *   last one. An empty cell, or one whose paragraphs cannot name themselves,
 *   has no target at all.
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
  if (segment.kind === "para") return only(hasOwnRef(segment) ? segment : undefined);
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
    if (paragraphs.length === 0) return refuse("cell");
    // A paragraph inside a cell can itself be nested and carry no id (a table
    // in a cell): its ref would name the cell's coordinate, which resolves to
    // whatever sits there. Refuse the cell rather than address most of it.
    if (!paragraphs.every(hasOwnRef)) return refuse("unaddressable");
    return { paragraphs, paragraph: undefined, refusal: "cell" };
  }
  // Only a run is left: the paragraph one level up holds its text. That
  // paragraph is the target, so it has to name itself - a run with an id under
  // an id-less nested paragraph would otherwise address the host.
  const holder = envelope.segments.find((candidate) => candidate.kind === "para" &&
    candidate.section === segment.section && candidate.indices !== undefined &&
    candidate.indices.length === indices.length - 1 &&
    candidate.indices.every((index, at) => index === indices[at]));
  return only(holder !== undefined && hasOwnRef(holder) ? holder : undefined);
}

/**
 * Whether a paragraph is its section's definition paragraph.
 *
 * Body paragraph 0 of every section carries `SectionDef`, and the engine
 * refuses both halves of that position: `move_paragraph` will not move it
 * (moving its neighbour up would put the definition at index 1) and
 * `insert_blocks` refuses an insertion before it ("구역 정의 문단 앞에는
 * 삽입할 수 없습니다"). It is a real, addressable paragraph — usually empty —
 * so a control that offers either has to know the position, not the text.
 *
 * Only a top-level paragraph qualifies: a cell's first paragraph is nested and
 * carries no section definition. A legacy projection names no nesting path, so
 * it is not classified here; those controls are position-addressed and off.
 */
export function isSectionDefinitionParagraph(segment: Segment): boolean {
  return segment.kind === "para" && segment.indices !== undefined &&
    segment.indices.length === 1 && segment.indices[0] === 0;
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

/**
 * One address a Markdown range formats, and whether the range covers it whole.
 *
 * `whole` is `runCoverage`'s answer, not the shape of the address: a piece the
 * range covers entirely is emitted with its own source window, because an edit
 * op that names only the id of a split run formats every piece of it. So a
 * target can carry `chars` and still be the whole piece, and a reader that
 * counted missing `chars` would label nothing exactly where the selection was
 * widened.
 *
 * `widened` says the range was PARTIAL to this piece and the coverage widened
 * it anyway, which is the case a reader has to be warned about: the rest of the
 * piece goes with the op though the selection never covered it. A range that
 * covers the piece whole is `whole` without being `widened` - nothing was added
 * to the selection - so the two answers stay apart.
 */
export interface FormatTarget {
  address: EditAddress;
  whole: boolean;
  widened: boolean;
}

export function formatAddresses(
  envelope: CatEnvelope,
  paragraphs: readonly Segment[],
  range?: MarkdownRangeSelection | null,
  format: DocumentFormat = "unknown",
): EditAddress[] {
  return formatTargets(envelope, paragraphs, range, format).map((target) => target.address);
}

/**
 * The addresses a selection formats, with each one's coverage answer.
 *
 * `format` decides the one place the two coordinate spaces may differ by a
 * character (an HWP5 paragraph break), so a caller that does not know the
 * document's format gets no allowance rather than a guess.
 */
export function formatTargets(
  envelope: CatEnvelope,
  paragraphs: readonly Segment[],
  range?: MarkdownRangeSelection | null,
  format: DocumentFormat = "unknown",
): FormatTarget[] {
  if (range !== undefined && range !== null) {
    if (paragraphs.length !== 1 || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
        range.start < 0 || range.start >= range.end || range.end > markdownLength(envelope)) return [];
    const paragraph = resolveSelection(envelope, paragraphs[0]!).paragraph;
    if (paragraph === undefined) return [];
    const matches = range.paragraph.id !== undefined
      ? paragraph.id === range.paragraph.id
      : paragraph.section === range.paragraph.section && paragraph.para === range.paragraph.para;
    if (!matches || range.start < paragraph.start || range.end > paragraph.end) return [];
    return addressesForRuns(envelope, paragraphRuns(envelope, paragraph, range), paragraph, range, format);
  }
  const out: FormatTarget[] = [];
  const targets = new Set<string>();
  for (const selected of paragraphs) {
    if (selected.kind === "run") {
      const address = addressForSelectedRun(envelope, selected);
      if (address === undefined) continue;
      const key = addressKey(address);
      if (!targets.has(key)) { targets.add(key); out.push({ address, whole: true, widened: false }); }
      continue;
    }
    if (selected.kind !== "para") continue;
    const paragraph = selected;
    for (const target of addressesForRuns(envelope, paragraphRuns(envelope, paragraph), paragraph)) {
      const key = addressKey(target.address);
      if (targets.has(key)) continue;
      targets.add(key);
      out.push(target);
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

function addressesForRuns(
  envelope: CatEnvelope,
  runs: Segment[],
  paragraph: Segment,
  range?: MarkdownRangeSelection | null,
  format: DocumentFormat = "unknown",
): FormatTarget[] {
  const out: FormatTarget[] = [];
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
    let whole = true;
    let widened = false;
    if (range !== undefined && range !== null) {
      const narrow = narrowToRange(envelope, run, range, format);
      // A piece the range overlaps only through a marker or its edge
      // whitespace shows nothing the selection covers, so it names no target
      // at all: widening it to the whole run would format characters the
      // selection never touched, including in another occurrence of the run.
      if (narrow === "none") continue;
      if (narrow === "whole") {
        // The range is partial to this piece and the coverage widened it: the
        // whole piece goes with the op although the selection stopped inside
        // it, which is what a reader is warned about.
        //
        // Partial to what the piece FORMATS, not to its published bounds and
        // not to what it shows: an emphasis run's bounds include the marker
        // pair it is wrapped in, so a selection of exactly the characters the
        // piece shows starts after `run.start` - a warning about text the
        // selection covered. The other direction matters as much: the engine
        // leaves the run's edge whitespace outside that pair, and a whole-piece
        // op writes it, so a selection of the text between the markers has not
        // covered everything the op formats. `formattedSpan` is that question,
        // and `runCoverage`'s window path answers the same way, counting edge
        // whitespace only when the selection reaches it.
        const formatted = formattedSpan(envelope, run);
        widened = range.start > formatted.start || range.end < formatted.end;
        // A split run publishes one id per piece, and an op that names only the
        // id formats the whole run (edit-ops-v1), so a covered piece names its
        // own span instead. The published span is what the resolver accepts,
        // paragraph break included. The target is still a WHOLE piece: the
        // window is the piece's own, not the selection's.
        const span = run.sourceChars;
        if (span !== undefined && run.id !== undefined && envelope.segments.some((sibling) =>
          sibling !== run && sibling.kind === "run" && sibling.id === run.id)) {
          address = { ...address, chars: [span.start, span.end] };
        }
      } else {
        address = { ...address, chars: narrow };
        whole = false;
      }
    }
    const key = addressKey(address);
    if (targets.has(key)) continue;
    targets.add(key);
    out.push({ address, whole, widened });
  }
  // A paragraph whose runs the envelope does not publish yields nothing at
  // all: an engine addresses character format per run (`edit-ops-v1`'s
  // runAddress has no paragraph spelling), so naming run 0 would format the
  // paragraph's first run while the panel says the whole paragraph, and the
  // client cannot even count the runs to warn about the rest. The inspector
  // reports the cause and keeps the control off (#58 item 19e).
  return out;
}

/**
 * What a markdown range selects inside one run piece.
 *
 * - `"none"` — the range overlaps the piece only through a marker or the edge
 *   whitespace the marker pair sits inside, so it covers no character the
 *   piece shows. The piece names no target; it is not widened to the run,
 *   which would format the characters the selection did not reach.
 * - `"whole"` — the range covers the piece; the piece publishes no
 *   `source_chars` (a schema `1.0` host); or the fragment is outside the
 *   allow-list `runCoverage` maps (a rewrite form, a nested field/image, a
 *   span that is not the text it shows). The last two keep the pre-#71
 *   behavior of snapping the selection to the whole run, which is what the
 *   range hint promises, rather than formatting source characters the user did
 *   not select: a guess is the failure AC2 names, and a whole run is not one.
 * - a `[start, end)` source window — the range covers part of a piece that
 *   publishes where its characters are, and `runCoverage` read the window back
 *   exactly. A window whose edge lands on a marker or on the edge whitespace
 *   is clamped to the characters the run shows.
 */
function narrowToRange(
  envelope: CatEnvelope,
  run: Segment,
  range: MarkdownRangeSelection,
  format: DocumentFormat,
): "none" | "whole" | [number, number] {
  const coverage = runCoverage(envelope, run, Math.max(range.start, run.start), Math.min(range.end, run.end), format);
  if (coverage.kind === "window") return coverage.range;
  return coverage.kind;
}

function addressKey(address: EditAddress): string {
  const base = "id" in address
    ? `id:${address.id}`
    : `${address.at.section}:${address.at.paragraph}:${address.at.run}`;
  // A split run publishes one id per piece, so the source window is part of
  // the identity: two windows of the same run are two ops, not a duplicate.
  return address.chars === undefined ? base : `${base}@${address.chars[0]}-${address.chars[1]}`;
}

/** A run's own ordinal within its holder paragraph: its last index, or its offset. */
function runOrdinal(run: Segment): number {
  return run.indices?.[run.indices.length - 1] ?? run.start;
}

/**
 * Every self-naming run grouped under the paragraph that holds it, built in
 * one pass over the envelope (#71 rule 2). A run counts only when it names
 * itself and its holder does too; `unnamed` records holders that publish runs
 * but cannot name themselves, so a click there refuses as unaddressable.
 */
interface RunIndex {
  /** Holder paragraph key -> its runs, by ordinal. */
  byHolder: Map<string, Segment[]>;
  /** Run key -> [holder's position in paragraph order, run ordinal]. */
  order: Map<string, [number, number]>;
  /** Holder keys whose runs exist but whose holder cannot name itself. */
  unnamed: Set<string>;
  /** Every counted run in run order. */
  pieces: Segment[];
}

function indexRuns(envelope: CatEnvelope): RunIndex {
  const paragraphs = uniqueSegments(envelope.segments.filter((s) => s.kind === "para")).sort(compareSegments);
  const position = new Map(paragraphs.map((paragraph, index) => [segmentKey(paragraph), index]));
  // A run's holder is the paragraph one level up; a legacy run without
  // indices is held by the top-level paragraph covering its offsets.
  const pathKey = (section: number, indices: number[]): string => `${section}:${indices.join("/")}`;
  const byPath = new Map<string, Segment>();
  for (const paragraph of paragraphs) {
    if (paragraph.indices !== undefined) byPath.set(pathKey(paragraph.section, paragraph.indices), paragraph);
  }
  const byHolder = new Map<string, Segment[]>();
  const unnamed = new Set<string>();
  for (const run of envelope.segments) {
    if (run.kind !== "run") continue;
    const holder = run.indices === undefined
      ? paragraphs.find((p) => p.indices === undefined && p.section === run.section && p.para === run.para &&
        p.start <= run.start && p.end >= run.end)
      : byPath.get(pathKey(run.section, run.indices.slice(0, -1)));
    if (holder === undefined) continue;
    const key = segmentKey(holder);
    if (!hasOwnRef(holder) || !hasOwnRef(run)) { unnamed.add(key); continue; }
    const list = byHolder.get(key);
    if (list === undefined) byHolder.set(key, [run]); else list.push(run);
  }
  const order = new Map<string, [number, number]>();
  const pieces: Segment[] = [];
  for (const paragraph of paragraphs) {
    const key = segmentKey(paragraph);
    const runs = byHolder.get(key);
    if (runs === undefined) continue;
    runs.sort((a, b) => runOrdinal(a) - runOrdinal(b));
    const at = position.get(key)!;
    for (const run of uniqueSegments(runs)) {
      order.set(segmentKey(run), [at, runOrdinal(run)]);
      pieces.push(run);
    }
  }
  return { byHolder, order, unnamed, pieces };
}

/**
 * The run-level action for a modifier click (#71 rules 1-8). `stored` holds the
 * selection's runs only; anything else was dropped by the caller (rule 1).
 *
 * Run order (rule 5) is the holder paragraph by `compareSegments`, then the
 * run's own ordinal, precomputed once per call in `indexRuns`: a run is never
 * compared with a control path, so a table index equal to a run ordinal
 * orders nothing.
 */
function runSelectionAction(
  envelope: CatEnvelope,
  state: EditorState,
  stored: Segment[],
  target: Segment,
  mode: "toggle" | "extend",
): EditorAction {
  const { paragraphs, refusal } = resolveSelection(envelope, target);
  if (paragraphs.length === 0) return { type: "refuseSelection", refusal: refusal ?? "unaddressable" };
  const index = indexRuns(envelope);
  // Rule 2: a paragraph contributes its immediate runs, a cell those of each of its paragraphs.
  const unit = uniqueSegments(paragraphs.flatMap((paragraph) => index.byHolder.get(segmentKey(paragraph)) ?? []));
  if (unit.length === 0) {
    // Rule 6: runs that exist but cannot be addressed are a different obstacle
    // from a unit that has none.
    const unaddressable = paragraphs.some((paragraph) => index.unnamed.has(segmentKey(paragraph)));
    return { type: "refuseSelection", refusal: unaddressable ? "unaddressable" : "noRuns" };
  }
  const rank = (run: Segment): [number, number] => index.order.get(segmentKey(run)) ?? [Number.MAX_SAFE_INTEGER, runOrdinal(run)];
  const byOrder = (a: Segment, b: Segment): number => {
    const [ah, ar] = rank(a);
    const [bh, br] = rank(b);
    return ah !== bh ? ah - bh : ar - br;
  };
  const storedRuns = uniqueSegments(stored);
  const unitKeys = new Set(unit.map(segmentKey));
  const storedByKey = new Map(storedRuns.map((run) => [run.id ?? segmentKey(run), run]));
  const lookup = (ref: SegmentRef): Segment | undefined =>
    (ref.id !== undefined ? storedByKey.get(ref.id) : undefined) ?? segmentForRef(envelope, ref);
  const primaryKey = state.selection === null ? undefined
    : (() => {
      const primary = lookup(state.selection);
      return primary?.kind === "run" ? segmentKey(primary) : undefined;
    })();
  const anchorSegment = state.selectionAnchor === null || state.selectionAnchor === undefined
    ? undefined : lookup(state.selectionAnchor);
  // Rule 7: the anchor is the run that started the selection. A stored primary
  // stands in only when the state carries no run anchor at all.
  const anchorRun = anchorSegment?.kind === "run"
    ? anchorSegment
    : storedRuns.find((run) => segmentKey(run) === primaryKey) ?? storedRuns[0];
  let selected: Segment[];
  if (mode === "toggle") {
    // Rule 3: any of the unit's runs selected takes all of them off; none adds all.
    selected = storedRuns.some((run) => unitKeys.has(segmentKey(run)))
      ? storedRuns.filter((run) => !unitKeys.has(segmentKey(run)))
      : [...storedRuns, ...unit];
  } else {
    // Rules 4, 5 and 8: every piece in run order from the anchor to the hit
    // unit; pieces sharing an id are one key, so one in range brings the id.
    const keys = index.pieces.map(segmentKey);
    const span = (wanted: Set<string>): [number, number] => {
      let first = -1;
      let last = -1;
      keys.forEach((key, at) => {
        if (!wanted.has(key)) return;
        if (first < 0) first = at;
        last = at;
      });
      return [first, last];
    };
    const [hitFirst, hitLast] = span(unitKeys);
    const [anchorFirst, anchorLast] = anchorRun === undefined ? [-1, -1] : span(new Set([segmentKey(anchorRun)]));
    const from = anchorFirst < 0 ? hitFirst : Math.min(anchorFirst, hitFirst);
    const to = Math.max(anchorLast, hitLast);
    selected = from < 0 ? unit : index.pieces.slice(from, to + 1);
  }
  const list = uniqueSegments(selected).sort(byOrder);
  // Rule 7: a toggle that empties the selection clears it.
  if (list.length === 0) return { type: "select", selection: null };
  const primary = mode === "extend"
    ? unit[0]!
    : list.find((run) => segmentKey(run) === primaryKey) ?? list[0]!;
  // Rule 7: toggles keep the anchor as it was, even when its run was removed,
  // so a later extend still measures from the run that started the selection.
  const anchor = mode === "toggle" && state.selectionAnchor != null
    ? state.selectionAnchor
    : segmentRef(anchorRun ?? primary);
  return { type: "selectMany", selections: list.map(segmentRef), primary: segmentRef(primary), anchor };
}

/**
 * The action one click on `target` performs.
 *
 * A multi-selection holds paragraphs only: every unit a modifier click adds is
 * a paragraph, and a cell enters as the paragraphs inside it. A table, an
 * image, a field, a bookmark or an empty cell adds nothing, so that click
 * reports its reason and leaves the selection where it was: the primary never
 * becomes a ref that resolves to no paragraph.
 *
 * A run-level selection, which matching character format produces, stays at
 * run level (#71, rules 1-10): a modifier click contributes the runs of the
 * unit it hit (a paragraph's immediate runs, a cell's paragraphs' runs), Ctrl
 * toggles them as one unit and Shift extends in run order (`indexRuns`). A
 * selection is never mixed: refs that are not runs are dropped from it. Run
 * order compares holder paragraphs, then a run's own index, and never a run
 * path with a control path, which is what reached past the range before. A
 * text range in force sends the click down the paragraph path instead.
 */
export function selectionAction(
  envelope: CatEnvelope,
  state: EditorState,
  target: Segment,
  mode: "single" | "toggle" | "extend",
): EditorAction {
  if (mode === "single") {
    // A unit whose ref would name its host is not selectable at all: the state
    // would hold a coordinate that resolves to a different segment.
    return hasOwnRef(target)
      ? { type: "select", selection: segmentRef(target) }
      : { type: "refuseSelection", refusal: "unaddressable" };
  }
  const refs = state.selections?.length ? state.selections : state.selection ? [state.selection] : [];
  // One id index per call: a run-level selection can hold thousands of refs,
  // and a linear lookup per ref made each modifier click quadratic.
  const byId = new Map<string, Segment>();
  for (const segment of envelope.segments) {
    if (segment.id !== undefined && !byId.has(segment.id)) byId.set(segment.id, segment);
  }
  const segments = refs.flatMap((ref) => {
    const segment = ref.id !== undefined ? byId.get(ref.id) : segmentForRef(envelope, ref);
    return segment === undefined ? [] : [segment];
  });
  // A modifier click contributes the paragraphs of the unit it hit, and a cell
  // contributes every paragraph of its own, because those are what an op edits.
  const { paragraphs: units, refusal } = resolveSelection(envelope, target);
  if (units.length === 0) return { type: "refuseSelection", refusal: refusal ?? "unaddressable" };
  const fresh = uniqueSegments(units).sort(compareSegments);
  // A run-level selection stays at run level (#71). With a text range in
  // force the click starts over at paragraph level instead (rule 10): the
  // clicked unit's own paragraphs, anchored at the click, never merged with
  // the holders of the run list it replaces.
  if (segments.some((segment) => segment.kind === "run")) {
    if (state.range !== null && state.range !== undefined) {
      return { type: "selectMany", selections: fresh.map(segmentRef), primary: segmentRef(fresh[0]!), anchor: segmentRef(target) };
    }
    return runSelectionAction(envelope, state, segments.filter((segment) => segment.kind === "run"), target, mode);
  }
  // The selection is paragraph-only, so a stored ref that covers no paragraph
  // (a table, an image, a field, a bookmark) contributes nothing: it is not
  // carried into the multi-selection and cannot become its primary.
  const stored = uniqueSegments(segments.flatMap((segment) => resolveSelection(envelope, segment).paragraphs));
  const anchorRef = state.selectionAnchor ?? (state.selection ? state.selection : segmentRef(target));
  const anchorSegment = segmentForRef(envelope, anchorRef);
  // An anchor with no paragraph of its own has nothing to measure a range from,
  // so the range starts at the click instead of throwing. Otherwise the anchor
  // keeps the ref of the unit that started the selection, which is what lets a
  // cell anchor keep its whole span across later clicks.
  const anchorUnits = anchorSegment === undefined ? [] : resolveSelection(envelope, anchorSegment).paragraphs;
  const anchor = anchorUnits.length === 0 ? segmentRef(target) : anchorRef;
  const unitKeys = new Set(fresh.map(segmentKey));
  let selected: Segment[];
  if (mode === "toggle") {
    // Toggling compares the clicked unit's paragraph keys with the stored
    // paragraphs, so a second click on a cell takes the whole cell off again.
    selected = stored.some((segment) => unitKeys.has(segmentKey(segment)))
      ? stored.filter((segment) => !unitKeys.has(segmentKey(segment)))
      : [...stored, ...fresh];
  } else {
    const ordered = uniqueSegments(envelope.segments.filter((s) => s.kind === "para")).sort(compareSegments);
    const position = new Map(ordered.map((unit, index) => [segmentKey(unit), index]));
    const anchorFirst = anchorUnits.length === 0 ? -1 : position.get(segmentKey(anchorUnits[0]!)) ?? -1;
    // Both ends of the anchor's span are endpoints, not its first paragraph:
    // a cell anchor covers several paragraphs and every one of them is in range.
    const anchorLast = anchorUnits.length === 0 ? -1 : position.get(segmentKey(anchorUnits[anchorUnits.length - 1]!)) ?? -1;
    const hitFirst = position.get(segmentKey(fresh[0]!)) ?? -1;
    const hitLast = position.get(segmentKey(fresh[fresh.length - 1]!)) ?? hitFirst;
    const from = anchorFirst < 0 ? hitFirst : Math.min(anchorFirst, hitFirst);
    const to = Math.max(anchorLast, hitLast, from);
    // A paragraph the envelope does not list has no range to measure, so the
    // click keeps its own span instead of the range vanishing.
    selected = from < 0 ? fresh : ordered.slice(from, to + 1);
  }
  // The state is the source of the refs, but never of their order: it keeps
  // the primary first, and a selection reads in document order.
  const selectionList = uniqueSegments(selected).sort(compareSegments).map(segmentRef);
  return { type: "selectMany", selections: selectionList, primary: segmentRef(fresh[0]!), anchor };
}

export function selectSimilar(envelope: CatEnvelope, primary: Segment, level: "char" | "para"): SegmentRef[] {
  const props = level === "char" ? primary.directChar : primary.directPara;
  if (props === undefined) return [];
  const key = stableStructure(props);
  // A unit that cannot name itself is left out: its ref is a bare coordinate,
  // and the ops this list feeds (set-char, set-para, set-align) turn that into
  // a host address. The rest of the matches still select.
  if (level === "char") {
    const hasRuns = envelope.segments.some((segment) => segment.kind === "run");
    const candidates = hasRuns
      ? envelope.segments.filter((segment) => segment.kind === "run")
      : envelope.segments.filter((segment) => segment.kind === "para");
    return uniqueSegments(candidates.filter((segment) => hasOwnRef(segment) &&
      stableStructure(segment.directChar) === key)).sort(compareSegments).map(segmentRef);
  }
  return uniqueSegments(envelope.segments.filter((segment) => segment.kind === "para" && hasOwnRef(segment) &&
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
