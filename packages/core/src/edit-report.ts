/**
 * `edit-report-v1`: what `hwp edit --report <FILE>` writes beside the edited
 * document — one outcome per request op, with the segment ids that op changed
 * as before/after pairs. Measured on `ahwp 1.6.0`.
 *
 * The report is the only channel that names what an insertion created. An
 * `insert_blocks` outcome carries `before: null` for every inserted segment,
 * so a caller that wants to select, reorder or remove what the components
 * palette just inserted reads the ids from here; the request cannot supply
 * them, because the engine assigns ids against the document it just wrote.
 *
 * Schema 1.1 refusal values can include user anchors, style names and issue
 * details. Treat report values as document data, not content-free diagnostics.
 */

import { withoutPaths } from "./insertion-refusals.js";

/** `insert_blocks` and `edit --report` need hwp-cli 1.4.0 (measured on 1.6.0). */
export const EDIT_REPORT_MIN_VERSION = "1.4.0";

/** Whether an engine version can insert blocks and report the ids it made. */
export function editReportSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 1 || (major === 1 && Number(match[2]) >= 4);
}

/** A creation (`before: null`), a removal (`after: null`), or a re-key. */
export interface EditIdPair {
  before: string | null;
  after: string | null;
}

/** One op's outcome. `op` is spelled as edit-ops-v1 spells it (`insert_blocks`). */
export interface EditOpOutcome {
  /** This op's position in the `--ops` batch. */
  index: number;
  op: string;
  status: "applied" | "failed";
  /** Inserted paragraphs for `insert_blocks`; mutated IR nodes otherwise. */
  pieces_touched: number;
  changed: EditIdPair[];
  /** Present only when `changed` was capped at 10000 pairs: the real count. */
  changed_total?: number;
  /** Applied `insert_blocks` only; policy metadata, never a failure reason. */
  missing_style?: "create" | "refuse";
  /** A fixed, content-free label when the op failed; null when applied. */
  reason: string | null;
  /** Per-op typed refusal, also emitted by schema 1.1. */
  refusal?: EditReportRefusal;
}

export interface EditReport {
  schema_version: string;
  contract: "hwp-edit-report-v1";
  output: string;
  dry_run: boolean;
  ops: EditOpOutcome[];
  applied_count: number;
  failed_count: number;
  /** Present on refused runs since schema 1.1; absent on older engines. */
  refusal?: EditReportRefusal;
}

/** Known edit-report-v1 1.x refusal ids; 1.2/1.3 support awaits native release validation. */
export const EDIT_REFUSAL_CODES = [
  "range_tag_shift", "keep_together_unsupported", "section_owner_insert", "section_owner_move",
  "add_table.anchor_not_found", "insert_blocks.unknown_style", "insert_blocks.invalid_definition",
  "insert_blocks.style_not_paragraph", "insert_blocks.duplicate_style", "insert_blocks.style_cycle",
  "insert_blocks.style_id_overflow", "layout_overflow", "insert_blocks.invalid_spec",
  "preservation_loss", "unapplied_requests", "no_applicable_edits", "document_protected", "verify_mismatch", "unclassified",
] as const;
export type EditRefusalCode = typeof EDIT_REFUSAL_CODES[number];
export type DocumentProtection = "password" | "certificate_encryption" | "certificate_drm" | "drm" | "signature";
export const VERIFY_INVARIANTS = [
  "sections", "paragraphs", "tables", "pictures", "generic_controls", "fields", "bookmarks",
  "hyperlinks", "bin_streams", "char_shapes", "para_shapes", "styles", "text_chars",
] as const;
export type VerifyInvariant = typeof VERIFY_INVARIANTS[number];

