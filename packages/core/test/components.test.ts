/**
 * Component library tests. The shipped starter set is the format's first real
 * user, so it is validated here: a typo in one of the seven JSON files has to
 * fail in this package rather than in a host's palette.
 *
 * The compose suite runs the real `hwp` binary and skips when none is
 * runnable, exactly like `packages/server/test/helpers.ts` — hosted CI
 * provisions no hwp (D-04), so a missing binary must read as "skipped", never
 * as a green compose.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it, afterAll } from "vitest";

import {
  componentStyleMap,
  documentSpecFromComponents,
  isComponentError,
  loadComponents,
  STARTER_COMPONENTS,
  substituteParams,
  validateComponent,
} from "../src/components.js";
import type {
  Component,
  ComponentFetch,
  ComponentFetchResponse,
  ComponentIndex,
} from "../src/components.js";
import {
  DOCUMENT_PROFILE_NAMES,
  DOCUMENT_PROFILES,
  OFFICIAL_BODY_PROFILE,
  OFFICIAL_PROFILE,
} from "../src/profiles.js";
import type { Blocks } from "../src/generated/document-spec-v2.js";

/** Which binary the real-binary suite runs against (mirrors the server's helper). */
const BIN =
  process.env.HWP_EDITOR_BIN?.trim() || process.env.HWP_CLI?.trim() || "hwp";

function runnable(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_BIN = BIN.includes(sep) ? existsSync(BIN) : runnable(BIN);

if (!HAS_BIN) {
  console.warn(
    `[hwp-editor/core tests] no runnable hwp binary at ${BIN} — the compose ` +
      "suite is skipped. Install hwp-cli, or set HWP_EDITOR_BIN / HWP_CLI.",
  );
}

const describeBin = HAS_BIN
  ? describe
  : (name: string, fn: () => void) =>
      describe.skip(`${name} [skipped: no runnable hwp binary at ${BIN}]`, fn);

const PROFILE_NAMES = ["바탕글", "개요 1", "개요 2", "개요 3", "개요 4", "개요 5", "개요 6"];

function textsOf(blocks: Blocks): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const run of block.runs) {
        if (run.type === "text") texts.push(run.text);
        if (run.type === "field" && run.value !== undefined) texts.push(run.value);
      }
    }
    if (block.type === "field" && block.value !== undefined) texts.push(block.value);
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (cell.blocks !== undefined) texts.push(...textsOf(cell.blocks));
        }
      }
    }
  }
  return texts;
}

function styleRefsOf(blocks: Blocks): string[] {
  const refs: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      if (block.style !== undefined) refs.push(block.style);
      for (const run of block.runs) {
        if ("style" in run && run.style !== undefined) refs.push(run.style);
      }
    }
    if (block.type === "field" && block.style !== undefined) refs.push(block.style);
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (cell.blocks !== undefined) refs.push(...styleRefsOf(cell.blocks));
        }
      }
    }
  }
  return refs;
}

function placeholdersIn(value: string): string[] {
  return Array.from(value.matchAll(/\{\{([^{}]*)\}\}/g), (match) => (match[1] ?? "").trim());
}

const starter = (name: string): Component => {
  const found = STARTER_COMPONENTS.find((component) => component.name === name);
  if (found === undefined) throw new Error(`no starter named ${name}`);
  return found;
};

const BASE_COMPONENT: Record<string, unknown> = {
  name: "시험",
  description: "시험용 구성요소",
  params: { 항목: "기본값" },
  blocks: [{ type: "paragraph", runs: [{ type: "text", text: "{{항목}}" }] }],
};

const REFUSAL_SOURCE = "src/components/broken.json";

describe("starter components", () => {
  it("ships the seven starters #54 names, in one stable order", () => {
    expect(STARTER_COMPONENTS.map((component) => component.name)).toEqual([
      "결재란",
      "붙임",
      "두문",
      "개조식",
      "결문",
      "일정표",
      "요약표",
    ]);
  });

  it("survives a validate round trip unchanged", () => {
    for (const component of STARTER_COMPONENTS) {
      expect(validateComponent(component, component.name)).toEqual(component);
    }
  });

  it("declares every placeholder it uses, and uses every param it declares", () => {
    for (const component of STARTER_COMPONENTS) {
      const used = new Set(
        textsOf(component.blocks).flatMap((value) => placeholdersIn(value)),
      );
      expect([...used].sort()).toEqual(Object.keys(component.params).sort());
      for (const value of Object.values(component.params)) expect(typeof value).toBe("string");
    }
  });

  it("names only official profile styles, and defines only what the profile lacks", () => {
    for (const component of STARTER_COMPONENTS) {
      for (const [name, style] of Object.entries(component.styles ?? {})) {
        expect({ name, defined: PROFILE_NAMES.includes(name) }).toEqual({
          name,
          defined: false,
        });
        expect(PROFILE_NAMES).toContain(style.based_on);
      }
      for (const ref of styleRefsOf(component.blocks)) {
        const own = Object.hasOwn(component.styles ?? {}, ref);
        expect({ ref, resolved: own || PROFILE_NAMES.includes(ref) }).toEqual({
          ref,
          resolved: true,
        });
      }
    }
  });

  it("keeps ordered lists out of the starters (hwp-cli#472)", () => {
    for (const component of STARTER_COMPONENTS) {
      expect(JSON.stringify(component.blocks)).not.toContain('"list":');
    }
  });

  it("opens the 결문 with the 발신명의 line, as the engine's own frame does", () => {
    // hwp-convert `frames.rs` writes 발신명의 first, centred and bold at 22pt,
    // then the 결재/협조/시행·접수/주소/연락처 rows.
    const gyeolmun = starter("결문");
    expect(gyeolmun.blocks[0]).toMatchObject({ type: "paragraph", style: "결문 발신명의" });
    expect(gyeolmun.blocks[1]).toMatchObject({ type: "table" });
    expect(gyeolmun.styles?.["결문 발신명의"]).toEqual({
      based_on: "바탕글",
      align: "center",
      bold: true,
      font_size_pt: 22,
    });
  });

  it("writes the 두문 rows the way the engine's own frame does", () => {
    // hwp-convert `frames.rs` DOC_HEAD is 기관명 / 수신 / 경유, written as
    // "수신  {v}" and "(경유)  {v}"; 문서번호 is not a 두문 row there.
    expect(textsOf(starter("두문").blocks)).toEqual([
      "{{기관명}}",
      "수신  {{수신}}",
      "(경유)  {{경유}}",
    ]);
  });

  it("gives 결재란 one date per approver, not one date shared by the row", () => {
    const approval = starter("결재란");
    expect(Object.keys(approval.params)).toEqual([
      "기안자",
      "검토자",
      "결재자",
      "기안일자",
      "검토일자",
      "결재일자",
    ]);
    expect(textsOf(approval.blocks)).toEqual([
      "기안",
      "검토",
      "결재",
      "{{기안자}}",
      "{{검토자}}",
      "{{결재자}}",
      "{{기안일자}}",
      "{{검토일자}}",
      "{{결재일자}}",
    ]);
  });
});

