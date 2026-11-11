/**
 * Types and parser for the v2 segment envelope:
 * `hwp cat --format markdown --with-segments --segments v2`, the published
 * `segment-envelope-v2` contract (`contract: "hwp-segment-envelope-v2"`,
 * schema major 1). The engine opts in with `--segments v2`, so this
 * parser handles that one shape only and never branches on envelope version.
 *
 * Segment shape verified against the hwp-cli v0.20.0 release binary: both
 * captures under test/fixtures/cat-segments-*.json were re-produced by that
 * binary from the commands recorded in the test file. Re-verified unchanged
 * against v1.4.0 (same contract, schema_version, kinds, and wire keys), so
 * the strict parser below accepts the 0.20.x and 1.4.x envelopes alike.
 *
 * Re-verified against v1.6.1, whose `--segments v2` envelope is schema `1.1`:
 * the only delta is an optional `source_chars` on `run` segments, absolute
 * UTF-16 offsets into the source paragraph, projected here as
 * `Segment.sourceChars`. A schema `1.0` host omits the field, so a consumer
 * gates the feature on the field's presence rather than on the version: the
 * 1.6.1 capture in test/fixtures/cat-segments-runs.json is the same document
 * 1.4.0 emits at `1.0`, minus that field, which is what `parseCatEnvelope`'s
 * additive-schema cases hold. The version test below is a supported-major
 * match on purpose (REVIEW.md): pinning an exact minor would refuse this
 * envelope.
 *
 * The wire envelope carries `{id, kind, path: {section, indices},
 * char_range: {start, end}, style, direct}` per segment, with ranges that
 * NEST (a run inside its para, a cell inside its table). What this module
 * publishes is the projection the rest of the editor already consumes: the
 * `CatEnvelope` projection retains `id`, with `start`/`end` from
 * `char_range`, `section` from `path.section`, and `para` from
 * `path.indices[0]` (the top-level paragraph index, the coordinate
 * `SegmentRef` uses as a fallback for older host projections). Checksummed IDs
 * and nesting indices are retained for exact layout joins and editing. Direct
 * character/paragraph attributes are validated and retained; inherited style levels are not projected.
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
  /**
   * The inherited style level (`style` on the wire), resolved to the same
   * shape ids and attributes the direct level carries. Present on every kind
   * an hwp-cli 1.4.0 host publishes.
   */
  style?: ShapeAttrs;
  /**
   * The direct level (`direct` on the wire) with its shape ids, which
   * `directChar`/`directPara` drop. `hasDirectFormatting` compares it with
   * `style` to answer whether this segment carries formatting of its own.
   */
  direct?: ShapeAttrs;
  /**
   * Source coverage of this run piece, on the `run` segments of a schema `1.1`
   * host (`source_chars` on the wire).
   *
   * `[start, end)` in UTF-16 code units ABSOLUTE within the source paragraph,
   * the same unit and origin as `edit-ops-v1` `address.chars` and
   * `render-layout-v1` `source_chars`; `runSourceRange` maps a markdown window
   * onto it. A run that a block control interrupts is published once per
   * contiguous piece, each carrying its own span. Absent on a schema `1.0`
   * host, which is the feature gate: no version check is needed.
   */
  sourceChars?: { start: number; end: number };
}

/**
 * A resolved character/paragraph shape pair: what `styles-v1` publishes as
 * `attrs` and what the segment envelope publishes at its `style` and `direct`
 * levels.
 *
 * Either side can be absent, and the omission is information rather than a
 * gap: both contracts publish `char` and `para` as independently nullable, and
 * `null` means THAT SIDE'S SHAPE ID DOES NOT RESOLVE in this document's header
 * table. A level whose character shape is unreachable still states its
 * paragraph shape, so dropping the whole level would throw away what the
 * document does answer; a consumer that needs one side checks for it.
 */
