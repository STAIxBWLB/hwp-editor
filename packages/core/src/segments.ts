/**
 * Types and parser for the v2 segment envelope:
 * `hwp cat --format markdown --with-segments --segments v2`, the published
 * `segment-envelope-v2` contract (`contract: "hwp-segment-envelope-v2"`,
 * `schema_version: "1.0"`). The engine opts in with `--segments v2`, so this
 * parser handles that one shape only and never branches on envelope version.
 *
 * Segment shape verified against the hwp-cli v0.20.0 release binary: both
 * captures under test/fixtures/cat-segments-*.json were re-produced by that
 * binary from the commands recorded in the test file. Re-verified unchanged
 * against v1.4.0 (same contract, schema_version, kinds, and wire keys), so
 * the strict parser below accepts the 0.20.x and 1.4.x envelopes alike.
 *
 * The wire envelope carries `{id, kind, path: {section, indices},
 * char_range: {start, end}, style, direct}` per segment, with ranges that
 * NEST (a run inside its para, a cell inside its table). What this module
 * publishes is the projection the rest of the editor already consumes: the
 * `CatEnvelope` projection retains `id`, with `start`/`end` from
 * `char_range`, `section` from `path.section`, and `para` from
 * `path.indices[0]` (the top-level paragraph index, the coordinate
 * `SegmentRef` uses as a fallback for older host projections). Checksummed IDs
 * and nesting indices are retained for exact layout joins and editing; per-level
 * styles are not projected.
 *
 * `char_range`, `Segment.start`, and `Segment.end` use Unicode scalar offsets.
 * `segmentText` converts those boundaries to JS UTF-16 offsets only when slicing.
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
  /** Checksummed v2 id; optional for older host-projected envelopes. */
  id?: string;
  /** Full v2 nesting path, including run index for run segments. */
  indices?: number[];
  /** Start Unicode scalar offset into `markdown` (inclusive). */
  start: number;
  /** End Unicode scalar offset into `markdown` (exclusive). */
  end: number;
  /** What the range is; the v2 envelope emits all seven kinds. */
  kind: SegmentKind;
  /** 0-based HWP section index, from `path.section`. */
  section: number;
  /** 0-based top-level paragraph index within the section, from `path.indices[0]`. */
  para: number;
  /** Published direct character properties used for structural similarity. */
  directChar?: DirectChar;
  /** Published direct paragraph properties used for structural similarity. */
  directPara?: DirectPara;
}

export interface DirectChar {
  bold: boolean;
  italic: boolean;
  size_pt: number;
  color: string;
  faces: (string | null)[];
  face_ids: number[];
}

export interface DirectPara {
  alignment: string;
  indent: number;
  line_spacing: number;
  line_spacing_type: number;
}

export interface CatEnvelope {
  markdown: string;
  segments: Segment[];
}

/** Source coordinate of a segment in the document body. */
export interface SegmentRef {
  /** Disambiguates nested segments sharing a top-level paragraph. */
  id?: string;
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
  const { id, kind, path, char_range, direct } = raw as Record<string, unknown>;
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
  const d = direct as Record<string, unknown> | undefined;
  if (direct !== undefined && (typeof direct !== "object" || direct === null || Array.isArray(direct))) {
    throw new Error("segments envelope: malformed direct properties; upgrade the host adapter to project valid v2 metadata.");
  }
  const char = d?.char as Record<string, unknown> | null | undefined;
  const para = d?.para as Record<string, unknown> | null | undefined;
  if ((d?.char !== undefined && d.char !== null && (typeof d.char !== "object" || Array.isArray(d.char))) ||
      (d?.para !== undefined && d.para !== null && (typeof d.para !== "object" || Array.isArray(d.para)))) {
    throw new Error("segments envelope: malformed direct properties; upgrade the host adapter to project valid v2 metadata.");
  }
  const directChar = char == null ? undefined : projectDirectChar(char);
  const directPara = para == null ? undefined : projectDirectPara(para);
  return {
    id,
    indices: p.indices,
    start: range.start,
    end: range.end,
    kind: kind as SegmentKind,
    section: p.section,
    para: p.indices[0]!,
    ...(directChar === undefined ? {} : { directChar }),
    ...(directPara === undefined ? {} : { directPara }),
  };
}

function projectDirectChar(value: unknown): DirectChar {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("segments envelope: malformed direct.char properties; upgrade the host adapter to project valid v2 metadata.");
  }
  const v = value as Record<string, unknown>;
  const { bold, italic, size_pt, color, faces, face_ids } = v;
  if (typeof bold !== "boolean" || typeof italic !== "boolean" ||
      typeof size_pt !== "number" || !Number.isFinite(size_pt) ||
      typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color) || !Array.isArray(faces) || faces.length !== 7 ||
      !faces.every((x) => typeof x === "string" || x === null) || !isNumberArray(face_ids) || face_ids.length !== 7 ||
      face_ids.some((x) => !Number.isInteger(x) || x < 0)) {
    throw new Error("segments envelope: malformed direct.char properties; upgrade the host adapter to project valid v2 metadata.");
  }
  return { bold, italic, size_pt, color, faces, face_ids };
}