describe("substituteParams", () => {
  it("fills the defaults and leaves no placeholder behind", () => {
    for (const component of STARTER_COMPONENTS) {
      const filled = substituteParams(component);
      expect(filled.params).toEqual(component.params);
      expect(textsOf(filled.blocks).join("\n")).not.toContain("{{");
    }
  });

  it("applies an override over the default and reports the merged params", () => {
    const filled = substituteParams(starter("개조식"), {
      "표제": "추진 경과",
      "항목2": "세부 내용",
    });
    expect(textsOf(filled.blocks)).toEqual([
      "추진 경과",
      "□ 추진 배경",
      "○ 세부 내용",
      "- 기대 효과",
      "· 향후 계획",
    ]);
    expect(filled.params["표제"]).toBe("추진 경과");
    expect(filled.params["항목1"]).toBe("추진 배경");
  });

  it("leaves the component itself untouched", () => {
    const component = starter("붙임");
    const before = JSON.stringify(component);
    substituteParams(component, { "표제": "붙임 자료" });
    expect(JSON.stringify(component)).toBe(before);
  });

  it("inserts a value literally, never re-scanning it", () => {
    const filled = substituteParams(starter("개조식"), { "항목1": "{{항목2}}" });
    expect(textsOf(filled.blocks)[1]).toBe("□ {{항목2}}");
  });

  it("turns a line break in a value into line_break runs, keeping the run's format", () => {
    const component = validateComponent(
      {
        name: "줄바꿈",
        description: "줄바꿈 시험",
        params: { 값: "가" },
        blocks: [{ type: "paragraph", runs: [{ type: "text", text: "{{값}}", bold: true }] }],
      },
      "줄바꿈.json",
    );
    // A pasted `\r\n` from a palette textarea is one line break, and the
    // engine wants the run it asks for (`use line_break runs`), not a
    // control character inside the text.
    const filled = substituteParams(component, { "값": "첫 줄\r\n둘째 줄" });
    expect(filled.blocks[0]).toEqual({
      type: "paragraph",
      runs: [
        { type: "text", text: "첫 줄", bold: true },
        { type: "line_break" },
        { type: "text", text: "둘째 줄", bold: true },
      ],
    });
  });

  it("refuses a control character in a value, naming the component and the param", () => {
    expect(() => substituteParams(starter("결문"), { "주소": "제주시\u0007한라대학로" })).toThrow(
      "components: 결문: params.주소: holds the control character U+0007; " +
        "a param may hold a tab or a line break (which becomes a line_break run) and no other " +
        "control character; remove it, then retry",
    );
  });

  it("refuses a line break a field value would have to carry", () => {
    const component = validateComponent(
      {
        name: "필드",
        description: "필드 시험",
        params: { "제목": "기본" },
        blocks: [
          { type: "paragraph", runs: [{ type: "field", name: "머리말", value: "{{제목}}" }] },
        ],
      },
      "필드.json",
    );
    expect(() => substituteParams(component, { "제목": "가\n나" })).toThrow(
      "components: 필드: blocks[0].runs[0].value: substitutes {{제목}}, whose value holds a " +
        "line break, and document-spec-v1 allows no control character in a field value; " +
        "keep that param on one line, then retry",
    );
  });

  it("refuses a value for a param the component does not declare", () => {
    expect(() => substituteParams(starter("개조식"), { "없는항목": "값" })).toThrow(
      /components: 개조식: params\.없는항목: is not a param of this component/,
    );
  });

  it("substitutes inside table cells as well as paragraphs", () => {
    const filled = substituteParams(starter("요약표"), { "내용2": "2026. 3. ~ 2026. 6." });
    expect(textsOf(filled.blocks)).toContain("2026. 3. ~ 2026. 6.");
  });

  it("keeps an override named __proto__, which a plain assignment would drop", () => {
    // `filled["__proto__"] = value` sets the prototype instead of a property,
    // so the merged params are built with `Object.fromEntries`, not spread.
    const component = validateComponent(
      {
        name: "프로토",
        description: "프로토타입 시험",
        params: JSON.parse('{"__proto__":"기본"}') as Record<string, string>,
        blocks: [{ type: "paragraph", runs: [{ type: "text", text: "{{__proto__}}" }] }],
      },
      "프로토.json",
    );
    const filled = substituteParams(component, JSON.parse('{"__proto__":"값"}'));
    expect(filled.params["__proto__"]).toBe("값");
    expect(textsOf(filled.blocks)).toEqual(["값"]);
  });

  it("refuses a second pass over an already substituted component", () => {
    const filled = substituteParams(starter("개조식"), { "항목1": "직접 값" });
    expect(() => substituteParams(filled)).toThrow(
      "components: 개조식: is already substituted, and a second pass would re-scan text a value " +
        "was inserted into; fill the unfilled component, or compose this one as it is, then retry",
    );
  });
});