export interface ShapeAttrs {
  char?: DirectChar;
  para?: DirectPara;
  /** Shape ids when this host projects them; hwp-cli 1.4.0 always does. */
  charShapeId?: number;
  paraShapeId?: number;
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
    throw new Error("segments envelope: malformed segment path or range; upgrade the host adapter to emit valid segment-envelope-v2 data, then reload.");
  }
  const { id, kind, path, char_range, direct } = raw as Record<string, unknown>;
  const range = char_range as Record<string, unknown> | undefined;
  const p = path as Record<string, unknown> | undefined;
  if (
    typeof id !== "string" ||
    typeof kind !== "string" ||
    !SEGMENT_KINDS.includes(kind as SegmentKind) ||
    typeof p !== "object" || p === null ||
    typeof p.section !== "number" || !Number.isInteger(p.section) || p.section < 0 ||
    !isNumberArray(p.indices) || p.indices.length === 0 || p.indices.some(index => !Number.isInteger(index) || index < 0) ||
    typeof range !== "object" || range === null ||
    typeof range.start !== "number" ||
    typeof range.end !== "number"
  ) {
    throw new Error("segments envelope: malformed segment path or range; upgrade the host adapter to emit valid segment-envelope-v2 data, then reload.");
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
  const style = projectShapeLevel((raw as Record<string, unknown>).style, "segment.style");
  const directShape = projectShapeLevel(direct, "segment.direct");
  const sourceChars = projectSourceChars((raw as Record<string, unknown>).source_chars, kind as SegmentKind);
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
    ...(style === undefined ? {} : { style }),
    ...(directShape === undefined ? {} : { direct: directShape }),
    ...(sourceChars === undefined ? {} : { sourceChars }),
  };
}

/**
 * Project a run piece's `source_chars`, the schema `1.1` optional field.
 *
 * Absent is the whole story for a `1.0` host, so absence answers `undefined`
 * rather than refusing. Present, it is held to the contract the schema states:
 * the field exists on `run` segments and no other kind (the schema enforces
 * that direction, and a strict parser must too), both bounds are nonnegative
 * integers, and the range is never zero-length — a piece with nothing to
 * report is not published at all. The unit is UTF-16 code units absolute
 * within the source paragraph, which this function does not reinterpret.
 */
