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
const RUN_CONFLICT =
  "Error: 주소 지정 편집이 서로 충돌합니다:\nop[0]이 문단 0.1의 길이를 바꿀 수 있어 op[1]의 고정된 run 범위가 무효화됩니다";

const OPS: EditOp[] = [{ kind: "replace", address: { at: { section: 0, paragraph: 1 } }, find: "a", replace: "bb" }];
const document = { name: "sample.hwp", data: new Uint8Array([1, 2, 3]) };

async function failure(stderr: string): Promise<HwpCliError> {
  const { bin } = createFakeBin({ info: "{}", mode: "fail", editStderr: stderr });
  const error = await createCliEngine({ bin }).edit(document, OPS).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(HwpCliError);
  return error as HwpCliError;
}

describe("hwp-cli 1.5-1.6 refusal classification (#76)", () => {
  it("marks a PARA_RANGE_TAG refusal as range_tag (hwp-cli#470)", async () => {
    const error = await failure(RANGE_TAG);
    expect(error.reason).toBe("failed");
    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: range_tag");
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
    const removal = "Error: 주소 지정 편집이 서로 충돌합니다:\nop[0]이 문단 0.1을(를) 제거하여 op[1]이 같은 주소(또는 그 하위 경로)를 가리킬 수 없습니다";
    const error = await failure(removal);
    expect(error.message).not.toContain("edit refused:");
  });
});
