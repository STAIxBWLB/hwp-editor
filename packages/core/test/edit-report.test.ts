/**
 * `edit-report-v1` parser and inserted-id selection.
 *
 * The fixture is real engine output: `ahwp 1.6.0` applied one `insert_blocks`
 * carrying the summary-table starter component (one paragraph block and one
 * table block) to an official-profile document, and wrote this report. Its
 * `changed` shows the shape the parser has to survive — 28 creation pairs for
 * 2 inserted paragraphs, because a table publishes its table, cell,
 * cell-paragraph and run ids under the paragraph that holds it. Its `output`
 * path is the scratch file that run wrote and nothing here reads it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { editReportSupported, insertedParagraphIds, parseEditReport } from "../src/edit-report.js";
import type { EditOpOutcome, EditReport } from "../src/edit-report.js";

const tableReport = (): unknown =>
  JSON.parse(readFileSync(new URL("./fixtures/edit-report-insert-table.json", import.meta.url), "utf8"));

/** A two-paragraph report as the engine writes it; ids are the ones it published. */
function paragraphReport(): EditReport {
  return parseEditReport({
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "/tmp/out.hwpx",
    dry_run: false,
    ops: [
      {
        index: 0,
        op: "insert_blocks",
        status: "applied",
        pieces_touched: 2,
        changed: [
          { before: null, after: "a84ac20e7a012e4a.0.2" },
          { before: null, after: "f9fb0c3788cb383f.0.2.0" },
          { before: null, after: "b47cc2fea12bd117.0.3" },
          { before: null, after: "6853775375a54bed.0.3.0" },
        ],
        reason: null,
        missing_style: "create",
      },
    ],
    applied_count: 1,
    failed_count: 0,
  });
}

/** The one outcome a fixture report carries, without an indexed access. */
function firstOutcome(report: EditReport): EditOpOutcome {
  const [outcome] = report.ops;
  if (outcome === undefined) throw new Error("the fixture report carries no outcome");
  return outcome;
}

describe("editReportSupported", () => {
  it("accepts 1.4.0 and later, and nothing it cannot parse", () => {
    // The palette disables itself with a localized reason below this floor,
    // so the boundary is asserted on both sides of 1.4.0.
    expect(editReportSupported("1.4.0")).toBe(true);
    expect(editReportSupported("1.6.0")).toBe(true);
    expect(editReportSupported("1.6.0-dev.3")).toBe(true);
    expect(editReportSupported("2.0.0")).toBe(true);
    expect(editReportSupported("1.3.9")).toBe(false);
    expect(editReportSupported("0.20.0")).toBe(false);
    expect(editReportSupported("")).toBe(false);
    expect(editReportSupported("dev")).toBe(false);
  });
});

describe("parseEditReport", () => {
  it("keeps the engine's outcomes, counts and id pairs", () => {
    const report = parseEditReport(tableReport());
    expect(report.contract).toBe("hwp-edit-report-v1");
    expect(report.dry_run).toBe(false);
    expect([report.applied_count, report.failed_count]).toEqual([1, 0]);
    expect(report.ops).toHaveLength(1);
    expect(report.ops[0]).toMatchObject({
      index: 0,
      op: "insert_blocks",
      status: "applied",
      pieces_touched: 2,
      missing_style: "create",
      reason: null,
    });
  });

  it("refuses a report that is not edit-report-v1", () => {
    // The contract tag is the one field that makes the ids interpretable.
    const report = tableReport() as Record<string, unknown>;
    expect(() => parseEditReport({ ...report, contract: "hwp-edit-report-v2" })).toThrow(
      /Invalid edit report: contract/,
    );
    expect(() => parseEditReport({ ...report, ops: {} })).toThrow(/Invalid edit report: ops/);
    expect(() => parseEditReport(null)).toThrow(/Invalid edit report: report/);
  });

  it("refuses an id that is not a segment id rather than passing it through", () => {
    const report = paragraphReport();
    const broken = { ...report, ops: [{ ...report.ops[0], changed: [{ before: null, after: "not-an-id" }] }] };
    expect(() => parseEditReport(broken)).toThrow(/Invalid edit report: ops\[0\]\.changed\[0\]\.after/);
  });

  it("refuses a failed op whose reason is absent", () => {
    const report = paragraphReport();
    const broken = { ...report, ops: [{ ...report.ops[0], status: "failed", reason: undefined }] };
    expect(() => parseEditReport(broken)).toThrow(/Invalid edit report: ops\[0\]\.reason/);
  });
});

describe("insertedParagraphIds", () => {
  it("selects only the paragraphs a multi-block insertion created", () => {
    const outcome = firstOutcome(parseEditReport(tableReport()));
    // 28 creation pairs, 2 blocks: the paragraph and the table's paragraph.
    expect(outcome.changed).toHaveLength(28);
    expect(insertedParagraphIds(outcome)).toEqual([
      "b760a3bd12d49857.0.2",
      "f0ada035b52c38fa.0.3",
    ]);
  });

  it("selects each inserted paragraph once, without its runs", () => {
    expect(insertedParagraphIds(firstOutcome(paragraphReport()))).toEqual([
      "a84ac20e7a012e4a.0.2",
      "b47cc2fea12bd117.0.3",
    ]);
  });

  it("ignores a re-keyed or removed segment", () => {
    const outcome = firstOutcome(paragraphReport());
    expect(
      insertedParagraphIds({
        ...outcome,
        pieces_touched: 1,
        changed: [
          { before: "0123456789abcdef.0.1", after: "fedcba9876543210.0.1" },
          { before: "0123456789abcdef.0.2", after: null },
          { before: null, after: "a84ac20e7a012e4a.0.2" },
        ],
      }),
    ).toEqual(["a84ac20e7a012e4a.0.2"]);
  });

  it("returns nothing for an op that did not apply", () => {
    const outcome = firstOutcome(paragraphReport());
    expect(insertedParagraphIds({ ...outcome, status: "failed", reason: "insert_blocks: no address" })).toEqual([]);
  });

  it("keeps the named paragraphs when the engine counted a piece it could not name", () => {
    // Measured with the 붙임 starter's empty fourth param: the block lands as
    // an empty paragraph, so it is counted in pieces_touched and absent from
    // changed. Returning the three named paragraphs is what makes a
    // multi-paragraph starter movable at all; refusing the report left the
    // palette with nothing to select.
    const outcome = firstOutcome(paragraphReport());
    expect(insertedParagraphIds({ ...outcome, pieces_touched: 3 })).toEqual([
      "a84ac20e7a012e4a.0.2",
      "b47cc2fea12bd117.0.3",
    ]);
  });

  it("refuses a report that lists more paragraphs than it touched", () => {
    // The nesting rule above is proved by the count, so a report claiming
    // fewer pieces than its own top-level ids is not this contract.
    const outcome = firstOutcome(paragraphReport());
    expect(() => insertedParagraphIds({ ...outcome, pieces_touched: 1 })).toThrow(
      /reports 1 inserted paragraphs but lists 2 top-level ids/,
    );
  });
});
