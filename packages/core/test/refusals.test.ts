import { describe, expect, it } from "vitest";
import { classifyEditRefusal, editRefusalMarker, unappliedItems } from "../src/index.js";
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

  it("finds a refusal wrapped in anyhow context on a Caused by line", () => {
    const wrapped = `Error: op[3] 적용 실패\n\nCaused by:\n    ${RANGE_TAG.slice("Error: ".length)}`;
    expect(classifyEditRefusal(wrapped)).toBe("range_tag");
  });

  it("ignores tokens on lines before the Error: line", () => {
    const echoed = '치환: "a" → "미해석 PARA_RANGE_TAG 구간 표시가 있어 WCHAR 위치가 바뀌거나"\nError: 출력 파일을 쓸 수 없습니다';
    expect(classifyEditRefusal(echoed)).toBeUndefined();
  });

  it("reads the unapplied list from the Error: line, not an earlier echo", () => {
    const echoed = `치환: "적용되지 않은 편집 요청이 있습니다: set_field name=\\"x\\""\n${UNMATCHED}`;
    expect(unappliedItems(echoed)).toEqual(['replace address=0.1 from="없는 텍스트" to="{{owner}}"']);
    expect(classifyEditRefusal(echoed)).toBe("unmatched_replace");
  });

  it("spells the marker the editor reads", () => {
    expect(editRefusalMarker("range_tag")).toBe("edit refused: range_tag");
  });
});