export interface EditRefusalIssue {
  code: string;
  path: (string | number)[];
  message: string;
  measured_width_mm?: number;
}
export interface PreservationRefusalEvent {
  code: string;
  resource: "container_stream" | "container_storage" | "package_entry" | "control" | "binary_asset" | "relationship" | "metadata";
  disposition: "removed" | "changed_non_target" | "unrepresentable";
  count: number;
}
type IssueValues = { issues: EditRefusalIssue[]; container_width_mm: number };
type StyleCode = "insert_blocks.style_not_paragraph" | "insert_blocks.duplicate_style" | "insert_blocks.style_cycle";
type EmptyCode = "range_tag_shift" | "section_owner_insert" | "section_owner_move" | "unapplied_requests" | "no_applicable_edits" | "unclassified";
export type EditReportRefusal = (
  | { code: EmptyCode; values: Record<string, never> }
  | { code: "document_protected"; values: { protection: DocumentProtection } }
  | { code: "verify_mismatch"; values: { counts: Array<{ name: VerifyInvariant; expected: number; actual: number }> } }
  | { code: "keep_together_unsupported"; values: { op_index: number; requested: string[] } }
  | { code: "add_table.anchor_not_found"; values: { anchor: string } }
  | { code: "insert_blocks.unknown_style"; values: { style: string; missing_style: "create" | "refuse" } }
  | { code: StyleCode; values: { style: string } }
  | { code: "insert_blocks.style_id_overflow"; values: { style: string; style_id: number; max_style_id: number } }
  | { code: "insert_blocks.invalid_definition"; values: IssueValues | { style: string; detail: string } }
  | { code: "layout_overflow" | "insert_blocks.invalid_spec"; values: IssueValues }
  | { code: "preservation_loss"; values: { events: PreservationRefusalEvent[] } }
) & { message: string };

/** Refusal reports were added in ahwp 1.6.3; the editor's floor stays unchanged. */
export function refusalCodesSupported(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return major > 1 || (major === 1 && (minor > 6 || (minor === 6 && patch >= 3)));
}

function nonempty(raw: unknown, field: string): string {
  const result = text(raw, field);
  if (result.trim() === "") invalid(field);
  return result;
}
function mm(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) invalid(field);
  return raw;
}
function issueValues(values: Record<string, unknown>): IssueValues {
  const issues = array(values.issues, "refusal.values.issues").map(raw => {
    const issue = object(raw, "refusal.values.issues[]");
    const path = array(issue.path, "refusal.values.issues[].path").map(part => {
      if (typeof part === "string") return part;
      return count(part, "refusal.values.issues[].path[]");
    });
    return {
      code: nonempty(issue.code, "refusal.values.issues[].code"), path,
      message: text(issue.message, "refusal.values.issues[].message"),
      ...(issue.measured_width_mm === undefined ? {} : { measured_width_mm: mm(issue.measured_width_mm, "refusal.values.issues[].measured_width_mm") }),
    };
  });
  if (issues.length === 0) invalid("refusal.values.issues");
  return { issues, container_width_mm: mm(values.container_width_mm, "refusal.values.container_width_mm") };
}