describe("validateComponent refusals", () => {
  const refusalFor = (patch: (value: Record<string, unknown>) => void): string => {
    const value = JSON.parse(JSON.stringify(BASE_COMPONENT)) as Record<string, unknown>;
    patch(value);
    try {
      validateComponent(value, REFUSAL_SOURCE);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected a refusal");
  };

  it("refuses an unknown key, naming the field and the file", () => {
    expect(refusalFor((value) => (value["lists"] = []))).toBe(
      "components: src/components/broken.json: lists: is not a field of this object",
    );
  });

  it("refuses a missing description", () => {
    expect(refusalFor((value) => delete value["description"])).toBe(
      "components: src/components/broken.json: description: must be a non-empty string",
    );
  });

  it("refuses a placeholder no param declares, naming the text field", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          { type: "paragraph", runs: [{ type: "text", text: "{{모름}}" }] },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].runs[0].text: " +
        "uses {{모름}}, which is not a declared param; add it to the component's params with a " +
        "default, or take it out of the text, then retry",
    );
  });

  it("refuses an empty placeholder", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [{ type: "paragraph", runs: [{ type: "text", text: "{{}}" }] }];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].runs[0].text: " +
        "has an empty {{}} placeholder; name the param it meant, or remove the braces, then retry",
    );
  });

  it("refuses a param name carrying braces", () => {
    expect(refusalFor((value) => (value["params"] = { "{{항목}}": "값" }))).toBe(
      "components: src/components/broken.json: params.{{항목}}: " +
        "must be a param name without braces or surrounding spaces",
    );
  });

  it("refuses a non-string default", () => {
    expect(refusalFor((value) => (value["params"] = { 항목: 1 }))).toBe(
      "components: src/components/broken.json: params.항목: must be a string",
    );
  });

  it("refuses a colour outside #RRGGBB", () => {
    expect(
      refusalFor((value) => {
        value["styles"] = { 강조: { based_on: "바탕글", color: "#12345" } };
      }),
    ).toBe(
      "components: src/components/broken.json: styles.강조.color: must be a #RRGGBB colour",
    );
  });

  it("refuses a line height outside the schema range", () => {
    expect(
      refusalFor((value) => {
        value["styles"] = { 강조: { line_height_percent: 49 } };
      }),
    ).toBe(
      "components: src/components/broken.json: styles.강조.line_height_percent: " +
        "must be an integer between 50 and 1000",
    );
  });

  it("refuses a table with no columns", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          {
            type: "table",
            columns: [],
            rows: [{ cells: [{ blocks: [{ type: "paragraph", runs: [{ type: "text", text: "값" }] }] }] }],
          },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].columns: " +
        "must be an array of at least 1 column",
    );
  });

  it("refuses a block type outside the v1 set", () => {
    expect(refusalFor((value) => (value["blocks"] = [{ type: "heading" }]))).toBe(
      "components: src/components/broken.json: blocks[0].type: " +
        "must be one of paragraph, table, image, equation, field, break",
    );
  });

  it("refuses an empty block list", () => {
    expect(refusalFor((value) => (value["blocks"] = []))).toBe(
      "components: src/components/broken.json: blocks: must be an array of at least 1 block",
    );
  });

  it("accepts a 128-character style name and refuses 129", () => {
    const name = "가".repeat(128);
    expect(
      validateComponent(
        {
          ...BASE_COMPONENT,
          styles: { [name]: { based_on: "바탕글" } },
          blocks: [{ type: "paragraph", style: name, runs: [{ type: "text", text: "값" }] }],
        },
        REFUSAL_SOURCE,
      ).styles,
    ).toEqual({ [name]: { based_on: "바탕글" } });
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          {
            type: "paragraph",
            style: "가".repeat(129),
            runs: [{ type: "text", text: "값" }],
          },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].style: " +
        "must be at most 128 characters, as document-spec-v1 allows",
    );
  });

  it("refuses a font family, field value and image path past their bounds", () => {
    expect(
      refusalFor((value) => {
        value["styles"] = { 강조: { font_family: "가".repeat(257) } };
      }),
    ).toBe(
      "components: src/components/broken.json: styles.강조.font_family: " +
        "must be at most 256 characters, as document-spec-v1 allows",
    );
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          {
            type: "paragraph",
            runs: [{ type: "field", name: "제목", value: "가".repeat(4097) }],
          },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].runs[0].value: " +
        "must be at most 4096 characters, as document-spec-v1 allows",
    );
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          { type: "image", path: `사진/${"가".repeat(4096)}.png`, width_mm: 10 },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].path: " +
        "must be at most 4096 characters, as document-spec-v1 allows",
    );
  });

  it("accepts a 2,000,000-character run and refuses one character more", () => {
    const text = "가".repeat(2_000_000);
    expect(
      textsOf(
        validateComponent(
          {
            ...BASE_COMPONENT,
            blocks: [{ type: "paragraph", runs: [{ type: "text", text }] }],
          },
          REFUSAL_SOURCE,
        ).blocks,
      ),
    ).toEqual([text]);
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          { type: "paragraph", runs: [{ type: "text", text: `${text}가` }] },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].runs[0].text: " +
        "must be at most 2000000 characters, as document-spec-v1 allows",
    );
  });

  it("refuses a table with more rows than the schema allows", () => {
    const cell = {
      cells: [{ blocks: [{ type: "paragraph", runs: [{ type: "text", text: "값" }] }] }],
    };
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          {
            type: "table",
            columns: [{ width_mm: 10 }],
            rows: Array.from({ length: 65_536 }, () => cell),
          },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].rows: " +
        "must be at most 65535 rows, as document-spec-v1 allows",
    );
  });

  it("refuses a paragraph list, which no component can reference", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          {
            type: "paragraph",
            list: { name: "개요", level: 1 },
            runs: [{ type: "text", text: "값" }],
          },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].list: is not supported: a component's " +
        "blocks are inserted into a document whose lists it cannot know, so hwp compose refuses " +
        "the reference; write the markers into the text runs instead (HWP 5.0 ordered lists " +
        "also show Hangul numbering, hwp-cli#472)",
    );
  });

  it("refuses a control character in a component's own text", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          { type: "paragraph", runs: [{ type: "text", text: "가\u0001나" }] },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].runs[0].text: holds the control " +
        "character U+0001; document-spec-v1 allows a tab and no other control character here; " +
        "split the text into separate runs with a line_break run between them, then retry",
    );
    // A newline is the same refusal: text is one line, a break is a run.
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          { type: "paragraph", runs: [{ type: "text", text: "가\n나" }] },
        ];
      }),
    ).toContain("blocks[0].runs[0].text: holds the control character U+000A");
  });

  it("refuses a placeholder substitution would not fill", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [{ type: "image", path: "사진/{{항목}}.png", width_mm: 10 }];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].path: is not substituted, so " +
        "{{항목}} would reach the engine as literal braces; move the placeholder into a text " +
        "run or a field value, then retry",
    );
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          { type: "paragraph", runs: [{ type: "field", name: "{{항목}}" }] },
        ];
      }),
    ).toContain("blocks[0].runs[0].name: is not substituted");
    expect(
      refusalFor((value) => {
        value["blocks"] = [{ type: "equation", script: "{{항목}}" }];
      }),
    ).toContain("blocks[0].script: is not substituted");
  });

  it("accepts 256 styles and refuses 257", () => {
    const styles = (count: number): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`강조 ${index}`, { based_on: "바탕글" }]),
      );
    expect(
      Object.keys(
        validateComponent({ ...BASE_COMPONENT, styles: styles(256) }, REFUSAL_SOURCE).styles ?? {},
      ),
    ).toHaveLength(256);
    expect(refusalFor((value) => (value["styles"] = styles(257)))).toBe(
      "components: src/components/broken.json: styles: must hold at most 256 styles, " +
        "as document-spec-v1 allows",
    );
  });

  const paragraphOf = (text: string): Record<string, unknown> => ({
    type: "paragraph",
    runs: [{ type: "text", text }],
  });
  const cellOf = (text: string, span: Record<string, number> = {}): Record<string, unknown> => ({
    ...span,
    blocks: [paragraphOf(text)],
  });
  const gridOf = (rows: Record<string, unknown>[][]): Record<string, unknown> => ({
    type: "table",
    width_mm: 90,
    columns: [{ width_mm: 30 }, { width_mm: 30 }, { width_mm: 30 }],
    rows: rows.map((cells) => ({ cells })),
  });

  it("accepts a table whose spans tile the grid", () => {
    const blocks = [
      gridOf([
        [cellOf("가", { col_span: 2 }), cellOf("나")],
        [cellOf("다"), cellOf("라"), cellOf("마")],
      ]),
      gridOf([
        [cellOf("가", { row_span: 2 }), cellOf("나"), cellOf("다")],
        [cellOf("라"), cellOf("마")],
      ]),
    ];
    expect(validateComponent({ ...BASE_COMPONENT, blocks }, REFUSAL_SOURCE).blocks).toHaveLength(2);
  });

  it("refuses a table row that leaves a column empty", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          gridOf([[cellOf("가"), cellOf("나"), cellOf("다")], [cellOf("라")]]),
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].rows[1]: leaves column 2 of the " +
        "3-column grid empty; every row has to cover every column (a col_span may be wider), " +
        "then retry",
    );
  });

  it("refuses a span that leaves the table grid", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [gridOf([[cellOf("가", { col_span: 4 })]])];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].rows[0].cells[0]: spans 4 column(s) " +
        "from column 1 and 1 row(s) from row 1, past the table's 3 column(s) and 1 row(s); " +
        "shrink the span so the cells tile the grid, then retry",
    );
  });

  it("refuses a cell that overlaps the row span above it", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          gridOf([
            [cellOf("가"), cellOf("나", { row_span: 2 }), cellOf("다")],
            [cellOf("라", { col_span: 2 }), cellOf("마")],
          ]),
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].rows[1].cells[0]: overlaps a cell an " +
        "earlier row span already covers (row 2, column 2); give the overlapping cell its own " +
        "slot, then retry",
    );
  });

  it("refuses a table grid past the cell count hwp compose allows", () => {
    // 65535 by 65535 passes both schema axis bounds and would ask the engine
    // for 4.3 billion slots (`document_spec.rs` MAX_TABLE_CELLS), so the
    // refusal has to come from the product, before any grid is allocated.
    const grid = (rows: number, columns: number): Record<string, unknown> => ({
      type: "table",
      columns: Array.from({ length: columns }, () => ({ width_mm: 10 })),
      rows: Array.from({ length: rows }, () => ({
        cells: Array.from({ length: columns }, () => ({ blocks: [] })),
      })),
    });
    expect(refusalFor((value) => (value["blocks"] = [grid(1001, 101)]))).toBe(
      "components: src/components/broken.json: blocks[0]: is a 1001-row by 101-column table, " +
        "101101 cells; hwp compose allows 100000 cells in one table grid; split the table into " +
        "several, or shrink it, then retry",
    );
    // One row under the cap still validates, so the refusal is the product and
    // not a blanket table size limit.
    expect(
      validateComponent({ ...BASE_COMPONENT, blocks: [grid(990, 101)] }, REFUSAL_SOURCE).blocks,
    ).toHaveLength(1);
  });

  it("keeps a param named like an Object.prototype member", () => {
    const component = validateComponent(
      {
        name: "시험",
        description: "시험용 구성요소",
        params: { constructor: "기본값", toString: "다른 값" },
        blocks: [
          { type: "paragraph", runs: [{ type: "text", text: "{{constructor}}" }] },
          { type: "paragraph", runs: [{ type: "text", text: "{{toString}}" }] },
        ],
      },
      REFUSAL_SOURCE,
    );
    expect(Object.keys(component.params)).toEqual(["constructor", "toString"]);
    expect(textsOf(substituteParams(component).blocks)).toEqual(["기본값", "다른 값"]);
  });
});