function projectDirectPara(value: unknown): DirectPara {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("segments envelope: malformed direct.para properties; upgrade the host adapter to project valid v2 metadata.");
  }
  const v = value as Record<string, unknown>;
  const { alignment, indent, line_spacing, line_spacing_type } = v;
  if (typeof alignment !== "string" || !["justify", "left", "right", "center", "distribute", "divide", "unknown"].includes(alignment) ||
      typeof indent !== "number" || !Number.isInteger(indent) ||
      typeof line_spacing !== "number" || !Number.isInteger(line_spacing) ||
      typeof line_spacing_type !== "number" || !Number.isInteger(line_spacing_type) || line_spacing_type < 0 || line_spacing_type > 255) {
    throw new Error("segments envelope: malformed direct.para properties; upgrade the host adapter to project valid v2 metadata.");
  }
  return { alignment, indent, line_spacing, line_spacing_type };
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
  const projected = segments.map(projectSegment);
  const envelope = { markdown, segments: projected };
  boundaryInfo(envelope);
  return envelope;
}

interface BoundaryInfo {
  scalarLength: number;
  utf16ByScalar: Map<number, number>;
}

const boundaryCache = new WeakMap<CatEnvelope, BoundaryInfo>();

/** Resolve only scalar boundaries used by this envelope's segment ranges. */
function boundaryInfo(envelope: CatEnvelope): BoundaryInfo {
  const cached = boundaryCache.get(envelope);
  if (cached !== undefined) return cached;
  const wanted = new Set<number>();
  for (const segment of envelope.segments) {
    if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end) || segment.start < 0 || segment.end < segment.start) {
      throw new Error("segments envelope: malformed character range");
    }
    wanted.add(segment.start);
    wanted.add(segment.end);
  }
  wanted.add(0);
  const utf16ByScalar = new Map<number, number>();
  let scalar = 0;
  let utf16 = 0;
  if (wanted.has(0)) utf16ByScalar.set(0, 0);
  for (const point of envelope.markdown) {
    scalar++;
    utf16 += point.length;
    if (wanted.has(scalar)) utf16ByScalar.set(scalar, utf16);
  }
  for (const offset of wanted) {
    if (!utf16ByScalar.has(offset)) throw new Error("segments envelope: character range exceeds markdown");
  }
  const info = { scalarLength: scalar, utf16ByScalar };
  boundaryCache.set(envelope, info);
  return info;
}

/** Return the Markdown length in the envelope's Unicode scalar coordinate system. */
export function markdownLength(envelope: CatEnvelope): number {
  return boundaryInfo(envelope).scalarLength;
}

/** Revalidate optional metadata from a projected transport envelope before it drives behavior. */
export function validateProjectedMetadata(envelope: CatEnvelope): CatEnvelope {
  let changed = false;
  const segments = envelope.segments.map((segment) => {
    const nullable = segment as Segment & { directChar?: DirectChar | null; directPara?: DirectPara | null };
    let normalized = segment;
    if (nullable.directChar === null || nullable.directPara === null) {
      normalized = { ...segment };
      if (nullable.directChar === null) { delete normalized.directChar; changed = true; }
      if (nullable.directPara === null) { delete normalized.directPara; changed = true; }
    }
    if (normalized.directChar !== undefined) projectDirectChar(normalized.directChar);
    if (normalized.directPara !== undefined) projectDirectPara(normalized.directPara);
    return normalized;
  });
  return changed ? { ...envelope, segments } : envelope;
}

/** Extract the source coordinate of a segment. */
export function segmentRef(segment: Segment): SegmentRef {
  return {
    section: segment.section,
    para: segment.para,
    ...(segment.id === undefined ? {} : { id: segment.id }),
  };
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
    (s) => ref.id !== undefined
      ? s.id === ref.id
      : s.section === ref.section && s.para === ref.para,
  );
}

/** Slice the markdown text covered by a segment. */
export function segmentText(envelope: CatEnvelope, segment: Segment): string {
  const info = boundaryInfo(envelope);
  const start = info.utf16ByScalar.get(segment.start);
  const end = info.utf16ByScalar.get(segment.end);
  if (start === undefined || end === undefined) throw new Error("segments envelope: segment range is not in this envelope");
  return envelope.markdown.slice(start, end);
}

/** Map a markdown offset to its source coordinate, if inside a segment. */
export function offsetToRef(
  envelope: CatEnvelope,
  offset: number,
): SegmentRef | undefined {
  const s = segmentAtOffset(envelope, offset);
  return s === undefined ? undefined : segmentRef(s);
}
