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

export function paragraphForSegment(envelope: CatEnvelope, segment: Segment): Segment | undefined {
  if (segment.indices === undefined) {
    if (segment.kind === "para") return segment;
    return envelope.segments.find((candidate) => candidate.kind === "para" && candidate.indices === undefined &&
      candidate.section === segment.section && candidate.para === segment.para &&
      candidate.start <= segment.start && candidate.end >= segment.end);
  }
  return envelope.segments.filter((candidate) => candidate.kind === "para" && candidate.section === segment.section &&
    candidate.indices !== undefined && candidate.indices.length <= segment.indices!.length &&
    candidate.indices.every((index, at) => index === segment.indices![at]))
    .sort((a, b) => (b.indices?.length ?? 0) - (a.indices?.length ?? 0))[0];
}

export function selectedParagraphs(envelope: CatEnvelope, state: EditorState): Segment[] {
  const refs = state.selections?.length ? state.selections : state.selection ? [state.selection] : [];
  const paragraphs = refs.flatMap((ref) => {
    const segment = envelope.segments.find((candidate) => ref.id !== undefined
      ? candidate.id === ref.id
      : candidate.section === ref.section && candidate.para === ref.para);
    const paragraph = segment && paragraphForSegment(envelope, segment);
    return paragraph ? [paragraph] : [];
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
    const paragraph = paragraphForSegment(envelope, paragraphs[0]!);
    if (paragraph === undefined) return [];
    const matches = range.paragraph.id !== undefined
      ? paragraph.id === range.paragraph.id
      : paragraph.section === range.paragraph.section && paragraph.para === range.paragraph.para;
    if (!matches || range.start < paragraph.start || range.end > paragraph.end) return [];
    return addressesForRuns(paragraphRuns(envelope, paragraph, range), paragraph, false);
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
    for (const address of addressesForRuns(paragraphRuns(envelope, paragraph), paragraph, true)) {
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
  const paragraph = paragraphForSegment(envelope, run);
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

function addressesForRuns(runs: Segment[], paragraph: Segment, allowLegacyFallback: boolean): EditAddress[] {
  const out: EditAddress[] = [];
  const targets = new Set<string>();
  const legacyProjection = paragraph.indices === undefined && runs.every((run) => run.indices === undefined);
  for (const [index, run] of runs.entries()) {
    let address: EditAddress | undefined;
    if (run.id !== undefined) {
      address = { id: run.id };
    } else if (legacyProjection) {
      address = { at: { section: run.section, paragraph: run.para, run: index } };
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
  const hit = paragraphForSegment(envelope, target);
  if (!hit || mode === "single") return { type: "select", selection: segmentRef(target) };
  const current = selectedParagraphs(envelope, state);
  const anchorRef = state.selectionAnchor ?? (state.selection ? state.selection : segmentRef(hit));
  const anchorHit = envelope.segments.find((s) => anchorRef.id ? s.id === anchorRef.id : s.section === anchorRef.section && s.para === anchorRef.para);
  const anchor = anchorHit ? paragraphForSegment(envelope, anchorHit) : hit;
  let selected: Segment[];
  if (mode === "toggle") {
    selected = current.some((p) => segmentKey(p) === segmentKey(hit))
      ? current.filter((p) => segmentKey(p) !== segmentKey(hit))
      : [...current, hit];
  } else {
    const paragraphs = uniqueSegments(envelope.segments.filter((s) => s.kind === "para"));
    const a = paragraphs.findIndex((p) => segmentKey(p) === segmentKey(anchor!));
    const b = paragraphs.findIndex((p) => segmentKey(p) === segmentKey(hit));
    selected = a < 0 || b < 0 ? [hit] : paragraphs.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  const refs = selected.map(segmentRef);
  const primary = segmentRef(hit);
  return { type: "selectMany", selections: refs, primary, anchor: mode === "extend" ? segmentRef(anchor!) : anchorRef };
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