describe("documentSpecFromComponents", () => {
  it("wraps the filled blocks in the v2 envelope, in list order", () => {
    const spec = documentSpecFromComponents(STARTER_COMPONENTS, { title: "시험 문서" });
    expect(spec.version).toBe("2.0");
    expect(spec.document.version).toBe("1.0");
    expect(spec.document.metadata).toEqual({ title: "시험 문서" });
    expect(spec.document.sections).toHaveLength(1);
    const blocks = spec.document.sections[0].blocks;
    // Composition owns substitution, so the blocks are the starters' own
    // defaults filled, not the `{{param}}` templates they ship with.
    const filled = STARTER_COMPONENTS.map((component) => substituteParams(component));
    expect(blocks).toEqual(filled.flatMap((component) => component.blocks));
    expect(blocks).toHaveLength(
      STARTER_COMPONENTS.reduce((count, component) => count + component.blocks.length, 0),
    );
    expect(JSON.stringify(blocks)).not.toContain("{{");
  });

  it("carries the profile styles the components name, and nothing else", () => {
    const spec = documentSpecFromComponents([starter("개조식")]);
    expect(Object.keys(spec.document.styles ?? {})).toEqual(["바탕글", "개요 2"]);
    expect(spec.document.styles?.["개요 2"]).toEqual(OFFICIAL_PROFILE["개요 2"]);
  });

  it("adds a component's own style next to the profile one it derives from", () => {
    const spec = documentSpecFromComponents([starter("두문")]);
    const styles = spec.document.styles ?? {};
    expect(Object.keys(styles)).toEqual(["바탕글", "개요 3", "두문 기관명"]);
    expect(styles["두문 기관명"]).toEqual(starter("두문").styles?.["두문 기관명"]);
  });

  it("refuses an empty component list", () => {
    expect(() => documentSpecFromComponents([])).toThrow(
      /components: at least one component is needed to compose a document/,
    );
  });

  it("fills each entry once, from its own values, its defaults, or as it stands", () => {
    const spec = documentSpecFromComponents([
      { component: starter("개조식"), values: { "표제": "추진 경과" } },
      substituteParams(starter("붙임"), { "표제": "붙임 자료" }),
    ]);
    const texts = textsOf(spec.document.sections[0].blocks);
    expect(texts[0]).toBe("추진 경과");
    expect(texts).toContain("붙임 자료");
    // A second pass would re-scan text a value was inserted into, so `substituteParams`
    // refuses one and composition has to accept an already filled component.
    expect(texts.join("\n")).not.toContain("{{");
  });

  it("refuses to redefine an official profile style, and accepts the same values", () => {
    // Refused at validation, so the message carries the component's own file
    // rather than its `name`; `componentStyleMap` never sees such a component.
    expect(() => validateComponent(
      { ...BASE_COMPONENT, styles: { "바탕글": { bold: true } } },
      REFUSAL_SOURCE,
    )).toThrow(
      "components: src/components/broken.json: styles.바탕글: redefines the official profile's 바탕글, " +
        "and a component takes profile values from the table rather than replacing them (#54 " +
        "Decision 2026-11-10); define your style under its own name with based_on 바탕글, then retry",
    );
    const restating = validateComponent(
      { ...BASE_COMPONENT, styles: { "바탕글": { ...OFFICIAL_PROFILE["바탕글"] } } },
      REFUSAL_SOURCE,
    );
    expect(documentSpecFromComponents([restating]).document.styles?.["바탕글"]).toEqual(
      OFFICIAL_PROFILE["바탕글"],
    );
  });

  it("returns blocks and styles that share no state with the starters or the profile", () => {
    // A host that edits the spec it gets back must not reach module state (the
    // profile table, the starter set) or another caller's file.
    const spec = documentSpecFromComponents([starter("개조식")]);
    const blocks = spec.document.sections[0]?.blocks as unknown as Record<string, unknown>[];
    blocks[0]!["style"] = "바뀜";
    expect((starter("개조식").blocks[0] as { style?: string }).style).toBe("개요 2");
    const style = spec.document.styles?.["개요 2"];
    if (style === undefined) throw new Error("개요 2 is missing from the spec");
    style.font_size_pt = 99;
    expect(OFFICIAL_PROFILE["개요 2"]?.font_size_pt).toBe(14);
  });

  it("validates a component into copies, not into the caller's objects", () => {
    const raw: Record<string, unknown> = {
      ...BASE_COMPONENT,
      styles: { 강조: { based_on: "바탕글" } },
    };
    const component = validateComponent(raw, "시험");
    (component.blocks[0] as unknown as Record<string, unknown[]>)["runs"] = [];
    expect((raw["blocks"] as Record<string, unknown>[])[0]).toEqual({
      type: "paragraph",
      runs: [{ type: "text", text: "{{항목}}" }],
    });
    const style = component.styles?.["강조"];
    if (style === undefined) throw new Error("강조 is missing");
    style.bold = true;
    expect((raw["styles"] as Record<string, unknown>)["강조"]).toEqual({ based_on: "바탕글" });
  });

  it("refuses one style name defined two different ways", () => {
    const first = validateComponent(
      {
        ...BASE_COMPONENT,
        name: "첫째",
        styles: { 같은: { based_on: "바탕글", bold: true } },
        blocks: [{ type: "paragraph", style: "같은", runs: [{ type: "text", text: "가" }] }],
      },
      "첫째",
    );
    const second = validateComponent(
      {
        ...BASE_COMPONENT,
        name: "둘째",
        styles: { 같은: { based_on: "바탕글", bold: false } },
        blocks: [{ type: "paragraph", style: "같은", runs: [{ type: "text", text: "나" }] }],
      },
      "둘째",
    );
    expect(() => documentSpecFromComponents([first, second])).toThrow(
      "components: 둘째: styles.같은: is defined differently by 첫째 and this component; " +
        "make the two definitions agree, or rename one of them, then retry",
    );
  });

  it("accepts one style name whose properties are spelled in a different order", () => {
    const first = validateComponent(
      {
        ...BASE_COMPONENT,
        name: "첫째",
        styles: { 같은: { based_on: "바탕글", bold: true, italic: true } },
        blocks: [{ type: "paragraph", style: "같은", runs: [{ type: "text", text: "가" }] }],
      },
      "첫째",
    );
    const second = validateComponent(
      {
        ...BASE_COMPONENT,
        name: "둘째",
        styles: { 같은: { italic: true, bold: true, based_on: "바탕글" } },
        blocks: [{ type: "paragraph", style: "같은", runs: [{ type: "text", text: "나" }] }],
      },
      "둘째",
    );
    const spec = documentSpecFromComponents([first, second]);
    expect(spec.document.styles?.["같은"]).toEqual({
      based_on: "바탕글",
      bold: true,
      italic: true,
    });
  });

  it("keeps a style named like an Object.prototype member", () => {
    const component = validateComponent(
      {
        ...BASE_COMPONENT,
        styles: { constructor: { based_on: "바탕글", bold: true } },
        blocks: [
          { type: "paragraph", style: "constructor", runs: [{ type: "text", text: "가" }] },
        ],
      },
      "시험",
    );
    const styles = documentSpecFromComponents([component]).document.styles ?? {};
    expect(Object.keys(styles)).toEqual(["바탕글", "constructor"]);
    expect(styles["constructor"]).toEqual({ based_on: "바탕글", bold: true });
  });

  it("refuses a style reference named like an Object.prototype member", () => {
    const component = validateComponent(
      {
        ...BASE_COMPONENT,
        styles: { 정의됨: { based_on: "바탕글" } },
        blocks: [{ type: "paragraph", style: "toString", runs: [{ type: "text", text: "가" }] }],
      },
      "시험",
    );
    expect(() => documentSpecFromComponents([component])).toThrow(
      /components: 시험: blocks\[0\]\.style: references style toString, which no component defines/,
    );
  });

  it("refuses a style reference neither a component nor the profile supplies", () => {
    const component = validateComponent(
      {
        ...BASE_COMPONENT,
        styles: { 없음: { based_on: "없는 바탕" } },
        blocks: [{ type: "paragraph", style: "없음", runs: [{ type: "text", text: "가" }] }],
      },
      "시험",
    );
    expect(() => documentSpecFromComponents([component])).toThrow(
      /components: 시험: styles\.없음\.based_on: references style 없는 바탕, which no component defines/,
    );
  });

  it("carries the missing style's name beside the block path that named it", () => {
    // The field is the block path, which does not spell the name it failed on,
    // so the name travels as `value` and a localized sentence can print it
    // without parsing the reason.
    const component = validateComponent(
      {
        ...BASE_COMPONENT,
        blocks: [{ type: "paragraph", style: "결재란 셀", runs: [{ type: "text", text: "가" }] }],
      },
      "시험",
    );
    let refusal: unknown;
    try {
      documentSpecFromComponents([component]);
    } catch (error) {
      refusal = error;
    }
    expect(isComponentError(refusal)).toBe(true);
    if (!isComponentError(refusal)) throw refusal;
    expect(refusal.code).toBe("component_style");
    expect(refusal.field).toBe("blocks[0].style");
    expect(refusal.value).toBe("결재란 셀");
  });
});