function projectSourceChars(value: unknown, kind: SegmentKind): { start: number; end: number } | undefined {
  if (value === undefined) return undefined;
  if (kind !== "run") {
    throw new Error("segments envelope: source_chars outside a run segment; upgrade the host adapter to emit valid segment-envelope-v2 schema 1.1 data.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("segments envelope: malformed source_chars; upgrade the host adapter to project valid run source offsets.");
  }
  const { start, end } = value as Record<string, unknown>;
  if (typeof start !== "number" || typeof end !== "number" ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error("segments envelope: malformed source_chars; upgrade the host adapter to project an ordered, nonempty run source range.");
  }
  return { start, end };
}

/**
 * Project one shape level, or `undefined` when the host published none.
 *
 * A level whose `char` and `para` are both null is the engine's own "this
 * level adds nothing" spelling (measured on segments that carry no direct
 * formatting), not a malformed one, so it is dropped rather than refused: a
 * dropped level makes `hasDirectFormatting` answer false, which is exactly
 * what a missing level means.
 */
function projectShapeLevel(value: unknown, field: string): ShapeAttrs | undefined {
  if (value === undefined || value === null) return undefined;
  const level = value as Record<string, unknown>;
  if (typeof value !== "object" || Array.isArray(level)) {
    throw new Error(`${field}: malformed shape attributes; upgrade the host adapter to project valid v2 metadata.`);
  }
  if (level.char == null && level.para == null) return undefined;
  return projectShapeAttrs(value, field);
}

/**
 * Project one `{char, para, char_shape_id, para_shape_id}` object — the shape
 * `styles-v1` calls `attrs` and the segment envelope publishes as `style` and
 * `direct` — reusing the direct-level validators so both levels are held to
 * one rule.
 *
 * Each side is projected on its own. Both contracts make `char` and `para`
 * independently nullable, because one shape id can fail to resolve while the
 * other does, and the engine emits a null side for exactly that case
 * (`char_shape_id_at` none ⇒ `char: null`). Requiring both would reject the
 * whole envelope or the whole style table over one unreachable shape, so a
 * null side is omitted and the side that did resolve is kept.
 */
export function projectShapeAttrs(value: unknown, field: string): ShapeAttrs {
  const attrs = value as Record<string, unknown> | null | undefined;
  if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) {
    throw new Error(`${field}: malformed shape attributes; upgrade the host adapter to project valid v2 metadata.`);
  }
  const char = attrs.char;
  const para = attrs.para;
  // Both spellings are read on purpose: the engine writes `char_shape_id`, and
  // this function's own projection writes `charShapeId`, which a `/styles`
  // body carries back through `parseStyleTableResponse`. One reader for one
  // shape, so a projected table round-trips instead of losing its ids.
  // `null` is the contract's "the level is unreachable" and reads as absent.
  const charShapeId = attrs.char_shape_id ?? attrs.charShapeId;
  const paraShapeId = attrs.para_shape_id ?? attrs.paraShapeId;
  if (char !== undefined && char !== null && (typeof char !== "object" || Array.isArray(char))) {
    throw new Error(`${field}: malformed char shape; upgrade the host adapter to project valid v2 metadata.`);
  }
  if (para !== undefined && para !== null && (typeof para !== "object" || Array.isArray(para))) {
    throw new Error(`${field}: malformed para shape; upgrade the host adapter to project valid v2 metadata.`);
  }
  // The ids are carried by hwp-cli 1.4.0 on every level, but an older
  // projection publishes the attributes without them, and those attributes are
  // still what `hasDirectFormatting` compares. Validated when present, dropped
  // when absent — never invented.
  if ((charShapeId !== undefined && (typeof charShapeId !== "number" || !Number.isInteger(charShapeId) || charShapeId < 0)) ||
      (paraShapeId !== undefined && (typeof paraShapeId !== "number" || !Number.isInteger(paraShapeId) || paraShapeId < 0))) {
    throw new Error(`${field}: malformed shape ids; upgrade the host adapter to project valid v2 metadata.`);
  }
  return {
    ...(char === undefined || char === null ? {} : { char: projectDirectChar(char) }),
    ...(para === undefined || para === null ? {} : { para: projectDirectPara(para) }),
    ...(charShapeId === undefined ? {} : { charShapeId: charShapeId as number }),
    ...(paraShapeId === undefined ? {} : { paraShapeId: paraShapeId as number }),
  };
}

/**
 * Whether a segment carries formatting of its own below its style: the
 * two levels the v2 envelope publishes resolve differently. A segment without
 * both levels is inconclusive and answers `false`, because claiming direct
 * formatting the host did not publish would offer a "clear" that has nothing
 * to clear.
 */
export function hasDirectFormatting(segment: Segment): boolean {
  const { style, direct } = segment;
  if (style === undefined || direct === undefined) return false;
  return !(sameAttrs(style, direct));
}

/**
 * Compare two levels attribute by attribute, over the sides both publish. A
 * side the document could not resolve on one level and resolved on the other
 * is not the same formatting, so the presence itself is compared first.
 */
