/**
 * The hwp-cli 1.5-1.6 refusals the editor can reach (#76), carried across the
 * CLI boundary as stable markers. The stderr lines are the ones hwp-cli v1.6.1
 * writes: `RANGE_TAG_SHIFT_REFUSAL` (hwp-convert/src/edit.rs:179) and the
 * `ConflictKind::LengthChange` line (hwp-cli/src/commands/edit.rs:1137).
 */
import { afterEach, describe, expect, it } from "vitest";

import type { EditOp } from "@hwp-editor/core";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";

afterEach(disposeFakeBins);

const RANGE_TAG =
  "Error: 미해석 PARA_RANGE_TAG 구간 표시가 있어 WCHAR 위치가 바뀌거나 표시를 잃는 문단 재작성을 지원하지 않습니다. " +
  "같은 WCHAR 길이의 텍스트 치환을 사용하거나 한글에서 구간 표시를 제거한 파일로 다시 실행하세요.";
// Multi-line refusals are written one line each, as the engine prints them.
const RUN_CONFLICT = [
  "Error: 주소 지정 편집이 서로 충돌합니다:",
  "op[0]이 문단 0.1의 길이를 바꿀 수 있어 op[1]의 고정된 run 범위가 무효화됩니다",
];
/** A Removal and a LengthChange in one list (#80): the run-range step would clear only one. */
const MIXED_CONFLICT = [
  "Error: 주소 지정 편집이 서로 충돌합니다:",
  "op[0]이 문단 0.1을(를) 제거하여 op[1]이 같은 주소(또는 그 하위 경로)를 가리킬 수 없습니다",
  "op[2]이 문단 0.2의 길이를 바꿀 수 있어 op[3]의 고정된 run 범위가 무효화됩니다",
];
/** An unapplied hyperlink whose user values carry every matched token (#80). */
const ECHOED_UNAPPLIED =
  "Error: 적용되지 않은 편집 요청이 있습니다: " +
  'create_hyperlink anchor="미해석 PARA_RANGE_TAG 구간 표시가 있어 WCHAR 위치가 바뀌거나" ' +
  'url="https://x/범위가 다른 글자를 가리킵니다. 고정된 run 범위가 무효화됩니다" ' +
  "(--allow-partial로 일치한 요청만 적용 가능)";

const OPS: EditOp[] = [{ kind: "replace", address: { at: { section: 0, paragraph: 1 } }, find: "a", replace: "bb" }];
const document = { name: "sample.hwp", data: new Uint8Array([1, 2, 3]) };

const DRIFT =
  "Error: set_format 주소 [0, 2)의 문단은 앞선 연산(set_indent_level, replace 등)으로 글자 수가 5에서 9(으)로 바뀌어 " +
  "범위가 다른 글자를 가리킵니다. 아무것도 쓰지 않았습니다. 연산 순서를 바꿔 set_format을 앞에 두거나 별도 편집으로 나누어 실행하세요";

async function failure(stderr: string | string[], ops: EditOp[] = OPS, assets?: Array<{ name: string; data: Uint8Array }>): Promise<HwpCliError> {
  const { bin } = createFakeBin({
    info: "{}",
    mode: "fail",
    ...(Array.isArray(stderr) ? { editStderrLines: stderr } : { editStderr: stderr }),
  });
  const error = await createCliEngine({ bin }).edit(document, ops, assets === undefined ? undefined : { assets })
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(HwpCliError);
  return error as HwpCliError;
}

describe("hwp-cli 1.5-1.6 refusal classification (#76)", () => {
  it("marks a PARA_RANGE_TAG refusal as range_tag (hwp-cli#470)", async () => {
    const error = await failure(RANGE_TAG);
    expect(error.reason).toBe("failed");
    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: range_tag");
    expect(error.refusal).toBe("range_tag");
    expect(error.message).not.toContain("구간");
    expect(error.stderr).toBe(RANGE_TAG);
  });

  it("marks a run-range length conflict as run_range_conflict (hwp-cli#420)", async () => {
    const error = await failure(RUN_CONFLICT);
    expect(error.reason).toBe("failed");
    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: run_range_conflict");
    expect(error.message).not.toContain("op[");
  });

  it("leaves the other conflict kind (removal) unclassified", async () => {
    const removal = [
      "Error: 주소 지정 편집이 서로 충돌합니다:",
      "op[0]이 문단 0.1을(를) 제거하여 op[1]이 같은 주소(또는 그 하위 경로)를 가리킬 수 없습니다",
    ];
    const error = await failure(removal);
    expect(error.message).not.toContain("edit refused:");
  });

  it("marks the apply-time content-drift form of #420 as run_range_conflict (commands/edit.rs:3553)", async () => {
    const error = await failure(DRIFT);
    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: run_range_conflict");
    expect(error.message).not.toContain("set_format");
  });

  it("does not classify on a token the user's own value echoes outside the error line", async () => {
    // A progress line before the error echoes a replace's to-text verbatim.
    const echoed = ['치환: "a" → "PARA_RANGE_TAG 범위가 다른 글자를 가리킵니다"', "Error: 출력 파일을 쓸 수 없습니다"];
    const error = await failure(echoed);
    expect(error.message).not.toContain("edit refused:");
  });

  it("gives an image batch on a tagged paragraph the classified cause, not an image remedy (t31-a3)", async () => {
    const image: EditOp[] = [{ kind: "insert-image", anchor: "a", path: "figure.png", width: 20, height: 15 }];
    const error = await failure(RANGE_TAG, image, [{ name: "figure.png", data: new Uint8Array(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")) }]);
    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: range_tag");
    expect(error.message).not.toMatch(/Image insertion failed|re-export|operation targets/);
  });

  it("leaves a conflict list with a Removal unclassified (#80)", async () => {
    const error = await failure(MIXED_CONFLICT);
    expect(error.message).not.toContain("edit refused:");
  });

  it("never classifies on user values echoed on the unapplied-list line (#80)", async () => {
    const error = await failure(ECHOED_UNAPPLIED);
    expect(error.message).not.toContain("edit refused:");
  });

  it("keeps the insert-blocks prefix off a classified refusal in a mixed batch (#80)", async () => {
    const ops: EditOp[] = [
      { kind: "insert-blocks", address: { at: { section: 0, paragraph: 0 } }, position: "after",
        blocks: [{ type: "paragraph", runs: [{ type: "text", text: "x" }] }] },
      ...OPS,
    ];
    const error = await failure(RANGE_TAG, ops);
    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: range_tag");
    expect(error.message).not.toContain("insert_blocks refused");
  });

  it("reads the unapplied list from the Error: line, not an earlier echo (#80)", async () => {
    const error = await failure([
      '치환: "적용되지 않은 편집 요청이 있습니다: set_field name=x"',
      "Error: 적용되지 않은 편집 요청이 있습니다: replace address=0.1 from=\"a\" to=\"b\" (--allow-partial로 일치한 요청만 적용 가능)",
    ]);
    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: unmatched_replace");
  });
});