describe("loadComponents", () => {
  const respond = (body: string, status = 200): ComponentFetchResponse => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });

  const shipped = (file: string): string =>
    readFileSync(join(import.meta.dirname, "..", "src", "components", file), "utf8");

  it("loads a folder index over an injected transport, resolving entries against it", async () => {
    const requested: string[] = [];
    const transport: ComponentFetch = async (url) => {
      requested.push(url);
      if (url === "https://example.test/lib/index.json") {
        return respond(
          JSON.stringify({
            version: "1.0",
            components: ["dumo.json", { path: "gaejosik.json" }],
          }),
        );
      }
      return respond(shipped(url.slice(url.lastIndexOf("/") + 1)));
    };
    const loaded = await loadComponents("https://example.test/lib/index.json", {
      fetch: transport,
    });
    expect(loaded.map((component) => component.name)).toEqual(["두문", "개조식"]);
    expect(requested).toEqual([
      "https://example.test/lib/index.json",
      "https://example.test/lib/dumo.json",
      "https://example.test/lib/gaejosik.json",
    ]);
  });

  it("loads an index object whose entries are the components themselves", async () => {
    const loaded = await loadComponents({
      version: "1.0",
      components: [starter("붙임"), starter("결재란")],
    });
    expect(loaded.map((component) => component.name)).toEqual(["붙임", "결재란"]);
  });

  it("accepts component objects passed straight in", async () => {
    const loaded = await loadComponents([...STARTER_COMPONENTS]);
    expect(loaded).toEqual([...STARTER_COMPONENTS]);
  });

  it("refuses two entries that carry one name", async () => {
    await expect(
      loadComponents({ version: "1.0", components: [starter("붙임"), starter("붙임")] }),
    ).rejects.toThrow(
      "components: component index: components[1]: loads a second component named 붙임, " +
        "which was already loaded from component index components[0]; " +
        "rename one of the two, then retry",
    );
  });

  it("refuses an inline entry that is not a component, naming the entry and the field", async () => {
    await expect(
      loadComponents({ version: "1.0", components: [{} as unknown as Component] }),
    ).rejects.toThrow(
      /components: component index components\[0\]: name: must be a non-empty string/,
    );
    await expect(
      loadComponents(
        {
          version: "1.0",
          components: [{ path: "dumo.json", name: "두문" } as unknown as { path: string }],
        },
        { baseUrl: "https://example.test/lib/" },
      ),
    ).rejects.toThrow(
      /components: component index: components\[0\]\.name: is not a field of this object/,
    );
  });

  it("refuses an index that is not version 1.0", async () => {
    await expect(
      loadComponents({ version: "2.0", components: [] } as unknown as ComponentIndex),
    ).rejects.toThrow(/components: component index: version: must be "1.0"/);
  });

  it("refuses a relative entry with no baseUrl, naming the entry", async () => {
    await expect(
      loadComponents({ version: "1.0", components: ["dumo.json"] }),
    ).rejects.toThrow(
      /components: component index: components\[0\]: is a relative path, and no baseUrl was given to resolve it/,
    );
  });

  it("resolves a relative entry against a baseUrl", async () => {
    const requested: string[] = [];
    const loaded = await loadComponents(
      { version: "1.0", components: ["dumo.json"] },
      {
        baseUrl: "https://example.test/lib/",
        fetch: async (url) => {
          requested.push(url);
          return respond(shipped("dumo.json"));
        },
      },
    );
    expect(requested).toEqual(["https://example.test/lib/dumo.json"]);
    expect(loaded[0]?.name).toBe("두문");
  });

  it("resolves a relative index URL against the baseUrl, then its entries against it", async () => {
    const requested: string[] = [];
    const loaded = await loadComponents("/lib/index.json", {
      baseUrl: "https://example.test/docs/page.html",
      fetch: async (url) => {
        requested.push(url);
        if (url === "https://example.test/lib/index.json") {
          return respond(JSON.stringify({ version: "1.0", components: ["dumo.json"] }));
        }
        return respond(shipped(url.slice(url.lastIndexOf("/") + 1)));
      },
    });
    expect(requested).toEqual([
      "https://example.test/lib/index.json",
      "https://example.test/lib/dumo.json",
    ]);
    expect(loaded[0]?.name).toBe("두문");
  });

  it("resolves a relative index URL against the document URL in a browser", async () => {
    const requested: string[] = [];
    const browser = globalThis as { location?: { href: string } };
    browser.location = { href: "https://example.test/app/index.html" };
    try {
      const loaded = await loadComponents("/lib/index.json", {
        fetch: async (url) => {
          requested.push(url);
          if (url === "https://example.test/lib/index.json") {
            return respond(JSON.stringify({ version: "1.0", components: ["dumo.json"] }));
          }
          return respond(shipped("dumo.json"));
        },
      });
      expect(loaded[0]?.name).toBe("두문");
    } finally {
      delete browser.location;
    }
    expect(requested).toEqual([
      "https://example.test/lib/index.json",
      "https://example.test/lib/dumo.json",
    ]);
  });

  it("makes a relative baseUrl absolute against the document URL before using it", async () => {
    // `new URL(entry, "/lib/")` throws, so a browser passing the folder as
    // "/lib/" would lose every entry: the base is resolved first.
    const requested: string[] = [];
    const browser = globalThis as { location?: { href: string } };
    browser.location = { href: "https://example.test/app/index.html" };
    try {
      const loaded = await loadComponents(
        { version: "1.0", components: ["dumo.json"] },
        {
          baseUrl: "/lib/",
          fetch: async (url) => {
            requested.push(url);
            return respond(shipped("dumo.json"));
          },
        },
      );
      expect(loaded[0]?.name).toBe("두문");
    } finally {
      delete browser.location;
    }
    expect(requested).toEqual(["https://example.test/lib/dumo.json"]);
  });

  it("refuses a transport that rejects, naming the URL and the failure", async () => {
    await expect(
      loadComponents("https://example.test/lib/index.json", {
        fetch: async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:1");
        },
      }),
    ).rejects.toThrow(
      /components: https:\/\/example\.test\/lib\/index\.json: could not be loaded \(ECONNREFUSED/,
    );
  });

  it("keeps a cancelled load a cancellation, not a failed library", async () => {
    const cancelled = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    const transport: ComponentFetch = async () => {
      throw cancelled;
    };
    await expect(
      loadComponents("https://example.test/lib/index.json", { fetch: transport }),
    ).rejects.toBe(cancelled);
  });

  it("refuses an entry it cannot resolve against the baseUrl, naming the base", async () => {
    await expect(
      loadComponents({ version: "1.0", components: ["dumo.json"] }, { baseUrl: "not a url" }),
    ).rejects.toThrow(
      /components: component index: components\[0\]: cannot be resolved against not a url; pass LoadComponentsOptions\.baseUrl/,
    );
  });

  it("refuses a failed fetch, naming the URL and the status", async () => {
    await expect(
      loadComponents("https://example.test/missing.json", {
        fetch: async () => respond("", 404),
      }),
    ).rejects.toThrow(
      /components: https:\/\/example\.test\/missing\.json: could not be loaded \(HTTP 404\)/,
    );
  });

  it("refuses a body that is not JSON, naming the URL", async () => {
    await expect(
      loadComponents("https://example.test/bad.json", {
        fetch: async () => respond("{"),
      }),
    ).rejects.toThrow(/components: https:\/\/example\.test\/bad\.json: is not valid JSON/);
  });

  it("names the component URL when a fetched component fails validation", async () => {
    const transport: ComponentFetch = async (url) => {
      if (url === "https://example.test/lib/index.json") {
        return respond(JSON.stringify({ version: "1.0", components: ["bad.json"] }));
      }
      return respond(
        JSON.stringify({
          ...BASE_COMPONENT,
          blocks: [{ type: "paragraph", runs: [{ type: "text", text: "{{모름}}" }] }],
        }),
      );
    };
    await expect(
      loadComponents("https://example.test/lib/index.json", { fetch: transport }),
    ).rejects.toThrow(
      /components: https:\/\/example\.test\/lib\/bad\.json: blocks\[0\]\.runs\[0\]\.text: /,
    );
  });
});