function sameAttrs(a: ShapeAttrs, b: ShapeAttrs): boolean {
  if (a.charShapeId !== b.charShapeId || a.paraShapeId !== b.paraShapeId) return false;
  if ((a.char === undefined) !== (b.char === undefined)) return false;
  if ((a.para === undefined) !== (b.para === undefined)) return false;
  if (a.char !== undefined && b.char !== undefined && !(
    a.char.bold === b.char.bold && a.char.italic === b.char.italic &&
    a.char.size_pt === b.char.size_pt && a.char.color === b.char.color &&
    a.char.faces.join("\u0000") === b.char.faces.join("\u0000") &&
    a.char.face_ids.join(",") === b.char.face_ids.join(",")
  )) return false;
  if (a.para !== undefined && b.para !== undefined && !(
    a.para.alignment === b.para.alignment && a.para.indent === b.para.indent &&
    a.para.line_spacing === b.para.line_spacing &&
    a.para.line_spacing_type === b.para.line_spacing_type
  )) return false;
  return true;
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
    throw new Error("segments envelope: not an object; upgrade the host adapter to emit segment-envelope-v2 JSON, then reload.");
  }
  const { schema_version, contract, markdown, segments } = raw as Record<string, unknown>;
  if (contract !== "hwp-segment-envelope-v2" || typeof schema_version !== "string" || !/^1[.][0-9]+$/.test(schema_version)) {
    throw new Error("segments envelope: not a v2 envelope (contract or schema major); upgrade the host adapter to emit segment-envelope-v2 schema 1.x, then reload.");
  }
  if (typeof markdown !== "string" || !Array.isArray(segments)) {
    throw new Error("segments envelope: missing markdown string or segments array; upgrade the host adapter to emit complete segment-envelope-v2 data, then reload.");
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
      throw new Error("segments envelope: malformed character range; upgrade the host adapter to emit nonnegative scalar offsets, then reload.");
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
    if (!utf16ByScalar.has(offset)) throw new Error("segments envelope: character range exceeds markdown; upgrade the host adapter to emit offsets into its own Markdown, then reload.");
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
  // A host can project offsets that run past its own Markdown. Fail the read
  // with the boundary message here, rather than crashing render in
  // segmentText, where no error boundary catches it.
  boundaryInfo(envelope);
  let changed = false;
  const segments = envelope.segments.map((segment) => {
    const nullable = segment as Segment & {
      directChar?: DirectChar | null;
      directPara?: DirectPara | null;
      style?: ShapeAttrs | null;
      direct?: ShapeAttrs | null;
      sourceChars?: Segment["sourceChars"] | null;
    };
    let normalized = segment;
    // Copy on the first normalization, so the caller's object is never the
    // one that loses a property.
    let copied = false;
    const detach = (): void => {
      if (copied) return;
      normalized = { ...segment };
      copied = true;
      changed = true;
    };
    if (nullable.directChar === null) { detach(); delete normalized.directChar; }
    if (nullable.directPara === null) { detach(); delete normalized.directPara; }
    if (nullable.sourceChars === null) { detach(); delete normalized.sourceChars; }
    if (normalized.directChar !== undefined) projectDirectChar(normalized.directChar);
    if (normalized.directPara !== undefined) projectDirectPara(normalized.directPara);
    if (normalized.sourceChars !== undefined) projectSourceChars(normalized.sourceChars, normalized.kind);
    // A level that projects to nothing (null, or the engine's null-char/null-
    // para spelling) is removed, so a consumer reads one shape for "no level"
    // instead of two. A malformed level still throws, through the same helper.
    if (nullable.style !== undefined && projectShapeLevel(nullable.style, "segment.style") === undefined) {
      detach();
      delete normalized.style;
    }
    if (nullable.direct !== undefined && projectShapeLevel(nullable.direct, "segment.direct") === undefined) {
      detach();
      delete normalized.direct;
    }
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
  if (start === undefined || end === undefined) throw new Error("segments envelope: segment range is not in this envelope; reload the document before selecting it again.");
  return envelope.markdown.slice(start, end);
}

/**
 * Map a markdown scalar window inside one run piece to the source WCHAR
 * window an edit-ops-v1 `address.chars` takes, or `undefined` when the
 * projection cannot be read back character for character.
 *
 * This is the one place the two coordinate spaces meet, and they only meet
 * exactly: the emitted fragment is the source text unless the engine wraps or
 * rewrites it. So the mapping is checked, never assumed. The marker pair a
 * bold, italic or bold-italic run is wrapped in is stripped only when the
 * run's own `directChar` says it IS a marker (a literal `*Note*` projects like
 * an italic run, and the direct level is what tells them apart), and what
 * remains must be exactly as long as the published source span. An underline
 * (`<u>…</u>`) or strike (`~~…~~`) wrapper, an escaped `&`/`<`, a trimmed
 * fragment and an inline control counted in the source span all fail one of
 * those checks, and the caller keeps the whole run instead of guessing a
 * window that would format the wrong source characters.
 *
 * The window is half-open and expressed in scalars into the emitted markdown;
 * a surrogate pair inside it counts once for the range and twice for the
 * source, which is why the offsets are summed per code point rather than
 * subtracted.
 */
export function runSourceRange(
  envelope: CatEnvelope,
  run: Segment,
  start: number,
  end: number,
): [number, number] | undefined {
  const source = run.sourceChars;
  if (source === undefined || !Number.isInteger(start) || !Number.isInteger(end) ||
      start < run.start || end > run.end || start >= end) return undefined;
  const inner = runWindowText(run, segmentText(envelope, run));
  if (inner === undefined) return undefined;
  const base = run.start + inner.offset;
  const from = start - base;
  const to = end - base;
  const text = [...inner.text];
  if (from < 0 || to > text.length || from >= to) return undefined;
  // The visible text and the source span must be the same characters. A
  // control counted in the source, an escape that grows the output, or a
  // trim that shrinks it all break this equality; nothing converts between
  // the spaces, so a mismatch is a refusal rather than an estimate. The
  // source span of a formatted run also holds the edge whitespace the marker
  // pair was placed inside, so those widths are part of the comparison and of
  // the window's origin.
  if (inner.lead + inner.text.length + inner.trail !== source.end - source.start) return undefined;
  let utf16 = 0;
  for (let at = 0; at < from; at++) utf16 += text[at]!.length;
  const utf16Start = utf16;
  for (let at = from; at < to; at++) utf16 += text[at]!.length;
  const sourceBase = source.start + inner.lead;
  return [sourceBase + utf16Start, sourceBase + utf16];
}

/**
 * A run's text inside the emitted fragment, the scalar offset where it starts,
 * and the width of the edge whitespace the marker pair was placed inside.
 *
 * A run that its character properties mark bold, italic or both is wrapped in
 * exactly that marker pair, and the wrapper is removed only when the wrapper
 * found and the properties agree. The engine wraps the run's TRIMMED text and
 * leaves its edge whitespace outside the markers (a bold `" / "` projects as
 * space, the bold marker pair, `/`, the pair again, space, measured on
 * 1.6.1), so the pattern allows whitespace around the pair and the returned
 * offset points at the first non-space character; a window in that edge
 * whitespace is refused.
 *
 * A plain run is read as itself: the engine does not escape `*`, so a literal
 * `*Note*` projects exactly like an italic run, and the direct level is what
 * tells them apart. Other wrappers (underline, strike, links, escapes) are
 * left in place; the caller's length check refuses them, because they are not
 * published in `directChar`.
 */
function runWindowText(
  run: Segment,
  markdown: string,
): { text: string; offset: number; lead: number; trail: number } | undefined {
  const direct = run.directChar;
  if (direct === undefined) return undefined;
  if (!direct.bold && !direct.italic) return { text: markdown, offset: 0, lead: 0, trail: 0 };
  const stars = direct.bold && direct.italic ? 3 : direct.bold ? 2 : 1;
  const marker = "\\*".repeat(stars);
  const wrapped = new RegExp(`^(\\s*)${marker}([\\s\\S]+)${marker}(\\s*)$`, "u").exec(markdown);
  if (wrapped === null) return undefined;
  const text = wrapped[2]!;
  if (text !== text.trim()) return undefined;
  const lead = [...wrapped[1]!].length;
  return { text, offset: lead + stars, lead, trail: [...wrapped[3]!].length };
}

/** Map a markdown offset to its source coordinate, if inside a segment. */
export function offsetToRef(
  envelope: CatEnvelope,
  offset: number,
): SegmentRef | undefined {
  const s = segmentAtOffset(envelope, offset);
  return s === undefined ? undefined : segmentRef(s);
}
