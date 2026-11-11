import { describe, expect, it } from "vitest";
import {
  classifyInsertionRefusal,
  insertionRefusalLine,
  isInsertionRefusal,
} from "../src/index.js";

const WIDTH =
  "Error: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다: layout_overflow at " +
  "$.sections[0].blocks[0].columns: column widths total 120.00 mm; body width is 46.40 mm; " +
  "DocumentSpec v1 정의를 수정한 뒤 다시 시도하세요 (삽입 위치의 폭은 46.4mm입니다)";

describe("insertion refusal classifier (#88)", () => {
  it("reads each class and its measurements", () => {
    expect(classifyInsertionRefusal(WIDTH)).toEqual({ kind: "layout_overflow", blockMm: 120, insertionMm: 46.4 });
    expect(classifyInsertionRefusal("Error: 스타일 '결재란 (법인)'을 대상 문서에서 찾을 수 없습니다. styles 정의를"))
      .toEqual({ kind: "unknown_style", style: "결재란 (법인)" });
    expect(classifyInsertionRefusal("Error: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다: $.x"))
      .toEqual({ kind: "invalid_definition" });
    expect(classifyInsertionRefusal("Error: insert_blocks 구역 정의 문단 앞에는 삽입할 수 없습니다")).toBeUndefined();
  });

  it("ignores a class token echoed before the Error: line", () => {
    const echoed = "note: 스타일 'x'을 대상 문서에서 찾을 수 없습니다\nError: 출력 파일을 쓸 수 없습니다";
    expect(classifyInsertionRefusal(echoed)).toBeUndefined();
  });

  it("writes the same one-line cause the server always wrote", () => {
    expect(insertionRefusalLine(WIDTH)).toBe("insert_blocks refused: layout_overflow (block 120.00 mm, insertion point 46.40 mm)");
    expect(insertionRefusalLine("Error: failed to parse /tmp/w/in.hwpx at byte 42")).toBe("insert_blocks refused: failed to parse <path> at byte 42");
  });

  it("refuses every malformed wire shape (#88 review)", () => {
    for (const bad of [
      null, undefined, 42, "layout_overflow", [], {},
      { kind: "bogus" },
      { kind: "unknown_style" },
      { kind: "unknown_style", style: "" },
      { kind: "unknown_style", style: 7 },
      { kind: "layout_overflow", blockMm: Number.NaN },
      { kind: "layout_overflow", insertionMm: Number.POSITIVE_INFINITY },
      { kind: "layout_overflow", insertionMm: "46.4" },
      { kind: "layout_overflow", blockMm: null },
    ]) expect(isInsertionRefusal(bad)).toBe(false);
  });

  it("narrows untrusted values", () => {
    expect(isInsertionRefusal({ kind: "layout_overflow", insertionMm: 46.4 })).toBe(true);
    expect(isInsertionRefusal({ kind: "layout_overflow", insertionMm: "46" })).toBe(false);
    expect(isInsertionRefusal({ kind: "unknown_style", style: "" })).toBe(false);
    expect(isInsertionRefusal({ kind: "bogus" })).toBe(false);
    expect(isInsertionRefusal("layout_overflow")).toBe(false);
  });
});