describe("package surface", () => {
  it("re-exports the component library and the profile table from the index", async () => {
    const index = await import("../src/index.js");
    expect(index.STARTER_COMPONENTS).toBe(STARTER_COMPONENTS);
    expect(index.OFFICIAL_PROFILE).toBe(OFFICIAL_PROFILE);
    expect(index.OFFICIAL_BODY_PROFILE).toBe(OFFICIAL_BODY_PROFILE);
    expect(index.DOCUMENT_PROFILES).toBe(DOCUMENT_PROFILES);
    expect(index.DOCUMENT_PROFILE_NAMES).toBe(DOCUMENT_PROFILE_NAMES);
    expect(typeof index.validateComponent).toBe("function");
    expect(typeof index.substituteParams).toBe("function");
    expect(typeof index.documentSpecFromComponents).toBe("function");
    expect(typeof index.loadComponents).toBe("function");
  });
});

describe("profile table", () => {
  it("gives 바탕글 no paragraph spacing and the outlines 6pt before and 3pt after", () => {
    // Compose starts a style from its own default paragraph shape, which
    // carries 6pt after, so the official values have to be written out.
    expect(OFFICIAL_PROFILE["바탕글"]).toMatchObject({
      spacing_before_pt: 0,
      spacing_after_pt: 0,
    });
    for (const name of PROFILE_NAMES.slice(1)) {
      expect({
        name,
        spacing: [OFFICIAL_PROFILE[name]?.spacing_before_pt, OFFICIAL_PROFILE[name]?.spacing_after_pt],
      }).toEqual({ name, spacing: [6, 3] });
    }
  });

  it("offers a row per preset, with the official row derived from one body profile", () => {
    expect(DOCUMENT_PROFILE_NAMES).toHaveLength(7);
    expect(Object.keys(DOCUMENT_PROFILES).sort()).toEqual([...DOCUMENT_PROFILE_NAMES].sort());
    expect(DOCUMENT_PROFILES.official).toEqual({
      fontFamily: OFFICIAL_BODY_PROFILE.fontFamily,
      bodySizePt: OFFICIAL_BODY_PROFILE.fontSizePt,
      lineHeightPercent: OFFICIAL_BODY_PROFILE.lineHeightPercent,
      pageNumber: false,
    });
  });

  it("freezes the tables and the starter set a host shares, so an edit throws", () => {
    // Module state every caller shares: an edit has to throw here rather than
    // reach the next document a host composes.
    for (const value of [
      OFFICIAL_PROFILE,
      OFFICIAL_PROFILE["바탕글"],
      OFFICIAL_BODY_PROFILE,
      DOCUMENT_PROFILES,
      DOCUMENT_PROFILES.report,
      DOCUMENT_PROFILE_NAMES,
      STARTER_COMPONENTS,
      STARTER_COMPONENTS[0],
      STARTER_COMPONENTS[0]?.blocks,
      STARTER_COMPONENTS[0]?.styles,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      (OFFICIAL_PROFILE["바탕글"] as unknown as Record<string, unknown>)["font_size_pt"] = 99;
    }).toThrow(TypeError);
    expect(() => {
      (STARTER_COMPONENTS[0] as unknown as Record<string, unknown>)["name"] = "다른 이름";
    }).toThrow(TypeError);
    expect(OFFICIAL_PROFILE["바탕글"]?.font_size_pt).toBe(12);
    expect(STARTER_COMPONENTS[0]?.name).toBe("결재란");
  });
});

