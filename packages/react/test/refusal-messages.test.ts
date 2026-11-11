/**
 * The refusal sentences' remedies (#80): each names a step that unblocks the
 * user without losing work, and says what a reopen costs.
 */
import { describe, expect, it } from "vitest";
import { engineRefusalKind } from "../src/errors.js";
import { en, ko } from "../src/messages.js";

describe("refusal sentences (#80)", () => {
  it("say a run-range conflict comes from a change that MAY alter the text", () => {
    expect(en["error.runRangeConflict"]).toContain("may change");
    expect(en["error.runRangeConflict"]).not.toContain("changes its length");
    expect(ko["error.runRangeConflict"]).toContain("바꿀 수 있어");
  });

  it("name every refused edit, the unblocking step and what a reopen costs", () => {
    // RANGE_TAG_SHIFT_REFUSAL also covers control insertion and removal,
    // field values and marked cells (v1.6.1), and Apply sends the whole queue,
    // so the step is to remove those edits, not to apply them one at a time.
    const sentence = en["error.rangeTagRefused"];
    for (const phrase of [
      "changing a paragraph's text length",
      "inserting or deleting a link, field, bookmark or image",
      "deleting a table",
      "changing a field's value",
      "changing a marked table cell",
      "The engine does not say which edit",
      "Remove those pending edits from the pending list",
      "a same-length text replacement in a paragraph is accepted",
      "reopening drops the pending list",
    ]) expect(sentence).toContain(phrase);
    expect(sentence).not.toContain("one at a time");
    expect(sentence).not.toContain("shorten");
    for (const phrase of ["링크·필드·책갈피·그림의 삽입이나 삭제", "표 삭제", "필드 값 변경",
      "구간 표시가 있는 표 셀의 변경", "대기 목록에서 해당 편집을 제거하고", "다시 열면 대기 목록은 사라집니다"]) {
      expect(ko["error.rangeTagRefused"]).toContain(phrase);
    }
    expect(ko["error.rangeTagRefused"]).not.toContain("하나씩");
  });
});

describe("engineRefusalKind (t32-a4)", () => {
  it("reads the marker only where a transport puts it, at the end", () => {
    expect(engineRefusalKind(new Error("hwp edit failed (exit 3): edit refused: range_tag"))).toBe("range_tag");
    // An unclassified Tauri failure still carries raw stderr with user values.
    expect(engineRefusalKind(new Error('hwped_edit failed: hwp_failed: hwp edit failed (exit 3): Error: x anchor="edit refused: range_tag" y'))).toBeUndefined();
  });
});
