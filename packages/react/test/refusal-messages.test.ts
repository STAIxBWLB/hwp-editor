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
    // The engine refuses any length change, shorter included, so "shorten" would not unblock.
    expect(en["error.rangeTagRefused"]).toContain("Remove that edit from the pending list");
    expect(en["error.rangeTagRefused"]).toContain("same length");
    expect(en["error.rangeTagRefused"]).not.toContain("shorten");
    expect(en["error.rangeTagRefused"]).toContain("reopening the document drops the pending list");
    expect(ko["error.rangeTagRefused"]).toContain("같은 길이의 치환");
    expect(ko["error.rangeTagRefused"]).not.toContain("줄인");
    expect(ko["error.rangeTagRefused"]).toContain("대기 목록은 사라집니다");
  });
});

import { engineRefusalKind } from "../src/errors.js";

describe("engineRefusalKind (t32-a4)", () => {
  it("reads the marker only where a transport puts it, at the end", () => {
    expect(engineRefusalKind(new Error("hwp edit failed (exit 3): edit refused: range_tag"))).toBe("range_tag");
    // An unclassified Tauri failure still carries raw stderr with user values.
    expect(engineRefusalKind(new Error('hwped_edit failed: hwp_failed: hwp edit failed (exit 3): Error: x anchor="edit refused: range_tag" y'))).toBeUndefined();
  });
});
