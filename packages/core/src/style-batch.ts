/**
 * What a batch carrying a preset switch owes every transport, in one place.
 *
 * `hwp edit --style-tables` and `--ops` are mutually exclusive, and the flag
 * form aborts the whole edit when the document has no multi-column table
 * (edit.rs:1699-1702). As an edit-ops-v1 `style_tables` op the preset shares
 * the batch instead, which leaves two obligations on the CALLER — and they are
 * the same two on every transport, so they live here rather than in one
 * engine's copy:
 *
 * - force `allowPartial` and `report`. The engine pushes the preset to
 *   "unapplied" and still exits 0, so the process status no longer answers
 *   "did the whole batch land" and the report does;
 * - refuse the published document unless the only unapplied request was the
 *   preset's table styling. Anything else is a queued edit the engine dropped.
 *
 * Measured on ahwp 1.6.1: on a document with no eligible table, under
 * `--allow-partial`, the style op is applied and `style_tables` reports
 * "no styleable table" with exit 0; a second unapplied op alongside it also
 * exits 0. Applying an already-applied preset reports every op `applied` with
 * `pieces_touched: 0` and writes byte-identical output, which is how a switch
 * that changes nothing is known before it becomes an undo entry.
 */
import type { EditReport } from "./edit-report.js";
import type { EditOptions } from "./engine.js";
import type { EditOp } from "./ops.js";

/** Whether this batch carries the preset switch. */
export function carriesPresetSwitch(ops: readonly EditOp[]): boolean {
  return ops.some((op) => op?.kind === "style-tables");
}

/**
 * The options a preset batch needs, whatever the caller passed: without
 * `allowPartial` the engine aborts the batch on a table-less document, and
 * without `report` its outcome is unknowable.
 */
export function presetBatchOptions(ops: readonly EditOp[], options: EditOptions): EditOptions {
  return carriesPresetSwitch(ops) ? { ...options, allowPartial: true, report: true } : options;
}

/** A refusal an engine raises for the batch it just published. */
export interface PresetBatchRefusal {
  code: "unavailable" | "bad_request";
  message: string;
}

export interface PresetBatchReading {
  /** Non-null when the published document must be discarded. */
  refusal: PresetBatchRefusal | null;
  /** True when the preset's table styling is the only request the engine skipped. */
  unstyledTable: boolean;
  /** True when the engine reported that nothing in the batch changed the document. */
  unchanged: boolean;
}

/**
 * Read a preset batch's report. The document the edit published is only
 * usable when `refusal` is null: with `allowPartial` in force, a failed op is
 * a silently dropped edit rather than a non-zero exit.
 */
export function readPresetBatch(report: EditReport | undefined): PresetBatchReading {
  if (report === undefined) {
    return {
      refusal: {
        code: "unavailable",
        message: "the engine published this edit without a readable report, so the preset's outcome is unknown; upgrade the host's hwp-cli to a release that writes edit-report-v1 and apply again",
      },
      unstyledTable: false,
      unchanged: false,
    };
  }
  const unstyledTable = report.ops.some((outcome) => outcome.op === "style_tables" && outcome.status === "failed");
  const refused = report.ops.filter((outcome) => outcome.status === "failed" && outcome.op !== "style_tables");
  if (refused.length === 0) {
    // Every op applied and none of them touched a piece: the switch was
    // already in place, so replacing the document would add an undo entry
    // that restores it to itself.
    const unchanged = report.ops.length > 0 && report.ops.every((outcome) => outcome.status === "applied" && outcome.pieces_touched === 0);
    return { refusal: null, unstyledTable, unchanged };
  }
  const reasons = [...new Set(refused.map((outcome) => outcome.reason ?? outcome.op))].join("; ");
  return {
    refusal: {
      code: "bad_request",
      message: `the engine left ${refused.length} edit request(s) unapplied (${reasons}); nothing was published, so remove or fix those requests and apply again`,
    },
    unstyledTable,
    unchanged: false,
  };
}
