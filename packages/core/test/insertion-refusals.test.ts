/**
 * The insert_blocks classes and the shared display line (#88). The stderr
 * lines are the ones ahwp 1.6.1 writes, measured with `hwp edit --ops`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyInsertionRefusal,
  insertionRefusalLine,
  isInsertionRefusal,
  NO_ENGINE_CAUSE,
  UNCLASSIFIED_EDIT_STEP,
  UNCLASSIFIED_FILE_STEP,
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

  it("never borrows the tail's width when the entry printed 0.00 mm (P3-1)", () => {
    const zero = definition(
      "layout_overflow at $.sections[0].blocks[0].rows[0].cells[0].blocks[0].width_mm: image width exceeds body width 0.00 mm",
      "170.0",
    );
    expect(classifyInsertionRefusal(zero)).toEqual({ kind: "layout_overflow" });
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
    // English heads are not the engine's IO heads, so these keep the edit step.
    expect(line).toBe(`${reason}. ${UNCLASSIFIED_EDIT_STEP}`);
    expect(line).not.toMatch(/Users|Library|AppData|folders/u);
  });

  it("keeps the Korean diagnostic's own slashes", () => {
    expect(withoutPaths("블록/스타일/목록 정의")).toBe("블록/스타일/목록 정의");
  });
});

describe("engine-line display after #90 (#93)", () => {
  const OS = ": No such file or directory (os error 2)";
  it.each([
    ["POSIX, Korean folder with a space", "/Users/홍 길동/Library/stage"],
    ["Windows, Korean folder with a space", "C:\\Users\\홍 길동\\AppData\\Local\\stage"],
    ["nested Korean folders with spaces", "/srv/data/결산 자료/2026 상반기/stage"],
    ["Program Files (x86)", "C:\\Program Files (x86)\\Maru\\stage"],
    ["OneDrive - Contoso", "C:\\Users\\a\\OneDrive - Contoso\\Documents\\stage"],
    ["several spaces", "/var/tmp/a b c/d/data"],
    ["Korean tail glued on", "/var/tmp/a b/결산/data"],
  ])("redacts a path up to the engine's `: ` separator: %s", (_label, path) => {
    expect(withoutPaths(`이미지 읽기 실패 ${path}${OS}`)).toBe(`이미지 읽기 실패 <path>${OS}`);
  });

  it.each([
    ["POSIX, spaces, no extension, no separator", "failed to read /var/tmp/a b/c/data at byte 3", "failed to read <path> at byte 3"],
    ["Windows, spaces, no separator", "cannot open C:\\Program Files\\Maru Data\\stage now", "cannot open <path> now"],
    ["UNC with slashes", "cannot open //server/share/a/in.hwpx now", "cannot open <path> now"],
    ["UNC with backslashes", "cannot open \\\\server\\share\\a\\stage now", "cannot open <path> now"],
    ["file URL", "cannot open file:///tmp/a/b.hwpx now", "cannot open <path> now"],
    ["single-segment file", "cannot open /in.hwpx now", "cannot open <path> now"],
  ])("redacts a path with no `: ` after it: %s", (_label, text, shown) => {
    expect(withoutPaths(text)).toBe(shown);
  });

  it.each([
    "수입 / 지출 내역은 별첨 결산.hwp 참조",
    "제목 / 부제",
    "앵커를 찾을 수 없습니다: 제목 / 부제",
    "앵커를 찾을 수 없습니다: a /b c",
    "앵커를 찾을 수 없습니다: a/b",
    "앵커를 찾을 수 없습니다: https://example.com/a/b",
  ])("leaves user text alone: %s", (text) => {
    expect(withoutPaths(text)).toBe(text);
  });

  it("keeps a Hangul word after a path with no `: ` rather than guessing it is the tail", () => {
    expect(withoutPaths("no such dir /var/x/stage 제목/부제")).toBe("no such dir <path> 제목/부제");
  });

  it("names a cause class and a step when stderr holds no Error: line (a panic)", () => {
    const panic = "thread 'main' panicked at src/edit.rs:12:5:\nindex out of bounds\nnote: run with `RUST_BACKTRACE=1`";
    expect(unclassifiedEditLine(panic)).toBe(NO_ENGINE_CAUSE);
    expect(NO_ENGINE_CAUSE).toMatch(/without naming a cause.*Apply again/u);
  });

  it("keeps the pending-edit step for a line that names an edit target", () => {
    expect(unclassifiedEditLine("Error: 앵커를 찾을 수 없습니다: 회의록")).toBe(`앵커를 찾을 수 없습니다: 회의록. ${UNCLASSIFIED_EDIT_STEP}`);
  });

  // Lines agent-hwp v1.6.2 writes, each from its source (see FILE_LINE_HEAD).
  it.each([
    ["Error: 입출력 오류: No such file or directory (os error 2)", "입출력 오류: No such file or directory (os error 2)"],
    ["Error: HWPX 파일이 아닙니다 (ZIP 열기 실패): invalid Zip archive: Could not find EOCD", "HWPX 파일이 아닙니다 (ZIP 열기 실패): invalid Zip archive: Could not find EOCD"],
    ["Error: XML 파싱 오류 (Contents/section0.xml): unexpected end", "XML 파싱 오류 (Contents/section0.xml): unexpected end"],
    ["Error: HWP 5.0 파일이 아닙니다 (CFB 컨테이너 열기 실패 또는 FileHeader 없음)", "HWP 5.0 파일이 아닙니다 (CFB 컨테이너 열기 실패 또는 FileHeader 없음)"],
    ["Error: 압축 해제 실패 (BodyText/Section0): corrupt deflate stream", "압축 해제 실패 (BodyText/Section0): corrupt deflate stream"],
    ["Error: 레코드 구조가 손상되었습니다: tag 66 length", "레코드 구조가 손상되었습니다: tag 66 length"],
    ["Error: 이미지 읽기 실패 /tmp/w/asset-0.png: Permission denied (os error 13)", "이미지 읽기 실패 <path>: Permission denied (os error 13)"],
    ["Error: 편집 연산 입력을 읽을 수 없습니다: expected value at line 1 column 1", "편집 연산 입력을 읽을 수 없습니다: expected value at line 1 column 1"],
    ["Error: 검증 재읽기 실패: /tmp/w/out.hwpx", "검증 재읽기 실패: <path>"],
  ])("gives a real document/IO line the file step: %s", (stderr, reason) => {
    expect(unclassifiedEditLine(stderr)).toBe(`${reason}. ${UNCLASSIFIED_FILE_STEP}`);
  });

  it("keys the file step on the engine's fixed head, not on a path-like anchor", () => {
    expect(unclassifiedEditLine("Error: 앵커를 찾을 수 없습니다: /tmp/x/y")).toBe(`앵커를 찾을 수 없습니다: <path>. ${UNCLASSIFIED_EDIT_STEP}`);
  });

  it("never shows a progress line as an insertion's cause", () => {
    const line = insertionRefusalLine("progress /tmp/a b/in.hwpx 50%\nthread 'main' panicked at x");
    expect(line).toBe(`insert_blocks refused: ${NO_ENGINE_CAUSE}`);
    expect(line).not.toMatch(/progress|50%/u);
  });
});

describe("redaction and file-head follow-ups (#142)", () => {
  it("runs the colon rule only on a file-head line, so later user text survives", () => {
    expect(withoutPaths("앵커를 찾을 수 없습니다: /tmp/w/x 다음 문장: 사용자 텍스트"))
      .toBe("앵커를 찾을 수 없습니다: <path> 다음 문장: 사용자 텍스트");
  });

  it("never treats a Hangul first segment as a path root", () => {
    expect(withoutPaths("예산 /항목/세부 비고: 확인")).toBe("예산 /항목/세부 비고: 확인");
  });

  it("does not merge two paths into one on a non-file line", () => {
    expect(withoutPaths("copy /tmp/a b/x to /tmp/c d/y: denied")).toBe("copy <path> to <path>: denied");
  });

  it("still redacts a file-head path with spaces up to the engine's `: `", () => {
    expect(withoutPaths("이미지 읽기 실패 /Users/홍 길동/Library/stage: Permission denied (os error 13)"))
      .toBe("이미지 읽기 실패 <path>: Permission denied (os error 13)");
  });

  // Documents the open limit (#142 item 2): with no `: ` after a path and no
  // known extension, a space-split tail stays until the Tauri host passes its
  // stage dir as workDir. Passing the work dir closes it.
  it("leaves the tail of a colon-less, extension-less path with spaces until the host passes workDir", () => {
    const line = "검증 재읽기 실패: C:\\Program Files (x86)\\Maru\\out";
    expect(withoutPaths(line)).toBe("검증 재읽기 실패: <path> Files (x86)\\Maru\\out");
    expect(withoutPaths(line, "C:\\Program Files (x86)\\Maru")).toBe("검증 재읽기 실패: <work dir>\\out");
  });

  // Exact Display text from agent-hwp v1.6.2 hwpx/src/error.rs and hwp5/src/error.rs.
  it.each([
    "엔트리가 없습니다: Contents/section0.xml",
    "HWPX 패키지 무결성 오류: manifest digest mismatch",
    "FileHeader 시그니처가 올바르지 않습니다",
    "FileHeader 크기가 올바르지 않습니다 (기대 256바이트, 실제 12바이트)",
    "스트림이 없습니다: BodyText/Section0",
  ])("gives a document-corruption head the file step: %s", (reason) => {
    expect(unclassifiedEditLine(`Error: ${reason}`)).toBe(`${reason}. ${UNCLASSIFIED_FILE_STEP}`);
  });

  it("adds no English step to staged_native_readback, which carries its own", () => {
    const reason = "staged_native_readback 실패: 게시 전 native 후보를 읽지 못했습니다. 출력을 게시하지 않았습니다. 출력 디렉터리의 읽기·쓰기 권한과 디스크 여유 공간을 확인한 뒤 다시 실행하세요";
    expect(unclassifiedEditLine(`Error: ${reason}`)).toBe(`${reason}.`);
  });
});

