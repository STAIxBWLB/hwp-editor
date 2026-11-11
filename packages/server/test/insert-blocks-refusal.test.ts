/**
 * The cause of an `insert_blocks` refusal, carried across the CLI boundary.
 *
 * `runCliOk` keeps the engine's stderr out of `message` on purpose: that text
 * routinely names the staged input file, and `routes.ts` serializes only the
 * message, so a raw passthrough would hand a temp path to whoever made the
 * request. The cost was that a 120 mm 결재란 in a 46.40 mm cell surfaced as
 * "hwp edit failed (exit 1)" with no cause at all.
 *
 * These tests pin the replacement rule: when a batch carrying `insert-blocks`
 * fails, the message names the refusal class and the widths, never a path,
 * and the verbatim stderr stays on `detail`. The stderr strings are the ones
 * the real binary writes (measured on ahwp 1.6.0); the Korean diagnostics are
 * identical under every `--lang`, so they are matched as permanent markers.
 */
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { Blocks, EditOp } from "@hwp-editor/core";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";

afterEach(disposeFakeBins);

/** `layout_overflow` for a 120 mm block in a 46.40 mm body. */
const WIDTH_REFUSAL =
  "Error: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다: layout_overflow at " +
  "$.sections[0].blocks[0].columns: column widths total 120.00 mm; body width is 46.40 mm; " +
  "layout_overflow at $.sections[0].blocks[0].width_mm: table width exceeds body width 46.40 mm. " +
  "DocumentSpec v1 정의를 수정한 뒤 다시 시도하세요 (삽입 위치의 폭은 46.4mm입니다)";

/** A style the target document does not define. */
const STYLE_REFUSAL =
  "Error: 스타일 '결재란 셀'을 대상 문서에서 찾을 수 없습니다. styles 정의를 제공하고 " +
  "missing_style=create로 다시 시도하거나 hwp styles에서 기존 스타일을 선택하세요";

const BLOCKS: Blocks = [{ type: "paragraph", runs: [{ type: "text", text: "결재란" }] }];

const INSERT: EditOp[] = [{
  kind: "insert-blocks",
  address: { at: { section: 0, paragraph: 0 } },
  position: "after",
  blocks: BLOCKS,
}];

const DELETE: EditOp[] = [{ kind: "delete-para", address: { at: { section: 0, paragraph: 1 } } }];

const document = { name: "sample.hwpx", data: new Uint8Array([1, 2, 3]) };

/** The refusal a failed edit raised, or a thrown assertion when it succeeded. */
async function failure(stderr: string, ops: EditOp[]): Promise<HwpCliError> {
  const { bin } = createFakeBin({ info: "{}", mode: "fail", editStderr: stderr });
  const error = await createCliEngine({ bin }).edit(document, ops).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(HwpCliError);
  const cliError = error as HwpCliError;
  expect(cliError.reason).toBe("failed");
  return cliError;
}