/** Validate each code's consumed values; user prose is retained, never classified. */
function parseReportRefusal(raw: unknown): EditReportRefusal {
  const value = object(raw, "refusal");
  const code = value.code;
  if (typeof code !== "string" || code.trim() === "") invalid("refusal.code");
  const values = object(value.values, "refusal.values");
  const message = text(value.message, "refusal.message");
  switch (code) {
    case "range_tag_shift": case "section_owner_insert": case "section_owner_move":
    case "unapplied_requests": case "no_applicable_edits": case "unclassified":
      return { code, values: {}, message };
    case "document_protected": {
      const protection = values.protection;
      if (typeof protection !== "string" || !["password", "certificate_encryption", "certificate_drm", "drm", "signature"].includes(protection)) {
        invalid("refusal.values.protection");
      }
      return { code, values: { protection: protection as DocumentProtection }, message };
    }
    case "verify_mismatch": {
      const counts = array(values.counts, "refusal.values.counts").map(rawCount => {
        const item = object(rawCount, "refusal.values.counts[]");
        const name = item.name;
        if (typeof name !== "string" || !VERIFY_INVARIANTS.includes(name as VerifyInvariant)) {
          invalid("refusal.values.counts[].name");
        }
        return {
          name: name as VerifyInvariant,
          expected: count(item.expected, "refusal.values.counts[].expected"),
          actual: count(item.actual, "refusal.values.counts[].actual"),
        };
      });
      return { code, values: { counts }, message };
    }
    case "keep_together_unsupported": {
      const requested = array(values.requested, "refusal.values.requested").map(v => nonempty(v, "refusal.values.requested[]"));
      if (requested.length === 0) invalid("refusal.values.requested");
      return { code, values: { op_index: count(values.op_index, "refusal.values.op_index"), requested }, message };
    }
    case "add_table.anchor_not_found":
      return { code, values: { anchor: text(values.anchor, "refusal.values.anchor") }, message };
    case "insert_blocks.unknown_style":
      if (values.missing_style !== "create" && values.missing_style !== "refuse") invalid("refusal.values.missing_style");
      return { code, values: { style: nonempty(values.style, "refusal.values.style"), missing_style: values.missing_style }, message };
    case "insert_blocks.style_not_paragraph": case "insert_blocks.duplicate_style": case "insert_blocks.style_cycle":
      return { code, values: { style: nonempty(values.style, "refusal.values.style") }, message };
    case "insert_blocks.style_id_overflow":
      return { code, values: { style: nonempty(values.style, "refusal.values.style"), style_id: count(values.style_id, "refusal.values.style_id"), max_style_id: count(values.max_style_id, "refusal.values.max_style_id") }, message };
    case "insert_blocks.invalid_definition":
      return { code, values: values.issues !== undefined ? issueValues(values) : { style: nonempty(values.style, "refusal.values.style"), detail: text(values.detail, "refusal.values.detail") }, message };
    case "layout_overflow": case "insert_blocks.invalid_spec":
      return { code, values: issueValues(values), message };
    case "preservation_loss": {
      const events = array(values.events, "refusal.values.events").map((raw): PreservationRefusalEvent => {
        const event = object(raw, "refusal.values.events[]");
        const resource = event.resource;
        const disposition = event.disposition;
        if (typeof resource !== "string" || !["container_stream", "container_storage", "package_entry", "control", "binary_asset", "relationship", "metadata"].includes(resource)) invalid("refusal.values.events[].resource");
        if (disposition !== "removed" && disposition !== "changed_non_target" && disposition !== "unrepresentable") invalid("refusal.values.events[].disposition");
        const total = count(event.count, "refusal.values.events[].count");
        if (total === 0) invalid("refusal.values.events[].count");
        return { code: nonempty(event.code, "refusal.values.events[].code"), resource: resource as PreservationRefusalEvent["resource"], disposition, count: total };
      });
      if (events.length === 0) invalid("refusal.values.events");
      return { code, values: { events }, message };
    }
    default: return { code: "unclassified", values: {}, message };
  }
}

function invalid(field: string): never {
  throw new Error(
    `Invalid edit report: ${field}; the engine did not answer with edit-report-v1, so the ids ` +
      "it changed are unknown. Upgrade the host's agent-hwp and retry.",
  );
}

function object(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid(field);
  return raw as Record<string, unknown>;
}

function text(raw: unknown, field: string): string {
  if (typeof raw !== "string") invalid(field);
  return raw;
}

function count(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) invalid(field);
  return raw;
}

function array(raw: unknown, field: string): unknown[] {
  if (!Array.isArray(raw)) invalid(field);
  return raw;
}

/**
 * A segment id: 16 hex checksum, then a dot-separated index chain, one index
 * more than the engine's own 32 so an id at that cap is never refused.
 *
 * This parser validates what the engine just wrote, not what a caller asked
 * for: over-accepting one index costs nothing (no shipped document nests past
 * five), while under-accepting loses the ids of an insertion that succeeded.
 * What it must reject is a value that is not an id at all, which the 16-hex
 * prefix and the all-numeric chain still do.
 */
