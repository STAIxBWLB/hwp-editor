/**
 * The insert_blocks classes and the shared display line (#88). The stderr
 * lines are the ones ahwp 1.6.1 writes, measured with `hwp edit --ops`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyInsertionRefusal,
  insertionRefusalLine,
  isInsertionRefusal,
  unclassifiedEditLine,
  withoutPaths,
} from "../src/index.js";

const STYLE_TAIL = "을 대상 문서에서 찾을 수 없습니다. styles 정의를 제공하고 missing_style=create로 다시 시도하거나 hwp styles에서 기존 스타일을 선택하세요";
const style = (name: string): string => `Error: 스타일 '${name}'${STYLE_TAIL}`;
const definition = (issues: string, container = "150.0"): string =>
  `Error: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다: ${issues}. DocumentSpec v1 정의를 수정한 뒤 다시 시도하세요 (삽입 위치의 폭은 ${container}mm입니다)`;

/** Measured: a 900 mm table into a 150 mm body. */
const WIDTH = definition(
  "layout_overflow at $.sections[0].blocks[0].columns: column widths total 900.00 mm; body width is 150.00 mm; " +
  "layout_overflow at $.sections[0].blocks[0].width_mm: table width exceeds body width 150.00 mm",
);

describe("insertion refusal classifier (#88)", () => {
  it("reads each measured class and its widths", () => {
    expect(classifyInsertionRefusal(WIDTH)).toEqual({ kind: "layout_overflow", blockMm: 900, insertionMm: 150 });
    expect(classifyInsertionRefusal(style("결재란 셀"))).toEqual({ kind: "unknown_style", style: "결재란 셀" });
    expect(classifyInsertionRefusal(definition("invalid_value at $.sections[0].blocks[0].rows: rows must not be empty")))
      .toEqual({ kind: "invalid_definition" });
    expect(classifyInsertionRefusal("Error: insert_blocks 구역 정의 문단 앞에는 삽입할 수 없습니다")).toBeUndefined();
  });

  it("reads a nested cell's width from its own issue, not the insertion point (t37-a6)", () => {
    // Measured: a 120 mm table inside a 100 mm cell; the cell's content width
    // is 96.40 mm while the line's tail names the 150 mm insertion point.
    const nested = definition(
      "layout_overflow at $.sections[0].blocks[0].rows[0].cells[0].blocks[0].columns: column widths total 120.00 mm; body width is 96.40 mm; " +
      "layout_overflow at $.sections[0].blocks[0].rows[0].cells[0].blocks[0].width_mm: table width exceeds body width 96.40 mm",
    );
    expect(classifyInsertionRefusal(nested)).toEqual({ kind: "layout_overflow", blockMm: 120, insertionMm: 96.4 });
  });

  it("reads an image overflow's width from its issue", () => {
    const image = definition("layout_overflow at $.sections[0].blocks[0].width_mm: image width exceeds body width 46.40 mm");
    expect(classifyInsertionRefusal(image)).toEqual({ kind: "layout_overflow", insertionMm: 46.4 });
  });

  it("keeps a style name that holds a quote or the tail's own words whole", () => {
    expect(classifyInsertionRefusal(style("결재란 (법인) '대표'"))).toEqual({ kind: "unknown_style", style: "결재란 (법인) '대표'" });
  });

  describe("a user value cannot choose the class (t37-a1 probes)", () => {
    it("an add_table anchor carrying the unknown-style sentence", () => {
      // hwp-convert edit.rs:2107 prints `앵커를 찾을 수 없습니다: {anchor}`.
      const line = `Error: 앵커를 찾을 수 없습니다: 메모 스타일 '가짜'${STYLE_TAIL}`;
      expect(classifyInsertionRefusal(line)).toBeUndefined();
    });

    it("an anchor carrying the definition head and a layout_overflow width", () => {
      const line = "Error: 앵커를 찾을 수 없습니다: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다 layout_overflow body width 9 mm";
      expect(classifyInsertionRefusal(line)).toBeUndefined();
    });

    it("a duplicate-style refusal whose name carries the unknown-style text", () => {
      // insert_blocks.rs:370: a different sentence; its name must not make it unknown_style.
      const name = `x'${STYLE_TAIL} '`;
      const line = `Error: 스타일 '${name}'이 대상 문서에 여러 개 있어 삽입을 거부했습니다. 원본 문서의 중복 이름을 정리한 뒤 hwp styles에서 확인하세요`;
      expect(classifyInsertionRefusal(line)).toBeUndefined();
    });

    it("a style name forging a layout_overflow entry with a non-spec path (t37-a1 recurrence)", () => {
      // Issue paths carry style names (document_spec.rs:506-517); this one
      // holds `; layout_overflow at $.z: b`.
      const line = definition("unknown_style at $.styles[\"a; layout_overflow at $.z: b\"].based_on: missing parent");
      expect(classifyInsertionRefusal(line)).toEqual({ kind: "invalid_definition" });
    });

    it("a forged entry cannot supply blockMm to a real overflow", () => {
      const line = definition(
        "unknown_style at $.styles[\"a; layout_overflow at $.z.columns: column widths total 999.00 mm; body width is 1.00 mm\"]: x; " +
        "layout_overflow at $.sections[0].blocks[0].width_mm: image width exceeds body width 46.40 mm",
      );
      expect(classifyInsertionRefusal(line)).toEqual({ kind: "layout_overflow", insertionMm: 46.4 });
    });

    it("a layout_overflow token inside another issue's message", () => {
      const line = definition("invalid_value at $.sections[0].blocks[0].style: unknown name layout_overflow at $.x: 9 mm");
      expect(classifyInsertionRefusal(line)).toEqual({ kind: "invalid_definition" });
    });
  });

  it("classifies only the first Error: line", () => {
    expect(classifyInsertionRefusal(`note: ${style("x").slice(7)}\nError: 출력 파일을 쓸 수 없습니다`)).toBeUndefined();
  });

  it("writes the same one-line cause on both transports", () => {
    expect(insertionRefusalLine(WIDTH)).toBe("insert_blocks refused: layout_overflow (block 900.00 mm, insertion point 150.00 mm)");
    expect(insertionRefusalLine("Error: failed to parse /tmp/w/in.hwpx at byte 42")).toBe("insert_blocks refused: failed to parse <path> at byte 42");
  });
});