describe("insert_blocks refusal classification", () => {
  it("names layout_overflow and both widths without leaking the staged path", async () => {
    const error = await failure(WIDTH_REFUSAL, INSERT);

    expect(error.message).toBe(
      "hwp edit failed (exit 3): insert_blocks refused: layout_overflow " +
        "(block 120.00 mm, insertion point 46.40 mm)",
    );
    // The one thing the message must never carry is where the input was staged.
    expect(error.message).not.toContain(tmpdir());
    expect(error.message).not.toContain(".hwpx");
    // The verbatim engine text survives on detail, for an operator, not the wire.
    expect(error.stderr).toBe(WIDTH_REFUSAL);
    expect(error.detail).toContain("column widths total 120.00 mm");
  });

  it("names unknown_style and the style the document lacks", async () => {
    const error = await failure(STYLE_REFUSAL, INSERT);

    // The name is printed last on its own line: a style name is user text and
    // can hold a `)` or a `'`, which any bracketed form would cut in half.
    expect(error.message).toBe(
      "hwp edit failed (exit 3): insert_blocks refused: unknown_style; 결재란 셀",
    );
    expect(error.message).not.toContain(tmpdir());
    expect(error.detail).toContain("결재란 셀");
  });

  it("still names the class when the engine gives no width at all", async () => {
    const error = await failure(
      "Error: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다: layout_overflow",
      INSERT,
    );

    expect(error.message).toBe("hwp edit failed (exit 3): insert_blocks refused: layout_overflow");
    expect(error.message).not.toContain("mm");
  });

  it("falls back to the invalid-definition class for any other insert_blocks refusal", async () => {
    const error = await failure(
      "Error: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다: $.sections[0].blocks[0]",
      INSERT,
    );

    expect(error.message).toContain("insert_blocks refused: invalid_definition");
    expect(error.message).not.toContain(tmpdir());
  });

  it("carries the engine's own line when the refusal is not about the definition", async () => {
    // The `insert_blocks` token alone is not a class: the engine also says it
    // when the address is a section's definition paragraph or not a body
    // paragraph or cell. Those say nothing about the component, so the cause
    // is the engine's own line rather than a class name invented here.
    const error = await failure(
      "Error: insert_blocks 구역 정의 문단 앞에는 삽입할 수 없습니다",
      INSERT,
    );

    expect(error.message).toBe(
      "hwp edit failed (exit 3): insert_blocks refused: 구역 정의 문단 앞에는 삽입할 수 없습니다",
    );
    expect(error.stderr).toContain("구역 정의 문단");
  });

  it("replaces a temp path in the engine's line instead of passing it on", async () => {
    // Everything the engine says reaches the caller now, so the scrubber is
    // the only thing between a caller and the work dir it never knew about.
    const error = await failure(
      "Error: failed to parse /tmp/hwp-edit-abc123/input.hwpx at byte 42",
      INSERT,
    );

    expect(error.message).toBe(
      "hwp edit failed (exit 3): insert_blocks refused: failed to parse <path> at byte 42",
    );
    expect(error.message).not.toContain("/tmp");
    expect(error.message).not.toContain("input.hwpx");
    // The operator's copy is untouched.
    expect(error.detail).toContain("/tmp/hwp-edit-abc123/input.hwpx");
  });

  it("leaves a batch with no insertion on the bare exit line", async () => {
    const error = await failure(WIDTH_REFUSAL, DELETE);

    expect(error.message).toBe("hwp edit failed (exit 3)");
    expect(error.stderr).toBe(WIDTH_REFUSAL);
  });
});

/**
 * The other half of the same boundary: a successful edit's report names the
 * `-o` path the engine wrote to, which is inside this server's work dir. No
 * temp path may reach a caller, and that rule covers report fields as much as
 * messages, so `output` comes back as the caller's own document name.
 */
describe("edit report boundary", () => {
  const staged = "/var/folders/tmp/hwp-editor-abc123/out.hwpx";
  const report = JSON.stringify({
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: staged,
    dry_run: false,
    ops: [{
      index: 0,
      op: "insert_blocks",
      status: "applied",
      pieces_touched: 1,
      changed: [{ before: null, after: "a84ac20e7a012e4a.0.2" }],
      reason: null,
    }],
    applied_count: 1,
    failed_count: 0,
  });

  it("returns the caller's document name instead of the staged output path", async () => {
    const { bin } = createFakeBin({ info: "{}", editReport: report });
    const edited = await createCliEngine({ bin }).edit(
      { name: "sample.hwpx", data: new Uint8Array([1, 2, 3]) },
      INSERT,
      { report: true },
    );

    expect(edited.report?.output).toBe("sample.hwpx");
    expect(JSON.stringify(edited.report)).not.toContain(staged);
    // The ids the palette keys on are untouched by the rewrite.
    expect(edited.report?.ops[0]?.changed[0]?.after).toBe("a84ac20e7a012e4a.0.2");
  });

  it("answers without a report when the file cannot be parsed", async () => {
    // An unreadable report is a host whose ids are unknown, not a failed edit:
    // the document itself was published, and the client shows its own notice.
    const { bin } = createFakeBin({ info: "{}", editReport: "{not json" });
    const edited = await createCliEngine({ bin }).edit(document, INSERT, { report: true });

    expect(edited.report).toBeUndefined();
    expect(edited.name).toBe("sample.hwpx");
    expect(edited.data).toEqual(document.data);
  });
});
