import type { EditAddress, ParagraphAddress } from "./ops.js";
import type { CatEnvelope, Segment, SegmentRef } from "./segments.js";
import { segmentRef } from "./segments.js";
import type { EditorAction, EditorState } from "./state.js";

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

export function formatAddresses(envelope: CatEnvelope, paragraphs: readonly Segment[]): EditAddress[] {
  const out: EditAddress[] = [];
  const targets = new Set<string>();
  for (const paragraph of paragraphs) {
    const runs = envelope.segments.filter((run) => {
      if (run.kind !== "run" || run.section !== paragraph.section || run.para !== paragraph.para) return false;
      if (paragraph.indices === undefined) return run.start >= paragraph.start && run.end <= paragraph.end;
      if (run.indices === undefined) return false;
      return run.indices.length === paragraph.indices.length + 1 &&
        paragraph.indices.every((index, at) => run.indices![at] === index);
    });
    for (const [index, run] of runs.entries()) {
      let address: EditAddress;
      if (run.id !== undefined) {
        address = { id: run.id };
      } else if (run.indices !== undefined) {
        address = { at: { section: run.section, paragraph: run.para, run: run.indices.at(-1)! } };
      } else {
        address = { at: { section: run.section, paragraph: run.para, run: index } };
      }
      const key = "id" in address ? `id:${address.id}` : `${address.at.section}:${address.at.paragraph}:${address.at.run}`;
      if (targets.has(key)) continue;
      targets.add(key);
      out.push(address);
    }
    if (runs.length === 0 && paragraph.indices === undefined) {
      const address: EditAddress = { at: { section: paragraph.section, paragraph: paragraph.para, run: 0 } };
      const key = `${paragraph.section}:${paragraph.para}:0`;
      if (!targets.has(key)) { targets.add(key); out.push(address); }
    }
  }
  return out;
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
  return uniqueSegments(envelope.segments.filter((segment) => segment.kind === "para" &&
    stableStructure(level === "char" ? segment.directChar : segment.directPara) === key)).map(segmentRef);
}

function stableStructure(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStructure).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStructure(object[key])}`).join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}
