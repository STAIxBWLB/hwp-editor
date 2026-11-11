/**
 * The rules a batch carrying a preset switch owes every transport
 * (style-batch.ts), pinned to what `ahwp 1.6.1` actually reports.
 *
 * The measurements this file encodes, read on 2026-11-11:
 *
 * - a document with no eligible table, edited with `--allow-partial`, applies
 *   the style op and reports `style_tables` failed with "no styleable table",
 *   exit 0 — so the process status cannot be the answer and the report is;
 * - the same batch with a second op the engine cannot apply still exits 0, so
 *   a refusal has to be read out of the report too;
 * - pressing the preset on a document that already carries it reports every op
 *   `applied` with `pieces_touched: 0` and writes byte-identical output.
 */
import { describe, expect, it } from "vitest";
import type { EditOp } from "../src/ops.js";
import type { EditReport } from "../src/edit-report.js";
import { carriesPresetSwitch, presetBatchOptions, readPresetBatch } from "../src/style-batch.js";

const PRESET_BATCH: EditOp[] = [
  { kind: "update-style", style: 7, font: "맑은 고딕", size: "12", lineSpacingPct: "160" },
  { kind: "style-tables", preset: "official" },
];

const PLAIN_BATCH: EditOp[] = [{ kind: "replace", find: "구교재", replace: "신교재" }];

function report(ops: { op: string; status: "applied" | "failed"; pieces?: number; reason?: string }[]): EditReport {
  return {
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "out.hwpx",
    dry_run: false,
    ops: ops.map((outcome, index) => ({
      index,
      op: outcome.op,
      status: outcome.status,
      pieces_touched: outcome.pieces ?? 0,
      changed: [],
      reason: outcome.reason ?? null,
    })),
    applied_count: ops.filter((outcome) => outcome.status === "applied").length,
    failed_count: ops.filter((outcome) => outcome.status === "failed").length,
  };
}

describe("carriesPresetSwitch / presetBatchOptions", () => {
  it("recognizes a preset batch and leaves a plain one alone", () => {
    expect(carriesPresetSwitch(PRESET_BATCH)).toBe(true);
    expect(carriesPresetSwitch(PLAIN_BATCH)).toBe(false);
    expect(presetBatchOptions(PLAIN_BATCH, { verify: true })).toEqual({ verify: true });
  });

  it("forces allowPartial and report for a preset batch, whatever the caller passed", () => {
    // Without allowPartial the engine aborts the whole edit on a table-less
    // document; without report its outcome is unknowable. Neither is the
    // caller's to forget, on any transport.
    expect(presetBatchOptions(PRESET_BATCH, {})).toEqual({ allowPartial: true, report: true });
    expect(presetBatchOptions(PRESET_BATCH, { verify: true, report: false })).toEqual({
      verify: true,
      allowPartial: true,
      report: true,
    });
  });
});

describe("readPresetBatch", () => {
  it("treats an unreadable or missing report as an unknowable outcome", () => {
    const reading = readPresetBatch(undefined);
    expect(reading.refusal?.code).toBe("unavailable");
    expect(reading.refusal?.message).toContain("edit-report-v1");
    expect(reading.refusal?.message).toContain("apply again");
    expect(reading.unstyledTable).toBe(false);
    expect(reading.unchanged).toBe(false);
  });

  it("accepts a preset the document had no table for, and says so", () => {
    // The measured table-less answer: the style op landed, the preset was
    // pushed to "unapplied", exit 0.
    const reading = readPresetBatch(report([
      { op: "update_style", status: "applied", pieces: 1 },
      { op: "style_tables", status: "failed", reason: "style_tables: no styleable table" },
    ]));
    expect(reading.refusal).toBeNull();
    expect(reading.unstyledTable).toBe(true);
    expect(reading.unchanged).toBe(false);
  });

  it("refuses a batch the engine shrank for any other reason", () => {
    // `--allow-partial` also exits 0 when an op other than the preset failed,
    // so the report is the only place that drop is visible.
    const reading = readPresetBatch(report([
      { op: "update_style", status: "failed", reason: "update_style: no match or no change" },
      { op: "style_tables", status: "applied", pieces: 1 },
    ]));
    expect(reading.refusal?.code).toBe("bad_request");
    expect(reading.refusal?.message).toContain("1 edit request(s) unapplied");
    expect(reading.refusal?.message).toContain("no match or no change");
    // The message says what to do next, not only what went wrong.
    expect(reading.refusal?.message).toContain("apply again");
  });

  it("reports a batch that changed nothing, which is how a no-op switch is known", () => {
    // Measured: the second press of an already-applied preset reports both ops
    // applied with pieces_touched 0 and writes byte-identical output.
    const reading = readPresetBatch(report([
      { op: "update_style", status: "applied", pieces: 0 },
      { op: "style_tables", status: "applied", pieces: 0 },
    ]));
    expect(reading.refusal).toBeNull();
    expect(reading.unstyledTable).toBe(false);
    expect(reading.unchanged).toBe(true);
  });

  it("does not call a real change unchanged", () => {
    const reading = readPresetBatch(report([
      { op: "update_style", status: "applied", pieces: 1 },
      { op: "style_tables", status: "applied", pieces: 1 },
    ]));
    expect(reading.unchanged).toBe(false);
  });

  it("does not read a report with no ops as a no-op", () => {
    expect(readPresetBatch(report([])).unchanged).toBe(false);
  });
});
