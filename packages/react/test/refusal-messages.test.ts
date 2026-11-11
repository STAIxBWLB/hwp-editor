/**
 * The refusal sentences' remedies (#80): each names a step that unblocks the
 * user without losing work, and says what a reopen costs.
 */
import { describe, expect, it } from "vitest";
import { en, ko } from "../src/messages.js";

describe("refusal sentences (#80)", () => {
  it("say a run-range conflict comes from a change that MAY alter the text", () => {
    expect(en["error.runRangeConflict"]).toContain("may change");
    expect(en["error.runRangeConflict"]).not.toContain("changes its length");
    expect(ko["error.runRangeConflict"]).toContain("바꿀 수 있어");
  });

  it("offer the in-place step for a range mark and say a reopen drops the pending list", () => {
    expect(en["error.rangeTagRefused"]).toContain("Remove or shorten that edit in the pending list");
    expect(en["error.rangeTagRefused"]).toContain("reopening the document drops the pending list");
    expect(ko["error.rangeTagRefused"]).toContain("대기 목록에서 그 편집을 제거하거나 줄인 뒤");
    expect(ko["error.rangeTagRefused"]).toContain("대기 목록은 사라집니다");
  });
});