describeBin("compose with the real hwp", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwp-components-"));
  const out = (name: string) => join(dir, name);

  const compose = (spec: unknown, name: string): Record<string, unknown> => {
    const specPath = out(`${name}.spec.json`);
    const docPath = out(`${name}.hwpx`);
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const stdout = execFileSync(BIN, ["compose", specPath, "-o", docPath, "--report"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The binary prints a one-line human summary before the JSON report.
    return JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;
  };

  const markdown = (name: string): string =>
    execFileSync(BIN, ["cat", out(`${name}.hwpx`), "--format", "markdown"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("reproduces the official profile from OFFICIAL_PROFILE", () => {
    const preset = out("preset.hwpx");
    execFileSync(BIN, ["new", "-o", preset, "--preset", "official"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // `hwp styles` resolves each named style to the attributes the document
    // holds; english_name and face_ids are per-file bookkeeping (a composed
    // file names and registers its own faces), so the comparison keeps the
    // attributes the profile is actually made of.
    const profileOf = (file: string): Record<string, Record<string, unknown>> => {
      const stdout = execFileSync(BIN, ["styles", file, "--format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(stdout) as {
        styles: {
          name: string;
          attrs: {
            char: { bold: boolean; color: string; faces: string[]; italic: boolean; size_pt: number };
            para: { alignment: string; line_spacing: number; indent: number };
          };
        }[];
      };
      return Object.fromEntries(
        parsed.styles.map((style) => [
          style.name,
          {
            face: style.attrs.char.faces[0],
            size_pt: style.attrs.char.size_pt,
            bold: style.attrs.char.bold,
            italic: style.attrs.char.italic,
            color: style.attrs.char.color,
            align: style.attrs.para.alignment,
            line_spacing: style.attrs.para.line_spacing,
            indent: style.attrs.para.indent,
          },
        ]),
      );
    };
    // Paragraph spacing is the one profile attribute `hwp styles` does not
    // publish, so it is read where both documents keep it: the `paraPr`
    // margins in the package's own header, reached through `hwp dump`. Both
    // files go through the same writer, so the units compare directly.
    const spacingOf = (file: string): Record<string, Record<string, number>> => {
      const xml = execFileSync(BIN, ["dump", file, "--stream", "Contents/header.xml"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const shapes = new Map<string, Record<string, number>>();
      for (const match of xml.matchAll(/<hh:paraPr id="(\d+)"[\s\S]*?<\/hh:paraPr>/g)) {
        shapes.set(
          match[1] as string,
          Object.fromEntries(
            Array.from(match[0].matchAll(/<hc:(\w+) value="(-?\d+)"/g), (margin) => [
              margin[1] as string,
              Number(margin[2]),
            ]),
          ),
        );
      }
      const byStyle: Record<string, Record<string, number>> = {};
      for (const match of xml.matchAll(
        /<hh:style id="\d+"[^>]*name="([^"]+)"[^>]*paraPrIDRef="(\d+)"/g,
      )) {
        const shape = shapes.get(match[2] as string);
        if (shape !== undefined) byStyle[match[1] as string] = shape;
      }
      return byStyle;
    };
    compose(
      documentSpecFromComponents([
        validateComponent(
          {
            name: "프로필",
            description: "프로필 대조용",
            params: {},
            styles: OFFICIAL_PROFILE,
            blocks: PROFILE_NAMES.map((name) => ({
              type: "paragraph",
              style: name,
              runs: [{ type: "text", text: name }],
            })),
          },
          "profile",
        ),
      ]),
      "profile",
    );
    expect(profileOf(out("profile.hwpx"))).toEqual(profileOf(preset));
    expect(spacingOf(out("profile.hwpx"))).toEqual(spacingOf(preset));
  });

  it("matches the body row of every preset the engine publishes", () => {
    // `gaejosik` is this repo's own preset: the engine has no such profile, so
    // there is nothing to compare it with.
    for (const name of DOCUMENT_PROFILE_NAMES) {
      if (name === "gaejosik") continue;
      const row = out(`row-${name}.hwpx`);
      execFileSync(BIN, ["new", "-o", row, "--preset", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = execFileSync(BIN, ["styles", row, "--format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(stdout) as {
        styles: {
          name: string;
          attrs: {
            char: { faces: string[]; size_pt: number };
            para: { line_spacing: number };
          };
        }[];
      };
      const body = parsed.styles.find((style) => style.name === "바탕글");
      if (body === undefined) throw new Error(`${name} has no 바탕글 style`);
      const section = execFileSync(BIN, ["dump", row, "--stream", "Contents/section0.xml"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect({ name, row: DOCUMENT_PROFILES[name] }).toEqual({
        name,
        row: {
          fontFamily: body.attrs.char.faces[0],
          bodySizePt: body.attrs.char.size_pt,
          lineHeightPercent: body.attrs.para.line_spacing,
          pageNumber: section.includes("<hp:pageNum "),
        },
      });
    }
  });

  it("composes each starter on its own, with no warning", () => {
    STARTER_COMPONENTS.forEach((component, index) => {
      const report = compose(
        documentSpecFromComponents([component], { title: component.name }),
        `starter-${index}`,
      );
      expect({ name: component.name, warnings: report["warnings"] }).toEqual({
        name: component.name,
        warnings: [],
      });
      expect(readFileSync(out(`starter-${index}.hwpx`)).subarray(0, 2).toString("latin1")).toBe(
        "PK",
      );
    });
  });

  const runAttrs = (name: string): { face: string | undefined; size: number | undefined }[] => {
    const stdout = execFileSync(
      BIN,
      ["cat", out(`${name}.hwpx`), "--with-segments", "--segments", "v2", "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(stdout) as {
      segments: { kind: string; style: { char: { faces: string[]; size_pt: number } } }[];
    };
    return parsed.segments
      .filter((segment) => segment.kind === "run")
      .map((segment) => ({
        face: segment.style.char.faces[0],
        size: segment.style.char.size_pt,
      }));
  };

  it("resolves every starter's text to the official body font, not the app default", () => {
    STARTER_COMPONENTS.forEach((component, index) => {
      compose(
        documentSpecFromComponents([component], { title: component.name }),
        `font-${index}`,
      );
      const runs = runAttrs(`font-${index}`);
      expect({ name: component.name, runs: runs.length > 0 }).toEqual({
        name: component.name,
        runs: true,
      });
      for (const run of runs) {
        // 함초롬바탕 10pt is what a paragraph with no style resolves to; the
        // profile's 맑은 고딕 is the only face a starter may land on.
        expect({ name: component.name, face: run.face }).toEqual({
          name: component.name,
          face: "맑은 고딕",
        });
        // 22pt is the engine's own 발신명의 size (hwp-convert frames.rs).
        expect([12, 13, 14, 15, 22]).toContain(run.size);
      }
    });
  });

  it("composes the 결문's 발신명의 line first, at 22pt", () => {
    const index = STARTER_COMPONENTS.findIndex((component) => component.name === "결문");
    compose(documentSpecFromComponents([STARTER_COMPONENTS[index]!]), "font-gyeolmun");
    expect(runAttrs("font-gyeolmun")[0]).toEqual({ face: "맑은 고딕", size: 22 });
  });

  it("gives the 붙임 body the profile's 12pt on every line that carries text", () => {
    const index = STARTER_COMPONENTS.findIndex((component) => component.name === "붙임");
    compose(documentSpecFromComponents([STARTER_COMPONENTS[index]!]), "font-attachment");
    // 붙임's third 항목 defaults to "", so substitution leaves an empty run and
    // the engine reports no run segment for that line: three lines of text.
    expect(runAttrs("font-attachment")).toEqual([
      { face: "맑은 고딕", size: 12 },
      { face: "맑은 고딕", size: 12 },
      { face: "맑은 고딕", size: 12 },
    ]);
  });

  it("composes all seven in list order, with the params visible in the output", () => {
    const gaejosik = STARTER_COMPONENTS.findIndex((component) => component.name === "개조식");
    const report = compose(
      documentSpecFromComponents(
        STARTER_COMPONENTS.map((component, index) =>
          index === gaejosik ? { component, values: { "표제": "추진 경과" } } : component,
        ),
        { title: "구성요소 조립" },
      ),
      "assembly",
    );
    expect(report["warnings"]).toEqual([]);
    expect(report["tables"]).toBe(4);
    const body = markdown("assembly");
    expect(body).toContain("추진 경과");
    expect(body).toContain("□ 추진 배경");
    expect(body).toContain("○ 추진 내용");
    expect(body).toContain("· 향후 계획");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The insertion side of the same resolver: `insert_blocks` takes a `styles`
 * map and refuses a block whose style neither it nor the target defines, so a
 * palette has to send every profile style its component references.
 */
describe("componentStyleMap", () => {
  it("adds the profile styles a component references, through its based_on chain", () => {
    const styles = componentStyleMap([substituteParams(starter("결재란"))]);
    // Its own style, the profile style that style is based on, and nothing else:
    // the map is what a bare target needs, not the whole profile table.
    expect(Object.keys(styles).sort()).toEqual(["바탕글", "결재란 셀"].sort());
    expect(styles["결재란 셀"]?.["based_on"]).toBe("바탕글");
  });

  it("takes profile values from the table rather than a component's copy", () => {
    const styles = componentStyleMap([substituteParams(starter("붙임"))]);
    expect(styles["바탕글"]).toEqual(OFFICIAL_PROFILE["바탕글"]);
    // A copy, not the module's row: editing what a host gets back cannot reach
    // the profile table.
    const official = { ...OFFICIAL_PROFILE["바탕글"] };
    const row = styles["바탕글"] as Record<string, unknown>;
    row["font_size_pt"] = 999;
    expect(row["font_size_pt"]).toBe(999);
    expect(OFFICIAL_PROFILE["바탕글"]).toEqual(official);
  });

  it("refuses a profile redefinition where the component's own file is the source", () => {
    // The refusal names what the user can open — the file or URL the component
    // came from — rather than the component's `name`, which is one field inside
    // that file (AC3). Validation is where the source is still known.
    let refusal: unknown;
    try {
      validateComponent({
        name: "시험",
        description: "시험용 구성요소",
        params: {},
        styles: { "바탕글": { font_size_pt: 30 } },
        blocks: [{ type: "paragraph", style: "바탕글", runs: [{ type: "text", text: "본문" }] }],
      }, REFUSAL_SOURCE);
    } catch (error) {
      refusal = error;
    }
    expect(isComponentError(refusal)).toBe(true);
    if (!isComponentError(refusal)) throw refusal;
    expect(refusal.code).toBe("component_style");
    expect(refusal.source).toBe(REFUSAL_SOURCE);
    expect(refusal.field).toBe("styles.바탕글");
    expect(refusal.reason).toContain("redefines the official profile's 바탕글");
  });

  it("refuses a profile redefinition from a component a host assembled in memory", () => {
    // `componentStyleMap` takes a `Component` a host built itself, which never
    // passed through `validatedStyle`; the merge applies the same rule, so one
    // component's copy of a shared profile row cannot reach the engine.
    let refusal: unknown;
    try {
      componentStyleMap([{
        name: "시험",
        description: "시험용 구성요소",
        params: {},
        styles: { "바탕글": { font_size_pt: 30 } },
        blocks: [{ type: "paragraph", style: "바탕글", runs: [{ type: "text", text: "본문" }] }],
      }]);
    } catch (error) {
      refusal = error;
    }
    expect(isComponentError(refusal)).toBe(true);
    if (!isComponentError(refusal)) throw refusal;
    expect(refusal.code).toBe("component_style");
    expect(refusal.source).toBe("시험");
    expect(refusal.field).toBe("styles.바탕글");
    expect(refusal.reason).toContain("redefines the official profile's 바탕글");
  });

  it("codes a param refusal apart from a shape refusal, so a host can localize it", () => {
    try {
      substituteParams(starter("결재란"), { "없는 값": "x" });
    } catch (error) {
      expect(isComponentError(error)).toBe(true);
      if (!isComponentError(error)) throw error;
      expect(error.code).toBe("component_param");
      expect(error.field).toBe("params.없는 값");
      // The one-line form every existing caller logs is unchanged.
      expect(error.message).toBe(
        "components: 결재란: params.없는 값: is not a param of this component; use one of its " +
          "declared params, or add the param to the component, then retry",
      );
    }
  });
});
