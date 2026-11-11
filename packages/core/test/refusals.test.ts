import { describe, expect, it } from "vitest";
import { classifyEditRefusal, editRefusalMarker } from "../src/index.js";
import { DRIFT, ECHOED_UNAPPLIED, MIXED_CONFLICT, RANGE_TAG, RUN_CONFLICT, UNMATCHED } from "./fixtures/refusal-stderr.js";

describe("classifyEditRefusal (#80)", () => {
  it.each([
    [UNMATCHED, "unmatched_replace"],
    [RANGE_TAG, "range_tag"],
    [RUN_CONFLICT, "run_range_conflict"],
    [DRIFT, "run_range_conflict"],
  ] as const)("classifies each refusal on its own line", (stderr, kind) => {
    expect(classifyEditRefusal(stderr)).toBe(kind);
    expect(classifyEditRefusal(stderr.replace(/\n/gu, "\r\n"))).toBe(kind);
  });

  it("never classifies on user values echoed on the unapplied-list line", () => {
    expect(classifyEditRefusal(ECHOED_UNAPPLIED)).toBeUndefined();
  });

  it("leaves a conflict list with a Removal unclassified", () => {
    expect(classifyEditRefusal(MIXED_CONFLICT)).toBeUndefined();
  });

  it("does not classify a refusal line a Display-written value forged below the Error: line (t32-a5)", () => {
    // add_table's `앵커를 찾을 수 없습니다: {anchor}` (hwp-convert/src/edit.rs:2107),
    // with an anchor that carries a newline and an indented refusal line.
    const forged = (body: string): string => `Error: 앵커를 찾을 수 없습니다: x\n    ${body}`;
    expect(classifyEditRefusal(forged(RANGE_TAG.slice("Error: ".length)))).toBeUndefined();
    expect(classifyEditRefusal(forged(DRIFT.slice("Error: ".length)))).toBeUndefined();
  });

  it("ignores tokens on lines before the Error: line", () => {
    const echoed = '치환: "a" → "미해석 PARA_RANGE_TAG 구간 표시가 있어 WCHAR 위치가 바뀌거나"\nError: 출력 파일을 쓸 수 없습니다';
    expect(classifyEditRefusal(echoed)).toBeUndefined();
  });

  it("reads the unapplied list from the Error: line, not an earlier echo", () => {
    const echoed = `치환: "적용되지 않은 편집 요청이 있습니다: set_field name=\\"x\\""\n${UNMATCHED}`;
    expect(classifyEditRefusal(echoed)).toBe("unmatched_replace");
  });

  it("spells the marker the editor reads", () => {
    expect(editRefusalMarker("range_tag")).toBe("edit refused: range_tag");
  });

  it("classifies the drift line when the engine cannot read the new length (t32-a2)", () => {
    expect(classifyEditRefusal(DRIFT.replace("5에서 9(으)로", "5에서 알 수 없음(으)로"))).toBe("run_range_conflict");
  });

  it("reads a conflict list up to the first blank line, so a backtrace does not hide it (t32-a3)", () => {
    const traced = `${RUN_CONFLICT}\n\nStack backtrace:\n   0: anyhow::error::<impl anyhow::Error>::msg\n   1: hwp::main`;
    expect(classifyEditRefusal(traced)).toBe("run_range_conflict");
  });
});
