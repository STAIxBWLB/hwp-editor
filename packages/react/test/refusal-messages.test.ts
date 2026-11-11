/**
 * The refusal sentences' remedies (#80): each names a step that unblocks the
 * user without losing work, and says what a reopen costs.
 */
import { describe, expect, it } from "vitest";
import { HwpEngineError } from "@hwp-editor/core";
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
    // set_field is refused only when the value's width changes (hwp-convert
    // field.rs:368), like paragraph text; a marked cell refuses any change
    // (edit.rs:1687-1727), so it is its own sentence, not a length rule. The
    // HWPX writer emits no paragraph extras, so converting drops the marks.
    const sentence = en["error.rangeTagRefused"];
    for (const phrase of [
      "changing a paragraph's text length",
      "changing a field's value to one of a different length",
      "inserting or deleting a link, field, bookmark or image",
      "deleting a table",
      "A table cell that holds a mark refuses any change to its content",
      "The engine does not say which edit",
      "Remove those pending edits from the pending list",
      "a same-length text replacement in a paragraph, or a same-length field value, is accepted",
      "convert the document to HWPX, which drops the range marks",
      "reopening drops the pending list",
    ]) expect(sentence).toContain(phrase);
    expect(sentence).not.toContain("one at a time");
    expect(sentence).not.toContain("shorten");
    for (const phrase of [
      "문단 텍스트 길이 변경",
      "길이가 다른 필드 값으로의 변경",
      "링크·필드·책갈피·이미지의 삽입이나 삭제",
      "표 삭제",
      "구간 표시가 있는 표 셀은 내용을 어떻게 바꾸든 거부합니다",
      "대기 목록에서 해당 편집을 제거하고",
      "문단 안의 같은 길이 텍스트 치환과 같은 길이의 필드 값은 허용됩니다",
      "변환하면 구간 표시가 사라집니다",
      "다시 열면 대기 목록은 사라집니다",
    ]) expect(ko["error.rangeTagRefused"]).toContain(phrase);
    // One term for images, the one the pending list uses.
    expect(ko["error.rangeTagRefused"]).not.toContain("그림");
    expect(ko["error.runRangeConflict"]).not.toContain("그림");
    expect(ko["pending.kind.insert-image"]).toContain("이미지");
    expect(ko["error.rangeTagRefused"]).not.toContain("하나씩");
  });
});

describe("engineRefusalKind reads the structured field only (#82)", () => {
  it("returns the transport's refusal field", () => {
    expect(engineRefusalKind(new HwpEngineError("failed", "hwp edit failed (exit 3): edit refused: range_tag", { refusal: "range_tag" })))
      .toBe("range_tag");
  });

  it("never selects a sentence from message text, which can end with the user's own value", () => {
    // An unclassified Tauri failure keeps raw stderr; an add_table anchor the
    // user typed is the last text on it (hwp-convert edit.rs:2107).
    for (const message of [
      "hwped_edit failed: hwp_failed: hwp edit failed (exit 3): Error: 앵커를 찾을 수 없습니다: x edit refused: range_tag",
      "hwp edit failed (exit 3): edit refused: range_tag",
    ]) {
      expect(engineRefusalKind(new Error(message))).toBeUndefined();
      expect(engineRefusalKind(new HwpEngineError("failed", message))).toBeUndefined();
    }
  });

  it("drops a refusal value outside the known kinds", () => {
    expect(engineRefusalKind(Object.assign(new Error("x"), { refusal: "bogus" }))).toBeUndefined();
  });
});