describe("isInsertionRefusal (t37-a3)", () => {
  it("refuses every malformed wire shape", () => {
    for (const bad of [
      null, undefined, 42, "layout_overflow", [], {},
      { kind: "bogus" },
      { kind: "unknown_style" },
      { kind: "unknown_style", style: "" },
      { kind: "unknown_style", style: "   " },
      { kind: "unknown_style", style: 7 },
      { kind: "layout_overflow", blockMm: Number.NaN },
      { kind: "layout_overflow", insertionMm: Number.POSITIVE_INFINITY },
      { kind: "layout_overflow", insertionMm: "46.4" },
      { kind: "layout_overflow", insertionMm: 0 },
      { kind: "layout_overflow", blockMm: -1 },
      { kind: "layout_overflow", blockMm: null },
    ]) expect(isInsertionRefusal(bad)).toBe(false);
  });

  it("accepts the three classes", () => {
    expect(isInsertionRefusal({ kind: "layout_overflow", insertionMm: 46.4 })).toBe(true);
    expect(isInsertionRefusal({ kind: "layout_overflow" })).toBe(true);
    expect(isInsertionRefusal({ kind: "unknown_style", style: "x" })).toBe(true);
    expect(isInsertionRefusal({ kind: "invalid_definition" })).toBe(true);
  });
});

describe("unclassifiedEditLine and path scrubbing (t37-a2)", () => {
  it("shows the engine's first Error: line and the step", () => {
    expect(unclassifiedEditLine("note\nError: 앵커를 찾을 수 없습니다: 회의록\nCaused by: x"))
      .toBe("앵커를 찾을 수 없습니다: 회의록. Fix or remove the pending edit it names, then apply again.");
  });

  it.each([
    ["POSIX with spaces", "Error: failed to read /Users/a b/Library/Caches/x y/in.hwpx at byte 3", "failed to read <path> at byte 3"],
    ["Windows with spaces", "Error: failed to read C:\\Users\\a b\\AppData\\in.hwpx at byte 3", "failed to read <path> at byte 3"],
    ["quoted POSIX", 'Error: cannot open "/Users/a b/x/out file.hwpx": denied', 'cannot open "<path>": denied'],
    ["quoted Windows", "Error: cannot open 'C:\\a b\\c.png'", "cannot open '<path>'"],
    ["no extension", "Error: no such dir /var/folders/ab/T/stage", "no such dir <path>"],
  ])("redacts an absolute path: %s", (_label, stderr, reason) => {
    const line = unclassifiedEditLine(stderr);
    expect(line).toBe(`${reason}. Fix or remove the pending edit it names, then apply again.`);
    expect(line).not.toMatch(/Users|Library|AppData|folders/u);
  });

  it("keeps the Korean diagnostic's own slashes", () => {
    expect(withoutPaths("블록/스타일/목록 정의")).toBe("블록/스타일/목록 정의");
  });
});
