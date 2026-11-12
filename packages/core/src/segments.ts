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
   * `render-layout-v1` `source_chars`; `runCoverage` maps a markdown window
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
  /**
   * How many tables the engine counts in the body: `body.tables` from
   * `hwp info --json --body-stats`, read beside the envelope by the CLI engine
   * (#97 item 1). The count comes from the same nth-table walk `hwp edit`
   * addresses, and that walk also reaches a table inside a footnote, a header,
   * a footer or a hidden comment, which the envelope publishes no `table`
   * segment for. It equals the number of `table` segments whenever the document
   * holds no such table; a difference means the number of every table published
   * after such a table names another table than the reader picked, which is why
   * the guard `tableCountMismatch` refuses all of them rather than sorting that
   * out (#101 item 3).
   *
   * Optional because the statistic is opt-in: `--body-stats` is off by default,
   * so a host that does not ask for it publishes no count.
   */
  bodyTables?: number;
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
 * v2 wire shape: a missing or wrong `contract`/`schema_version` pair, a
 * malformed payload, or a segment outside the seven-kind, path-plus-char_range
 * shape.
 */
export function parseCatEnvelope(json: string): CatEnvelope {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("segments envelope: not an object; upgrade the host adapter to emit segment-envelope-v2 JSON, then reload.");
  }
  const { schema_version, contract } = raw as Record<string, unknown>;
  if (contract !== "hwp-segment-envelope-v2" || typeof schema_version !== "string" || !/^1[.][0-9]+$/.test(schema_version)) {
    throw new Error("segments envelope: not a v2 envelope (contract or schema major); upgrade the host adapter to emit segment-envelope-v2 schema 1.x, then reload.");
  }
  return projectEnvelope(raw);
}

/**
 * Check an envelope a host hands over ALREADY DECODED, which is what an
 * in-process `HwpEngine`'s `read` returns: the `Segment`s themselves, with no
 * `path`, `char_range` or wire header to project. So this is not the wire
 * projection - it is the two contracts render depends on, answered by the same
 * vocabulary the projection uses: the seven segment kinds, and every offset
 * being a boundary of this markdown (the check `segmentText` throws from when
 * it runs inside render).
 *
 * Each message names the cause and the next step, because the reader is a host
 * wiring its own `HwpEngine`: a result this function refuses must be fixed at
 * the adapter rather than discovered later by a component (`#58` item 19d).
 */
export function validateCatEnvelope(raw: unknown): CatEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("segments envelope: not an object; upgrade the host adapter to emit segment-envelope-v2 JSON, then reload.");
  }
  const { markdown, segments } = raw as Record<string, unknown>;
  if (typeof markdown !== "string" || !Array.isArray(segments)) {
    throw new Error("segments envelope: missing markdown string or segments array; upgrade the host adapter to emit complete segment-envelope-v2 data, then reload.");
  }
  if (!segments.every((segment) => typeof segment === "object" && segment !== null &&
      SEGMENT_KINDS.includes((segment as { kind: SegmentKind }).kind))) {
    throw new Error("segments envelope: unknown segment kind; upgrade the host adapter to project the seven segment-envelope-v2 kinds, then reload.");
  }
  // The caller's own object, not a rebuilt copy: a published envelope carries
  // fields beyond markdown and segments (the engine's `bodyTables`, for one),
  // and dropping them would silently disable what reads them.
  const envelope = raw as CatEnvelope;
  boundaryInfo(envelope);
  return envelope;
}

/**
 * Project a wire payload to the published envelope.
 *
 * The `path`/`char_range` half is the wire's own; a host that decoded its read
 * result itself is held to the published shape by {@link validateCatEnvelope}.
 */
