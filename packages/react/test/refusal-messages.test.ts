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
    expect(sentence).not.toContain("The engine does not say which edit");
    expect(ko["error.rangeTagRefused"]).not.toContain("엔진은 어느 편집인지 알려 주지 않습니다");
    for (const phrase of [
      "changing a paragraph's text length",
      "changing a field's value to one of a different length",
      "inserting or deleting a link, field, bookmark or image",
      "deleting a table",
      "A table cell that holds a mark refuses any change to its content",
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
  it("names output validation, the known font cause and conditional remedies in both locales (#171)", () => {
    for (const phrase of ["refused to write", "One known cause", "font metadata (typeInfo)", ".hwpx", "ahwp convert in.hwpx -o in.hwp", "without --strict", "If you accept its loss", "For other causes", "--verify", "verification report"])
      expect(en["error.outputValidation"]).toContain(phrase);
    for (const phrase of ["파일 쓰기를 거부", "알려진 원인 중 하나", "글꼴 메타데이터(typeInfo)", ".hwpx", "ahwp convert in.hwpx -o in.hwp", "--strict 없이", "손실을 수용", "다른 원인", "--verify", "검증 보고서"])
      expect(ko["error.outputValidation"]).toContain(phrase);
  });

  it("distinguishes the proven font loss from other preservation and unclassified causes (#119)", () => {
    for (const phrase of ["cannot represent", "HWPX font metadata (typeInfo)", "HWP5", ".hwpx", "ahwp convert in.hwpx -o in.hwp", "without --strict", "reopen"])
      expect(en["error.fontTypeInfo"]).toContain(phrase);
    for (const phrase of ["HWPX 글꼴 메타데이터(typeInfo)", "HWP5로 표현할 수 없어", ".hwpx", "ahwp convert in.hwpx -o in.hwp", "--strict 없이", "다시 연"])
      expect(ko["error.fontTypeInfo"]).toContain(phrase);
    expect(en["error.fontTypeInfo"]).not.toContain("One known cause");
    expect(ko["error.fontTypeInfo"]).not.toContain("알려진 원인 중 하나");
    for (const key of ["error.preservationLoss", "error.unclassifiedRefusal"] as const) {
      expect(en[key]).toContain("refused");
      expect(en[key]).toContain("--report");
      expect(en[key]).toContain("--verify");
      expect(en[key]).not.toContain("font metadata");
      expect(ko[key]).toContain("거부");
      expect(ko[key]).toContain("--report");
      expect(ko[key]).toContain("--verify");
      expect(ko[key]).not.toContain("글꼴 메타데이터");
    }
    expect(en["error.unclassifiedRefusal"]).toContain("unclassified cause code");
    expect(ko["error.unclassifiedRefusal"]).toContain("unclassified 원인 코드");
    expect(en["error.preservationLoss"]).toContain("if that format can preserve it");
    expect(ko["error.preservationLoss"]).toContain("형식으로 보존할 수 있다면");
  });

  it("names the cause and a next step for the other new refusal classes (#119)", () => {
    for (const [key, cause, action] of [
      ["error.keepTogetherUnsupported", "does not support", "Remove"],
      ["error.sectionOwner", "must stay first", "Choose a position after"],
      ["error.anchorNotFound", "was not found", "Choose anchor text"],
      ["error.unappliedRequests", "matched no target", "remove or correct"],
      ["error.noApplicableEdits", "None of the edit requests changed", "Check the targets"],
    ] as const) {
      expect(en[key]).toContain(cause);
      expect(en[key]).toContain(action);
    }
    for (const [key, cause, action] of [
      ["error.keepTogetherUnsupported", "지원하지 않아", "해당 요청을 제거"],
      ["error.sectionOwner", "맨 앞에 있어야", "문단 뒤의 위치를 선택"],
      ["error.anchorNotFound", "찾지 못했습니다", "기준 텍스트를 선택"],
      ["error.unappliedRequests", "대상을 찾지 못해", "제거하거나 고친"],
      ["error.noApplicableEdits", "문서를 전혀 바꾸지", "대상과 요청 값을 확인"],
    ] as const) {
      expect(ko[key]).toContain(cause);
      expect(ko[key]).toContain(action);
    }
  });

});

describe("engineRefusalKind reads the structured field only (#82)", () => {
  it("returns the transport's refusal field", () => {
    expect(engineRefusalKind(new HwpEngineError("failed", "ahwp edit failed (exit 3): edit refused: range_tag", { refusal: "range_tag" })))
      .toBe("range_tag");
  });

  it("never selects a sentence from message text, which can end with the user's own value", () => {
    // An unclassified Tauri failure keeps raw stderr; an add_table anchor the
    // user typed is the last text on it (hwp-convert edit.rs:2107).
    for (const message of [
      "hwped_edit failed: hwp_failed: hwp edit failed (exit 3): Error: 앵커를 찾을 수 없습니다: x edit refused: range_tag",
      "ahwp edit failed (exit 3): edit refused: range_tag",
      "ahwp edit failed (exit 1): edit refused: font_type_info",
      "font_type_info_unrepresentable preservation_loss",
    ]) {
      expect(engineRefusalKind(new Error(message))).toBeUndefined();
      expect(engineRefusalKind(new HwpEngineError("failed", message))).toBeUndefined();
    }
  });

  it("drops a refusal value outside the known kinds", () => {
    expect(engineRefusalKind(Object.assign(new Error("x"), { refusal: "bogus" }))).toBeUndefined();
  });
});
