/**
 * Types and parser for the v2 segment envelope:
 * `hwp cat --format markdown --with-segments --segments v2`, the published
 * `segment-envelope-v2` contract (`contract: "hwp-segment-envelope-v2"`,
 * `schema_version: "1.0"`). The engine opts in with `--segments v2`, so this
 * parser handles that one shape only and never branches on envelope version.
 *
 * Segment shape verified against the hwp-cli v0.20.0 release binary: both
 * captures under test/fixtures/cat-segments-*.json were re-produced by that
 * binary from the commands recorded in the test file.
 *
 * The wire envelope carries `{id, kind, path: {section, indices},
 * char_range: {start, end}, style, direct}` per segment, with ranges that
 * NEST (a run inside its para, a cell inside its table). What this module
 * publishes is the projection the rest of the editor already consumes: the
 * `CatEnvelope` wire shape to the browser is unchanged, with `start`/`end`
 * from `char_range`, `section` from `path.section`, and `para` from
 * `path.indices[0]` (the top-level paragraph index, the coordinate
 * `SegmentRef` and `EditOp` addressing are built on). The richer v2 payload
 * (derived ids, per-level styles) is deliberately not projected yet: routing
 * it into the UI is host-side work, not engine adoption.
 *
 * Offset caveat, unchanged from v1: `char_range` counts Unicode scalars into
 * `markdown`, while JS string indexing counts UTF-16 code units. The two
 * agree on the BMP, which is all the current fixtures exercise.
 */

/** The seven segment kinds the v2 envelope defines. */
export type SegmentKind =
  | "para"
  | "run"
  | "table"
  | "cell"
  | "image"
  | "field"
  | "bookmark";

const SEGMENT_KINDS: readonly SegmentKind[] = [
  "para",
  "run",
  "table",
  "cell",
  "image",
  "field",
  "bookmark",
];

export interface Segment {
  /** Start character offset into `markdown` (inclusive), from `char_range.start`. */
  start: number;
  /** End character offset into `markdown` (exclusive), from `char_range.end`. */
  end: number;
  /** What the range is; the v2 envelope emits all seven kinds. */
  kind: SegmentKind;
  /** 0-based HWP section index, from `path.section`. */
  section: number;
  /** 0-based top-level paragraph index within the section, from `path.indices[0]`. */
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

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number");
}

/** Validate one wire segment and project it to the published shape. */
function projectSegment(raw: unknown): Segment {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("segments envelope: malformed segment");
  }
  const { id, kind, path, char_range } = raw as Record<string, unknown>;
  const range = char_range as Record<string, unknown> | undefined;
  const p = path as Record<string, unknown> | undefined;
  if (
    typeof id !== "string" ||
    typeof kind !== "string" ||
    !SEGMENT_KINDS.includes(kind as SegmentKind) ||
    typeof p !== "object" || p === null ||
    typeof p.section !== "number" ||
    !isNumberArray(p.indices) || p.indices.length === 0 ||
    typeof range !== "object" || range === null ||
    typeof range.start !== "number" ||
    typeof range.end !== "number"
  ) {
    throw new Error("segments envelope: malformed segment");
  }
  return {
    start: range.start,
    end: range.end,
    kind: kind as SegmentKind,
    section: p.section,
    para: p.indices[0]!,
  };
}

/**
 * Parse the one-line JSON v2 envelope, throwing on anything that is not the
 * v2 shape: a missing or wrong `contract`/`schema_version` pair, a malformed
 * payload, or a segment outside the seven-kind, path-plus-char_range shape.
 */
export function parseCatEnvelope(json: string): CatEnvelope {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("segments envelope: not an object");
  }
  const { schema_version, contract, markdown, segments } = raw as Record<string, unknown>;
  if (contract !== "hwp-segment-envelope-v2" || schema_version !== "1.0") {
    throw new Error("segments envelope: not a v2 envelope");
  }
  if (typeof markdown !== "string" || !Array.isArray(segments)) {
    throw new Error("segments envelope: missing markdown string or segments array");
  }
  return { markdown, segments: segments.map(projectSegment) };
}

/** Extract the source coordinate of a segment. */
export function segmentRef(segment: Segment): SegmentRef {
  return { section: segment.section, para: segment.para };
}

/** Find the outermost segment covering a character offset into `markdown`. */
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