function projectEnvelope(raw: unknown): CatEnvelope {
  const { markdown, segments } = raw as Record<string, unknown>;
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

/** How many `table` segments the envelope publishes, in document order. */
export function publishedTableCount(envelope: CatEnvelope): number {
  return envelope.segments.reduce(
    (count, segment) => count + (segment.kind === "table" ? 1 : 0),
    0,
  );
}

/**
 * The two counts that can disagree, or `null` when they agree or the host
 * published none (#97 item 1).
 *
 * `bodyTables` is the engine's own nth-table walk, which also counts a table
 * inside a footnote, a header, a footer or a hidden comment. The envelope
 * projects none of that content, so no `table` segment stands for such a table,
 * and one of them shifts the number of every table published after it: `hwp
 * edit --set-cell 0:1:0=...` then writes into a table the panel numbered
 * differently, or into that unpublished table while the panel showed the body's
 * (#97). A count below the published number has no such walker behind it, so
 * the number is not trustworthy in either direction and the guard reads both as
 * the same refusal (#101 items 2 and 3).
 *
 * An absent count is not a mismatch. The statistic is opt-in and a host may not
 * send it, and refusing every table op on such a host would take table editing
 * away from documents that are perfectly addressable.
 */
export function tableCountMismatch(
  envelope: CatEnvelope,
): { engine: number; published: number } | null {
  const engine = envelope.bodyTables;
  if (engine === undefined) return null;
  const published = publishedTableCount(envelope);
  return engine === published ? null : { engine, published };
}

/** Whether a projected count is the non-negative integer the guard can trust. */
function isTableCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Revalidate optional metadata from a projected transport envelope before it drives behavior. */
export function validateProjectedMetadata(envelope: CatEnvelope): CatEnvelope {
  // A host can project offsets that run past its own Markdown. Fail the read
  // with the boundary message here, rather than crashing render in
  // segmentText, where no error boundary catches it.
  boundaryInfo(envelope);
  // A count that is not a non-negative integer is dropped instead of failing
  // the read: it is an optional engine statistic, and dropping it leaves the
  // same "no count published" answer an older host gives (#97 item 1).
  const projectedCount = envelope.bodyTables as unknown;
  const dropCount = projectedCount !== undefined && !isTableCount(projectedCount);
  let changed = dropCount;
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
  if (!changed) return envelope;
  const projected: CatEnvelope = { ...envelope, segments };
  if (dropCount) delete projected.bodyTables;
  return projected;
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
 * The document format, as far as the sub-run mapping has to know it.
 *
 * The two formats publish the same `source_chars` numbers for different
 * reasons, so a rule that reads a span has to be told which one it is reading.
 * `unknown` is a real answer and gets no allowance at all, which is the same
 * answer as a document whose format the caller did not pass.
 */
export type DocumentFormat = "hwp" | "hwpx" | "unknown";

/** CFBF/OLE2 container signature: the first eight bytes of every HWP5 file. */
const CFBF_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/**
 * The OPC media type an HWPX package declares in its first zip entry.
 *
 * hwp-cli's own writer emits that entry first and STORED
 * (hwp-cli/crates/hwpx/src/write/mod.rs:331-332), and `hwp validate` warns when
 * the layout is violated (commands/validate.rs:100-103). The layout was checked
 * against 19 real HWPX files — 14 hwp-cli-produced and 5 Hancom-authored — and
 * 19 of 19 passed.
 */
const HWPX_MIMETYPE = "application/hwp+zip";

/**
 * Which format these bytes are, from the container header alone, or `null`
 * when the header names no container this rule knows.
 *
 * The one reader for that question. The server's upload gate
 * (`routes.ts:sniffFormat`) refuses an upload whose header answers `null` and
 * admits nothing else; `documentFormat` below lets the file name answer
 * instead, because opening a document the editor can read matters more than a
 * strict admission check. Strictness is the call site's, so the two byte checks
 * exist once.
 *
 * An HWPX package declares its media type in a first, STORED `mimetype` entry;
 * a `PK\x03\x04` header without one is some other zip, not evidence either way.
 */
export function sniffDocumentFormat(data: Uint8Array | undefined): "hwp" | "hwpx" | null {
  if (data === undefined) return null;
  if (data.length >= CFBF_SIGNATURE.length && CFBF_SIGNATURE.every((byte, at) => data[at] === byte)) {
    return "hwp";
  }
  // 30-byte local file header + the 8-byte `mimetype` name is the floor.
  if (data.length < 38) return null;
  if (!(data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(8, true) !== 0) return null;
  if (view.getUint16(26, true) !== 8) return null;
  if (new TextDecoder().decode(data.subarray(30, 38)) !== "mimetype") return null;
  const start = 38 + view.getUint16(28, true);
  const end = start + HWPX_MIMETYPE.length;
  if (data.length < end) return null;
  return new TextDecoder().decode(data.subarray(start, end)) === HWPX_MIMETYPE ? "hwpx" : null;
}

/**
 * Which format the document is: the bytes decide, the name is only the
 * fallback, and a disagreement between them is `unknown`.
 *
 * The extension is a label a host or a person chose, and hwp-cli reads the
 * format from the content, so an HWPX file saved as `.hwp` opens fine and then
 * answered this question wrongly: it was handed the HWP5 allowance for a stored
 * paragraph break, and every window in it landed one unit early. So the
 * container header is read first, and the file name only speaks when the
 * header names no container at all (a host that passes a stub, or a producer
 * whose package the sniff does not recognize).
 *
 * A header that contradicts the name answers `unknown` rather than picking a
 * side: no allowance is the safe answer when the two disagree, and it costs a
 * partial selection nothing but the widening it would have been given. A name
 * with neither extension is `unknown` too, never a default, because the two
 * rules differ by one character.
 */
export function documentFormat(name: string | undefined, data?: Uint8Array): DocumentFormat {
  const lower = name?.toLowerCase() ?? "";
  const named: DocumentFormat = lower.endsWith(".hwpx")
    ? "hwpx"
    : lower.endsWith(".hwp") ? "hwp" : "unknown";
  const sniffed = sniffDocumentFormat(data);
  if (sniffed === null) return named;
  if (named === "unknown") return sniffed;
  return sniffed === named ? sniffed : "unknown";
}

/** What a markdown scalar window inside one run piece can be named as. */
export type RunCoverage =
  /** The window covers no character the piece shows, so it names nothing. */
  | { kind: "none" }
  /** Only the whole piece can be named, so the window widens to it. */
  | { kind: "whole" }
  /** The window maps character for character; `[start, end)` in source WCHAR. */
  | { kind: "window"; range: [number, number] };

/**
 * Map a markdown scalar window inside one run piece to the source WCHAR
 * window an edit-ops-v1 `address.chars` takes, or say that this piece shows
 * nothing the window covers, or that only the whole piece can be named.
 *
 * This is the one place the two coordinate spaces meet, and they only meet
 * exactly: the emitted fragment is the source text unless the engine wraps or
 * rewrites it. So the mapping is an allow-list, never a length guess. The
 * marker pair a bold, italic or bold-italic run is wrapped in is stripped only
 * when the run's own `directChar` says it IS a marker (a literal `*Note*`
 * projects like an italic run, and the direct level is what tells them apart),
 * and what remains must hold no rewrite character at all: no `$…$` equation,
 * no second line, no `&`/`<` escape, no `[^N]` footnote, no `![](…)` image,
 * no `[text](url)` link, no `~~` strike, no backslash escape. A field,
 * bookmark or image segment overlapping the piece refuses it for the same
 * reason: those characters are published under a segment of their own, so an
 * equal length there is a coincidence rather than an identity.
 *
 * The published span must be the width the piece shows, with one allowance,
 * and the document's format decides it: an HWP5 paragraph stores its break as
 * the paragraph's last character, so that paragraph's last piece reads one
 * unit longer than the text it shows, and every other piece of either format
 * must be exact. HWPX does not store a break that way, and its piece has to be
 * exact too, because an HWPX fragment trims its edge whitespace and still
 * counts it: a leading or trailing space publishes the same `+1`, and reading
 * that unit as a break would shift every character of the piece by one. So
 * the format is a parameter and never an inference from the numbers - a
 * document-wide inference cannot tell those two shapes apart, and one HWPX
 * paragraph starting with a space was enough to make it grant the allowance
 * to a document that does not store the break. `unknown` gets no allowance.
 *
 * The window is clamped to the characters the run shows. A selection is drawn
 * over the rendered markdown, so its edges land on a marker or on the edge
 * whitespace the marker pair sits inside; those characters are not the window,
 * and the whitespace is part of it only when the selection covers it. A window
 * that clamps to nothing names nothing, which is not the same answer as a
 * window too large to map.
 *
 * Every offset here is counted in one unit at a time and the two units are
 * never added together: markdown offsets are Unicode scalars, source offsets
 * are UTF-16 code units, and a surrogate pair inside the window counts once
 * for the range and twice for the source, so the source width is summed per
 * code point rather than subtracted.
 */
export function runCoverage(
  envelope: CatEnvelope,
  run: Segment,
  start: number,
  end: number,
  format: DocumentFormat,
): RunCoverage {
  if (!Number.isInteger(start) || !Number.isInteger(end) ||
      start < run.start || end > run.end || start >= end) return { kind: "none" };
  if (start <= run.start && end >= run.end) return { kind: "whole" };
  const source = run.sourceChars;
  if (source === undefined) return { kind: "whole" };
  const fragment = segmentText(envelope, run);
  // Whether the window reaches a character this piece SHOWS is decided before
  // the fragment is read back, because a piece a block control split may carry
  // only one half of its marker pair (`**굵` and `게**` are the two pieces of
  // one bold run) and no window can be read out of a half pair. Answering
  // "whole" there would widen a drag that stopped on the opening marker.
  const shown = visibleSpan(run, fragment);
  if (Math.max(start, run.start + shown.start) >= Math.min(end, run.start + shown.end)) return { kind: "none" };
  const inner = runWindowText(run, fragment);
  if (inner === undefined) return { kind: "whole" };
  const chars = [...inner.text];
  const innerStart = run.start + inner.offset;
  const innerEnd = innerStart + chars.length;
  const from = Math.max(start, innerStart) - innerStart;
  const to = Math.min(end, innerEnd) - innerStart;
  // A window that stops on a marker or on the edge whitespace covers no
  // character of the run, so it names nothing: widening it to the whole piece
  // would format characters the selection never touched.
  if (from >= to) return { kind: "none" };
  if (!mapsBackExactly(envelope, run, inner, format)) return { kind: "whole" };
  let utf16 = 0;
  for (let at = 0; at < from; at++) utf16 += chars[at]!.length;
  const utf16Start = utf16;
  for (let at = from; at < to; at++) utf16 += chars[at]!.length;
  const sourceBase = source.start + inner.lead;
  const visible = inner.lead + inner.text.length + inner.trail;
  // Edge whitespace joins the window only when the selection covers it, and
  // never the paragraph break: the window ends at the last character the piece
  // shows, even where its published span runs one further.
  return { kind: "window", range: [
    start <= run.start ? source.start : sourceBase + utf16Start,
    end >= run.end ? source.start + visible : sourceBase + utf16,
  ] };
}

/**
 * Whether this piece's published source span is the text it shows.
 *
 * The allow-list is decided here so the window arithmetic never runs on a
 * fragment whose characters are not the source characters.
 */
function mapsBackExactly(
  envelope: CatEnvelope,
  run: Segment,
  inner: { text: string; lead: number; trail: number },
  format: DocumentFormat,
): boolean {
  if (REWRITTEN_FRAGMENT.test(inner.text)) return false;
  if (envelope.segments.some((nested) => (nested.kind === "field" || nested.kind === "bookmark" ||
      nested.kind === "image") && nested.start < run.end && nested.end > run.start)) return false;
  const source = run.sourceChars!;
  const span = source.end - source.start;
  const visible = inner.lead + inner.text.length + inner.trail;
  if (span === visible) return true;
  // An HWP5 paragraph stores its break as the paragraph's last character, so
  // that piece - and only that piece - ends one unit past the text it shows.
  return format === "hwp" && span === visible + 1 && isParagraphLastPiece(envelope, run);
}

/**
 * A fragment the engine rewrites rather than reproduces character for character.
 *
 * Measured on ahwp 1.6.1: `가$xy$나` projects as an equation, a hard break as
 * two spaces before the newline, a footnote as `[^N]`, an image as `![](…)`,
 * a link as `[text](url)`, and a literal `<`/`&` as an entity inside a table
 * cell. None of those lengths says anything about the source characters behind
 * them.
 *
 * This is deliberately wider than what 1.6.1 emits in a body paragraph, where
 * `a\b a&b a<b` comes back verbatim and the span equals the text: refusing
 * those costs a whole-run format, and the widening it prevents is the failure
 * this list exists to stop. The range hint says so.
 */
const REWRITTEN_FRAGMENT = /[$&\n<>\\]|\]\(|!\[|\[\^|~~/u;

/**
 * Whether this piece is the last its paragraph publishes.
 *
 * A `.hwp` paragraph stores its break as the paragraph's last character, so the
 * last piece ends one past the text it shows - a bound `address.chars` also
 * accepts (measured on ahwp 1.6.1: `[3, 7)` over `동일문 안내` formats `안내`
 * alone). No earlier piece may claim that unit.
 */
function isParagraphLastPiece(envelope: CatEnvelope, run: Segment): boolean {
  const own = run.sourceChars;
  if (own === undefined) return false;
  return !envelope.segments.some((sibling) => sibling !== run && sibling.kind === "run" &&
    sameParagraph(sibling, run) && sibling.sourceChars !== undefined && sibling.sourceChars.start >= own.end);
}

/** Two run pieces belong to one paragraph when their paths share a parent. */
function sameParagraph(a: Segment, b: Segment): boolean {
  if (a.section !== b.section || a.para !== b.para) return false;
  if (a.indices === undefined || b.indices === undefined) return true;
  if (a.indices.length !== b.indices.length) return false;
  const depth = a.indices.length - 1;
  return a.indices.slice(0, depth).every((index, at) => b.indices![at] === index);
}

/**
 * How the engine wrapped a piece's fragment in emphasis markers.
 *
 * `undefined` means the run carries no emphasis property, so the fragment is
 * the piece's own text. `bare` is the other way a fragment can be its own text:
 * the run is emphasis, and this piece's fragment holds no marker at all - which
 * is what a block-control split leaves in the middle of a wrapped run.
 *
 * The marker width comes from the run's own character properties, never from
 * counting stars: a bold run whose text starts with a literal `*` projects as
 * `***x`, and only two of those three stars are its pair - the third is a
 * character the piece shows. A piece a block control split can carry one half
 * of the pair only (`**굵` and `게**` are the two pieces of one bold run), and
 * that half is `stars` wide for the same reason. Both halves are read with a
 * pattern of exactly that width: counting stars on either side would swallow a
 * literal one, and would misread a closing piece whose text starts with a star
 * (`*y**` is the text `*y` and then the pair) as an opening one.
 *
 * The edge whitespace is the run's, not the marker's: the engine wraps the
 * run's trimmed text and leaves the whitespace outside the pair, so `lead` and
 * `trail` count scalars that the piece shows and a whole-run op formats.
 */
type EmphasisWrap =
  | { kind: "pair"; stars: number; lead: number; trail: number; inner: string }
  | { kind: "half"; side: "open" | "close"; stars: number; lead: number; trail: number }
  | { kind: "bare"; stars: number };

function emphasisWrap(run: Segment, fragment: string): EmphasisWrap | undefined {
  const direct = run.directChar;
  if (direct === undefined || (!direct.bold && !direct.italic)) return undefined;
  const stars = direct.bold && direct.italic ? 3 : direct.bold ? 2 : 1;
  const marker = "\\*".repeat(stars);
  const wrapped = new RegExp(`^(\\s*)${marker}([\\s\\S]+)${marker}(\\s*)$`, "u").exec(fragment);
  if (wrapped !== null) {
    return {
      kind: "pair",
      stars,
      lead: [...wrapped[1]!].length,
      trail: [...wrapped[3]!].length,
      inner: wrapped[2]!,
    };
  }
  // One half of a pair, opening or closing, never both.
  const opening = new RegExp(`^(\\s*)${marker}`, "u").exec(fragment);
  if (opening !== null) {
    return { kind: "half", side: "open", stars, lead: [...opening[1]!].length, trail: 0 };
  }
  const closing = new RegExp(`${marker}(\\s*)$`, "u").exec(fragment);
  if (closing !== null) {
    return { kind: "half", side: "close", stars, lead: 0, trail: [...closing[1]!].length };
  }
  return { kind: "bare", stars };
}

/**
 * The scalars of a piece's fragment that are the text it shows.
 *
 * A piece whose fragment is its own text shows all of it. A piece an emphasis
 * marker pair closes around shows the text between the pair, and the edge
 * whitespace the engine leaves outside the pair is not text. A piece a block
 * control split can carry only one half of the pair, so the half it does carry
 * is stripped as a marker, with whatever whitespace sits outside it.
 *
 * This answers one question: does a window reach a character this piece shows?
 * It never widens an answer to a window: a piece whose half pair was stripped
 * cannot be read back by `runWindowText`, so it still names the whole run when
 * the window reaches it. The edge whitespace is left out here because a window
 * in it covers nothing the piece shows; a caller deciding what a whole-piece op
 * FORMATS asks `formattedSpan`, which keeps it.
 */
function visibleSpan(run: Segment, fragment: string): { start: number; end: number } {
  const chars = [...fragment];
  const wrap = emphasisWrap(run, fragment);
  if (wrap === undefined || wrap.kind === "bare") return { start: 0, end: chars.length };
  if (wrap.kind === "pair") return { start: wrap.lead + wrap.stars, end: wrap.lead + wrap.stars + [...wrap.inner].length };
  if (wrap.side === "open") return { start: wrap.lead + wrap.stars, end: chars.length };
  return { start: 0, end: chars.length - wrap.trail - wrap.stars };
}

/**
 * The markdown scalars a piece shows, as absolute offsets.
 *
 * The marker pair an emphasis run is wrapped in, and the edge whitespace the
 * pair sits inside, are not characters the piece shows: a selection of `굵게`
 * inside `**굵게**` covers the piece whole although it starts after
 * `run.start`, and a piece a block control split may carry only one half of
 * that pair.
 *
 * Nothing in the selection path reads this: `runCoverage` calls `visibleSpan`
 * directly for its `none` answer, and whether a whole-piece op formats more
 * than the selection asks `formattedSpan`, which keeps the edge whitespace.
 * It stays exported for a caller that needs the shown span in the markdown's
 * own coordinates.
 */
export function shownSpan(envelope: CatEnvelope, run: Segment): { start: number; end: number } {
  const shown = visibleSpan(run, segmentText(envelope, run));
  return { start: run.start + shown.start, end: run.start + shown.end };
}

/**
 * The markdown span a whole-piece op formats, as absolute offsets.
 *
 * A `{id}` op with no `chars` writes the piece's source text, which is its
 * fragment with the marker pair stripped and its edge whitespace kept: the
 * engine leaves the run's trimmed text inside the pair and its whitespace
 * outside, so the whitespace is the run's own and an op that formats the piece
 * writes it. `shownSpan` leaves that whitespace out, because a window landing
 * in it covers no character the piece shows; the two answers differ exactly
 * where a whole-piece op formats characters the selection could not have
 * covered, which is what the range hint warns about.
 *
 * Keeping the edge whitespace widens the span over the marker characters that
 * sit between the whitespace and the text, and that is the honest answer: a
 * markdown interval cannot skip them, and no selection can reach the whitespace
 * without crossing the pair. A piece carrying half a pair, or no marker at all,
 * keeps whichever edge it has.
 */
export function formattedSpan(envelope: CatEnvelope, run: Segment): { start: number; end: number } {
  const fragment = segmentText(envelope, run);
  const shown = visibleSpan(run, fragment);
  const wrap = emphasisWrap(run, fragment);
  const lead = wrap === undefined || wrap.kind === "bare" ? 0 : wrap.lead;
  const trail = wrap === undefined || wrap.kind === "bare" ? 0 : wrap.trail;
  return {
    start: run.start + (lead > 0 ? 0 : shown.start),
    end: run.start + (trail > 0 ? [...fragment].length : shown.end),
  };
}

/**
 * A run's text inside the emitted fragment, the scalar offset where it starts,
 * and the width of the edge whitespace the marker pair was placed inside.
 *
 * A run that its character properties mark bold, italic or both is wrapped in
 * exactly that marker pair, and the wrapper is removed only when the wrapper
 * found and the properties agree. `emphasisWrap` reads that pair, so this
 * reader and `visibleSpan` agree on where a wrapped run's text starts and ends.
 * The engine wraps the run's TRIMMED text and leaves its edge whitespace
 * outside the markers (a bold `" / "` projects as space, the bold marker pair,
 * `/`, the pair again, space, measured on 1.6.1), so the returned offset points
 * at the first non-space character; a window in that edge whitespace is
 * refused.
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
  if (run.directChar === undefined) return undefined;
  const wrap = emphasisWrap(run, markdown);
  if (wrap === undefined) return { text: markdown, offset: 0, lead: 0, trail: 0 };
  // Half a pair is not a window, and neither is a piece that shows no marker:
  // what it holds is its own share of the run's text, not the run's text.
  if (wrap.kind !== "pair") return undefined;
  if (wrap.inner !== wrap.inner.trim()) return undefined;
  return { text: wrap.inner, offset: wrap.lead + wrap.stars, lead: wrap.lead, trail: wrap.trail };
}

/** Map a markdown offset to its source coordinate, if inside a segment. */
export function offsetToRef(
  envelope: CatEnvelope,
  offset: number,
): SegmentRef | undefined {
  const s = segmentAtOffset(envelope, offset);
  return s === undefined ? undefined : segmentRef(s);
}
