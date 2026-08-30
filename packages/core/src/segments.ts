/**
 * Types and parser for the `hwp cat --format markdown --with-segments`
 * one-line JSON envelope: {"markdown": ..., "segments": [...]}.
 *
 * Segment shape verified against hwp-cli v0.16.0 output: both captures under
 * test/fixtures/cat-segments-*.json were re-produced byte for byte by the
 * 0.16.0 binary, so the envelope has not moved since they were taken. Keys
 * are `start`, `end` (character offsets into `markdown`), `kind` ("para"),
 * `section`, `para`.
 */

export interface Segment {
  /** Start character offset into `markdown` (inclusive). */
  start: number;
  /** End character offset into `markdown` (exclusive). */
  end: number;
  /** Segment kind; hwp-cli v0.16.0 emits "para". */
  kind: string;
  /** 0-based HWP section index. */
  section: number;
  /** 0-based paragraph index within the section. */
  para: number;
}

export interface CatEnvelope {
  markdown: string;
  segments: Segment[];
}

/** Source coordinate of a segment in the document body. */
export interface SegmentRef {
  section: number;
  para: number;
}

/** Parse the one-line JSON envelope, throwing on a malformed payload. */
export function parseCatEnvelope(json: string): CatEnvelope {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("segments envelope: not an object");
  }
  const { markdown, segments } = raw as Record<string, unknown>;
  if (typeof markdown !== "string" || !Array.isArray(segments)) {
    throw new Error("segments envelope: missing markdown string or segments array");
  }
  for (const s of segments) {
    if (
      typeof s !== "object" || s === null ||
      typeof (s as Segment).start !== "number" ||
      typeof (s as Segment).end !== "number" ||
      typeof (s as Segment).section !== "number" ||
      typeof (s as Segment).para !== "number"
    ) {
      throw new Error("segments envelope: malformed segment");
    }
  }
  return raw as CatEnvelope;
}

/** Extract the source coordinate of a segment. */
export function segmentRef(segment: Segment): SegmentRef {
  return { section: segment.section, para: segment.para };
}

/** Find the segment covering a character offset into `markdown`. */
export function segmentAtOffset(
  envelope: CatEnvelope,
  offset: number,
): Segment | undefined {
  return envelope.segments.find((s) => s.start <= offset && offset < s.end);
}

/** Find the segment at a source coordinate. */
export function segmentAtRef(
  envelope: CatEnvelope,
  ref: SegmentRef,
): Segment | undefined {
  return envelope.segments.find(
    (s) => s.section === ref.section && s.para === ref.para,
  );
}

/** Slice the markdown text covered by a segment. */
export function segmentText(envelope: CatEnvelope, segment: Segment): string {
  return envelope.markdown.slice(segment.start, segment.end);
}

/** Map a markdown offset to its source coordinate, if inside a segment. */
export function offsetToRef(
  envelope: CatEnvelope,
  offset: number,
): SegmentRef | undefined {
  const s = segmentAtOffset(envelope, offset);
  return s === undefined ? undefined : segmentRef(s);
}