const SEGMENT_ID = /^[0-9a-f]{16}(?:\.[0-9]+){1,33}$/;

/**
 * The positional chain inside a segment id, `[section, ...indices]`, without
 * its hash: the one reader of the `<hash>.<section>.<indices...>` shape, used
 * here and by the editor for an inserted paragraph that publishes no segment.
 */
export function segmentIdPath(id: string): number[] {
  return id.split(".").slice(1).map(Number);
}

function parseId(raw: unknown, field: string): string | null {
  if (raw === null) return null;
  const id = text(raw, field);
  if (!SEGMENT_ID.test(id)) invalid(field);
  return id;
}

function parseOutcome(raw: unknown): EditOpOutcome {
  const value = object(raw, "ops[]");
  if (value.status !== "applied" && value.status !== "failed") invalid("ops[].status");
  const index = count(value.index, "ops[].index");
  const changed = array(value.changed, `ops[${index}].changed`).map((pair, at) => {
    const entry = object(pair, `ops[${index}].changed[${at}]`);
    return {
      before: parseId(entry.before, `ops[${index}].changed[${at}].before`),
      after: parseId(entry.after, `ops[${index}].changed[${at}].after`),
    };
  });
  if (value.reason !== null) text(value.reason, `ops[${index}].reason`);
  if (
    value.missing_style !== undefined &&
    value.missing_style !== "create" &&
    value.missing_style !== "refuse"
  ) {
    invalid(`ops[${index}].missing_style`);
  }
  return {
    index,
    op: text(value.op, `ops[${index}].op`),
    status: value.status,
    pieces_touched: count(value.pieces_touched, `ops[${index}].pieces_touched`),
    changed,
    ...(value.changed_total === undefined
      ? {}
      : { changed_total: count(value.changed_total, `ops[${index}].changed_total`) }),
    ...(value.missing_style === undefined
      ? {}
      : { missing_style: value.missing_style as "create" | "refuse" }),
    reason: value.reason as string | null,
    ...(value.refusal === undefined ? {} : { refusal: parseReportRefusal(value.refusal) }),
  };
}

/**
 * Validate an engine answer against `edit-report-v1`. A shape this parser does
 * not know is refused rather than coerced: a silently dropped field would mean
 * silently dropped ids.
 */
export function parseEditReport(raw: unknown): EditReport {
  const value = object(raw, "report");
  if (value.contract !== "hwp-edit-report-v1") invalid("contract");
  if (typeof value.schema_version !== "string" || !/^1[.][0-9]+$/.test(value.schema_version)) {
    invalid("schema_version");
  }
  if (typeof value.dry_run !== "boolean") invalid("dry_run");
  return {
    schema_version: value.schema_version,
    contract: "hwp-edit-report-v1",
    output: text(value.output, "output"),
    dry_run: value.dry_run,
    ops: array(value.ops, "ops").map(parseOutcome),
    applied_count: count(value.applied_count, "applied_count"),
    failed_count: count(value.failed_count, "failed_count"),
    ...(value.refusal === undefined ? {} : { refusal: parseReportRefusal(value.refusal) }),
  };
}

/** Redact diagnostics, preserving typed user anchors, styles and issue-path segments. */
function sanitizedRefusal(refusal: EditReportRefusal, workDir?: string): EditReportRefusal {
  const message = withoutPaths(refusal.message, workDir);
  switch (refusal.code) {
    case "insert_blocks.invalid_definition":
      if ("detail" in refusal.values) {
        return { ...refusal, message, values: { ...refusal.values, detail: withoutPaths(refusal.values.detail, workDir) } };
      }
      return { ...refusal, message, values: { ...refusal.values,
        issues: refusal.values.issues.map(issue => ({ ...issue, message: withoutPaths(issue.message, workDir) })),
      } };
    case "layout_overflow": case "insert_blocks.invalid_spec":
      return { ...refusal, message, values: { ...refusal.values,
        issues: refusal.values.issues.map(issue => ({ ...issue, message: withoutPaths(issue.message, workDir) })),
      } };
    default: return { ...refusal, message };
  }
}

