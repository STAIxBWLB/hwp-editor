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
 * A report is content-free by contract: no paragraph text, no replacement
 * string and no user-supplied pattern, which is why this parser can log a
 * rejected report without leaking one.
 */

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
}

export interface EditReport {
  schema_version: string;
  contract: "hwp-edit-report-v1";
  output: string;
  dry_run: boolean;
  ops: EditOpOutcome[];
  applied_count: number;
  failed_count: number;
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
  };
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
