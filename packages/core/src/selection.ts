import type { EditAddress, ParagraphAddress } from "./ops.js";
import type { CatEnvelope, Segment, SegmentRef } from "./segments.js";
import { segmentRef } from "./segments.js";
import type { EditorAction, EditorState } from "./state.js";

function sameRef(a: SegmentRef, b: SegmentRef): boolean {
  return a.id !== undefined && b.id !== undefined
    ? a.id === b.id
    : a.section === b.section && a.para === b.para;
}

function uniqueSegments(segments: Segment[]): Segment[] {
  const seen = new Set<string>();
  return segments.filter((segment) => {
    const key = segment.id === undefined ? `${segment.section}:${segment.para}` : `id:${segment.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function paragraphForSegment(envelope: CatEnvelope, segment: Segment): Segment | undefined {
  if (segment.indices === undefined) {
    return envelope.segments.find((candidate) => candidate.kind === "para" && candidate.indices === undefined &&
      candidate.section === segment.section && candidate.para === segment.para);
  }
  const topPath = segment.indices.slice(0, 1);
  return envelope.segments.find((candidate) => candidate.kind === "para" && candidate.section === segment.section &&
    candidate.indices !== undefined && candidate.indices.length === 1 && candidate.indices[0] === topPath[0]);
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
  const orderedParagraphs = envelope.segments.filter((s) => s.kind === "para" &&
    (s.indices === undefined || s.indices.length === 1));
  const order = new Map(orderedParagraphs.map((s, i) => [s.id ?? `${s.section}:${s.para}`, i]));
  return uniqueSegments(paragraphs).sort((a, b) =>
    (order.get(a.id ?? `${a.section}:${a.para}`) ?? 0) - (order.get(b.id ?? `${b.section}:${b.para}`) ?? 0));
}

export function paragraphAddress(segment: Segment): ParagraphAddress {
  return segment.id === undefined
    ? { at: { section: segment.section, paragraph: segment.para } }
    : { id: segment.id };
}

export function formatAddresses(envelope: CatEnvelope, paragraphs: readonly Segment[]): EditAddress[] {
  const out: EditAddress[] = [];
  const ids = new Set<string>();
  for (const paragraph of paragraphs) {
    const runs = envelope.segments.filter((run) => {
      if (run.kind !== "run" || run.section !== paragraph.section || run.para !== paragraph.para) return false;
      if (paragraph.indices === undefined || run.indices === undefined) return paragraph.indices === undefined && run.indices === undefined;
      return run.indices.length === paragraph.indices.length + 1 &&
        paragraph.indices.every((index, at) => run.indices![at] === index);
    });
    for (const [index, run] of runs.entries()) {
      if (run.id !== undefined) {
        if (ids.has(run.id)) continue;
        ids.add(run.id);
        out.push({ id: run.id });
      } else if (run.indices !== undefined) {
        out.push({ at: { section: run.section, paragraph: run.para, run: run.indices.at(-1)! } });
      } else {
        out.push({ at: { section: run.section, paragraph: run.para, run: index } });
      }
    }
    if (runs.length === 0 && paragraph.indices === undefined) {
      out.push({ at: { section: paragraph.section, paragraph: paragraph.para, run: 0 } });
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
  // Invalid hits retain the established single-selection behavior.
  if (!hit || mode === "single") return { type: "select", selection: segmentRef(target) };
  const current = selectedParagraphs(envelope, state);
  const anchorRef = state.selectionAnchor ?? (state.selection ? state.selection : segmentRef(hit));
  const anchorHit = envelope.segments.find((s) => anchorRef.id ? s.id === anchorRef.id : s.section === anchorRef.section && s.para === anchorRef.para);
  const anchor = anchorHit ? paragraphForSegment(envelope, anchorHit) : hit;
  let selected: Segment[];
  if (mode === "toggle") {
    selected = current.some((p) => p.id === hit.id || (p.id === undefined && p.section === hit.section && p.para === hit.para))
      ? current.filter((p) => p !== hit && !(p.section === hit.section && p.para === hit.para))
      : [...current, hit];
  } else {
    const paragraphs = uniqueSegments(envelope.segments.filter((s) => s.kind === "para" &&
      (s.indices === undefined || s.indices.length === 1)));
    const a = paragraphs.indexOf(anchor!), b = paragraphs.indexOf(hit);
    selected = a < 0 || b < 0 ? [hit] : paragraphs.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  const refs = selected.map(segmentRef);
  const primary = segmentRef(hit);
  return { type: "selectMany", selections: refs, primary, anchor: mode === "extend" ? segmentRef(anchor!) : anchorRef };
}

export function selectSimilar(envelope: CatEnvelope, primary: Segment, level: "char" | "para"): SegmentRef[] {
  const props = level === "char" ? primary.directChar : primary.directPara;
  if (props === undefined) return [];
  const key = JSON.stringify(props);
  return uniqueSegments(envelope.segments.filter((segment) => segment.kind === "para" &&
    JSON.stringify(level === "char" ? segment.directChar : segment.directPara) === key)).map(segmentRef);
}