/** Remove staged diagnostics before exposure; user-valued identifiers remain exact. */
export function sanitizeEditReport(report: EditReport, name: string, workDir?: string): EditReport {
  const parsed = parseEditReport(report);
  return withCallerName({ ...parsed,
    ops: parsed.ops.map(op => ({ ...op,
      reason: op.reason === null ? null : withoutPaths(op.reason, workDir),
      ...(op.refusal === undefined ? {} : { refusal: sanitizedRefusal(op.refusal, workDir) }),
    })),
    ...(parsed.refusal === undefined ? {} : { refusal: sanitizedRefusal(parsed.refusal, workDir) }),
  }, name);
}

/**
 * An edit report with its `output` replaced by the caller's own document name.
 *
 * The engine writes the `-o` path it was given, which is inside whatever work
 * directory the host staged the document in. "No temp path reaches a caller"
 * applies to report fields as much as to messages, so every boundary that
 * hands a report out — the CLI server's engine, its HTTP route, the Tauri
 * bridge — rewrites this one field, and a caller never learns where the
 * document was staged.
 */
export function withCallerName(report: EditReport, name: string): EditReport {
  return { ...report, output: name };
}

/**
 * The ids of the top-level paragraphs one `insert_blocks` outcome created.
 *
 * `changed` lists every inserted segment: a paragraph id followed by its run
 * ids and, for a table or image block, the table, cell, cell-paragraph and run
 * ids nested under it. Only the paragraphs the request's blocks became are
 * addressable by the ops that reorder or remove them, so the ones kept here are
 * the shortest index chains that no other listed segment extends.
 *
 * `pieces_touched` counts the pieces the engine placed. From agent-hwp 1.6.2
 * (#521) `changed` names every one of them, an empty or break-only paragraph
 * included: such a paragraph publishes no `para` segment, so its id is absent
 * from a fresh `cat --segments v2`, but `move_para` and `delete_para` accept it,
 * and it is returned here like any other (measured on ahwp 1.6.2: three blocks,
 * the middle one empty, give `pieces_touched: 3` and three top-level ids).
 * Engines before 1.6.2 count such a paragraph without naming it (ahwp 1.6.0,
 * the 붙임 starter's empty param: `pieces_touched: 4`, three ids), and
 * EDIT_REPORT_MIN_VERSION is below 1.6.2, so a shortfall is still accepted and the named
 * ids returned. A surplus is not — a report listing more paragraphs than it
 * touched is not this contract — and is refused, as is a capped list
 * (`changed_total`), which the caller checks before calling this.
 */
export function insertedParagraphIds(outcome: EditOpOutcome): string[] {
  if (outcome.status !== "applied") return [];
  const paths = new Map<string, number[]>();
  for (const pair of outcome.changed) {
    // A re-key or a removal is not a paragraph this op created.
    if (pair.before !== null || pair.after === null) continue;
    paths.set(pair.after, segmentIdPath(pair.after));
  }
  const top: string[] = [];
  for (const [id, path] of paths) {
    let nested = false;
    for (const other of paths.values()) {
      if (other.length < path.length && other.every((index, at) => index === path[at])) {
        nested = true;
        break;
      }
    }
    if (!nested) top.push(id);
  }
  if (top.length > outcome.pieces_touched) {
    invalid(
      `ops[${outcome.index}] reports ${outcome.pieces_touched} inserted paragraphs but lists ` +
        `${top.length} top-level ids`,
    );
  }
  return top;
}
