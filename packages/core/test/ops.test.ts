/**
 * opsToArgv/argvToOps/opsToJson tests. Expected flag spellings and value
 * formats are pinned to crates/hwp-cli/src/cli.rs `EditArgs` (lines
 * ~569-676) — each test cites the clap long name from that struct — and the
 * opsToJson expectations to schemas/edit-ops-v1.schema.json at hwp-cli
 * v0.20.0.
 */
import { describe, expect, it } from "vitest";
import { argvToOps, opsToArgv, opsToJson, type EditOp } from "../src/ops.js";
import { HwpEngineError } from "../src/errors.js";
import type { Blocks } from "../src/generated/document-spec-v2.js";

describe("opsToArgv", () => {
  it("serializes one --flag value pair per op, in order", () => {
    const ops: EditOp[] = [
      // EditArgs.replace: --replace "find=>replace"
      { kind: "replace", find: "구교재", replace: "신교재" },
      // EditArgs.set_meta: --set-meta "key=value"
      { kind: "set-meta", key: "title", value: "2026 사업계획" },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--replace",
      "구교재=>신교재",
      "--set-meta",
      "title=2026 사업계획",
    ]);
  });

  it("serializes field/bookmark/hyperlink ops (EditArgs.create_*)", () => {
    const ops: EditOp[] = [
      // --set-field "name=value"
      { kind: "set-field", name: "date", value: "2026-08-22" },
      // --create-field "anchor=>name=value"
      { kind: "create-field", anchor: "서명:", name: "signature", value: "" },
      // --create-bookmark "anchor=>name"
      { kind: "create-bookmark", anchor: "제1장", name: "chapter1" },
      // --create-hyperlink "anchor=>text=>URL"
      {
        kind: "create-hyperlink",
        anchor: "홈페이지",
        text: "한라대",
        url: "https://www.chu.ac.kr",
      },
      // --create-hyperlink "anchor=>URL" (no text)
      { kind: "create-hyperlink", anchor: "링크", url: "https://halla.ai" },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--set-field", "date=2026-08-22",
      "--create-field", "서명:=>signature=",
      "--create-bookmark", "제1장=>chapter1",
      "--create-hyperlink", "홈페이지=>한라대=>https://www.chu.ac.kr",
      "--create-hyperlink", "링크=>https://halla.ai",
    ]);
  });

  it("rejects structural separators in argv fields while preserving JSON payloads", () => {
    const badOps: Array<[EditOp, string, string]> = [
      [{ kind: "replace", find: "a=>b", replace: "tail=>value" }, "replace find", "=>"],
      [{ kind: "set-field", name: "a=b", value: "tail=value" }, "set-field name", "="],
      [{ kind: "set-meta", key: "a=b" as never, value: "tail=value" }, "set-meta key", "="],
      [{ kind: "create-field", anchor: "a=>b", name: "field" }, "create-field anchor", "=>"],
      [{ kind: "create-field", anchor: "anchor", name: "a=>b" }, "create-field name", "=>"],
      [{ kind: "create-field", anchor: "anchor", name: "a=b" }, "create-field name", "="],
      [{ kind: "create-bookmark", anchor: "a=>b", name: "mark" }, "create-bookmark anchor", "=>"],
      [{ kind: "create-hyperlink", anchor: "a=>b", text: "label", url: "https://a.b" }, "create-hyperlink anchor", "=>"],
      [{ kind: "create-hyperlink", anchor: "anchor", text: "a=>b", url: "https://a.b" }, "create-hyperlink text", "=>"],
      [{ kind: "create-hyperlink", anchor: "anchor", text: "label", url: "https://a.b/=>c" }, "create-hyperlink url", "=>"],
      [{ kind: "insert-image", anchor: "a=>b", path: "image.png" }, "insert-image anchor", "=>"],
      [{ kind: "insert-image", anchor: "anchor", path: "image.png@10x20" }, "insert-image path", "@"],
      [{ kind: "seal", anchor: "a=>b", path: "seal.png" }, "seal anchor", "=>"],
      [{ kind: "seal", anchor: "anchor", path: "seal@20" }, "seal path", "@"],
      // The unit may be spaced from the number: hwp-cli trims before stripping
      // `mm` and trims the rest again, so "5 mm" is a size and the path is a
      // path the engine would split (#58 item 11).
      [{ kind: "seal", anchor: "anchor", path: "stamp@5 mm" }, "seal path", "@"],
      [{ kind: "set-format", find: "a:b", props: {} }, "set-format find", ":"],
      [{ kind: "set-format", find: "x", props: { "bold=on": "yes" } }, "set-format props.bold=on.key", "="],
      [{ kind: "set-format", find: "x", props: { "bold,on": "yes" } }, "set-format props.bold,on.key", ","],
      [{ kind: "set-format", find: "x", props: { bold: "yes,italic=on" } }, "set-format props.bold.value", ","],
      [{ kind: "set-align", find: "a=b", alignment: "left" }, "set-align find", "="],
      [{ kind: "insert-para", anchor: "a=>b", text: "tail=>value" }, "insert-para anchor", "=>"],
      [{ kind: "insert-para-before", anchor: "a=>b", text: "tail=>value" }, "insert-para-before anchor", "=>"],
      [{ kind: "add-table", anchor: "a=>b", rows: [["tail=>value"]] }, "add-table anchor", "=>"],
      [{ kind: "clone-table", sourceTable: 0, anchor: "a=>b" }, "clone-table anchor", "=>"],
      [{ kind: "set-para", find: "a=>b", key: "indent", value: "tail,value" }, "set-para find", "=>"],
      [{ kind: "set-para", find: "x", key: "indent", value: "1,top:2" }, "set-para value", ","],
    ];
    for (const [op, field, separator] of badOps) {
      let failure: unknown;
      try {
        opsToArgv([op]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HwpEngineError);
      expect((failure as HwpEngineError).code).toBe("bad_request");
      expect((failure as HwpEngineError).message).toContain(field);
      expect((failure as HwpEngineError).message).toContain(JSON.stringify(separator));
      expect((failure as HwpEngineError).message).toContain("upgrade the host");
      expect((failure as HwpEngineError).cause).toBeInstanceOf(Error);
      expect(((failure as HwpEngineError).cause as Error).message).toContain(field);
    }
    const jsonSafe = badOps
      .map(([op]) => op)
      .filter(op => op.kind !== "set-para" || !op.value.includes(","));
    expect(() => opsToJson(jsonSafe)).not.toThrow();
    const jsonLiteralOps: EditOp[] = [
      { kind: "replace", find: "a=>b", replace: "c=>d" },
      { kind: "create-field", anchor: "a=>b", name: "n=>m", value: "v=x" },
      { kind: "create-hyperlink", anchor: "a=>b", text: "t=>u", url: "https://x/=>y" },
      { kind: "set-field", name: "a=b", value: "c=d" },
    ];
    expect(JSON.parse(opsToJson(jsonLiteralOps))).toEqual([
      { op: "replace", from: "a=>b", to: "c=>d" },
      { op: "create_field", anchor: "a=>b", name: "n=>m", value: "v=x" },
      { op: "create_hyperlink", anchor: "a=>b", display: "t=>u", url: "https://x/=>y" },
      { op: "set_field", name: "a=b", value: "c=d" },
    ]);
  });

  it("keeps split-once tail fields intact on the argv path", () => {
    expect(opsToArgv([
      { kind: "replace", find: "find", replace: "a=>b" },
      { kind: "set-field", name: "field", value: "a=b" },
      { kind: "set-meta", key: "title", value: "a=b" },
      { kind: "create-field", anchor: "anchor", name: "field", value: "a=b" },
      // The bookmark name is the tail of the one split, so a name that holds
      // the separator reaches the engine whole (#58 item 10).
      { kind: "create-bookmark", anchor: "anchor", name: "chapter=>1" },
      { kind: "set-cell", table: 0, row: 0, col: 0, value: "a=b" },
      { kind: "insert-para", anchor: "anchor", text: "a=>b" },
      { kind: "insert-image", anchor: "anchor", path: "dir=>image.png" },
      { kind: "insert-image", anchor: "anchor", path: "image.png@10x20", width: 30, height: 40 },
      { kind: "seal", anchor: "anchor", path: "dir=>seal.png" },
      { kind: "seal", anchor: "anchor", path: "seal.png@20", size: 30 },
      { kind: "add-table", anchor: "anchor", rows: [["a=>b"]] },
      { kind: "set-format", find: "find", props: { font: "Noto=Sans:JP" } },
      { kind: "set-align", find: "find", alignment: "left" },
      { kind: "set-page", key: "orientation", value: "land:scape" },
    ])).toEqual([
      "--replace", "find=>a=>b",
      "--set-field", "field=a=b",
      "--set-meta", "title=a=b",
      "--create-field", "anchor=>field=a=b",
      "--create-bookmark", "anchor=>chapter=>1",
      "--set-cell", "0:0:0=a=b",
      "--insert-para", "anchor=>a=>b",
      "--insert-image", "anchor=>dir=>image.png",
      "--insert-image", "anchor=>image.png@10x20@30x40",
      "--seal", "anchor=>dir=>seal.png",
      "--seal", "anchor=>seal.png@20@30",
      "--add-table", 'anchor=>[["a=>b"]]',
      "--set-format", "find:font=Noto=Sans:JP",
      "--set-align", "find=left",
      "--set-page", "orientation:land:scape",
    ]);
  });

  it("keeps a literal pipe in a set-cell value on both transports", () => {
    // #94 unescaped `\|` for display, so a cell can now hand back a value that
    // holds a pipe. Neither transport may read it as structure: the engine
    // stores what the reader typed (#95).
    const ops: EditOp[] = [
      { kind: "set-cell", table: 0, row: 1, col: 0, value: "x | y" },
      { kind: "set-cell", table: 0, row: 1, col: 1, value: "a | b \\| c" },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--set-cell", "0:1:0=x | y",
      "--set-cell", "0:1:1=a | b \\| c",
    ]);
    expect(JSON.parse(opsToJson(ops))).toEqual([
      { op: "set_cell", table: 0, row: 1, col: 0, text: "x | y" },
      { op: "set_cell", table: 0, row: 1, col: 1, text: "a | b \\| c" },
    ]);
  });

  it("serializes image and seal ops (EditArgs.insert_image, .seal)", () => {
    const ops: EditOp[] = [
      // --insert-image "anchor=>path@WxH" (mm)
      {
        kind: "insert-image",
        anchor: "사진",
        path: "figs/chart.png",
        width: 80,
        height: 50,
      },
      { kind: "insert-image", anchor: "도식", path: "figs/diagram.png" },
      // --seal "anchor=>path@size" (mm)
      { kind: "seal", anchor: "(인)", path: "seal.png", size: 20 },
      // --delete-image "anchor"
      { kind: "delete-image", anchor: "구 로고" },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--insert-image", "사진=>figs/chart.png@80x50",
      "--insert-image", "도식=>figs/diagram.png",
      "--seal", "(인)=>seal.png@20",
      "--delete-image", "구 로고",
    ]);
  });

  it("serializes formatting ops (EditArgs.set_format/.set_align/.set_para/.set_page)", () => {
    const ops: EditOp[] = [
      // --set-format "find:property=value,..."
      {
        kind: "set-format",
        find: "Title",
        props: { bold: "on", size: "16", color: "#FF0000" },
      },
      // --set-align "find=alignment"
      { kind: "set-align", find: "제 목", alignment: "center" },
      // --set-para "find=>key:value"
      { kind: "set-para", find: "본문", key: "line-spacing", value: "160%" },
      // --set-page "key:value"
      { kind: "set-page", key: "orientation", value: "landscape" },
      { kind: "set-page", key: "margin-top", value: "25" },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--set-format", "Title:bold=on,size=16,color=#FF0000",
      "--set-align", "제 목=center",
      "--set-para", "본문=>line-spacing:160%",
      "--set-page", "orientation:landscape",
      "--set-page", "margin-top:25",
    ]);
  });

  it("serializes paragraph ops (EditArgs.insert_para*/.delete_para)", () => {
    const ops: EditOp[] = [
      // --insert-para "anchor=>text"
      { kind: "insert-para", anchor: "2. 추진 배경", text: "세부 내용은 별첨." },
      // --insert-para-before "anchor=>text"
      { kind: "insert-para-before", anchor: "붙임", text: "다 음." },
      // --delete-para "text"
      { kind: "delete-para", text: "삭제 대상 문단" },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--insert-para", "2. 추진 배경=>세부 내용은 별첨.",
      "--insert-para-before", "붙임=>다 음.",
      "--delete-para", "삭제 대상 문단",
    ]);
  });

  it("serializes table ops (EditArgs.set_cell/.add_row/.add_col/.delete_*/.merge_cells/.split_cell)", () => {
    const ops: EditOp[] = [
      // --set-cell "table:row:col=value" (0-based)
      { kind: "set-cell", table: 0, row: 1, col: 2, value: "승인" },
      // --add-row "table[:at[:count[:template_row]]]"
      { kind: "add-row", table: 0 },
      { kind: "add-row", table: 0, at: 2, count: 3, templateRow: 1 },
      // --add-col "table[:at[:count]]"
      { kind: "add-col", table: 1, at: "end", count: 2 },
      // --delete-row "table:row"
      { kind: "delete-row", table: 0, row: 4 },
      // --delete-col "table:col"
      { kind: "delete-col", table: 0, col: 3 },
      // --merge-cells "table:r1:c1:r2:c2"
      { kind: "merge-cells", table: 0, r1: 0, c1: 0, r2: 0, c2: 2 },
      // --split-cell "table:row:col"
      { kind: "split-cell", table: 0, row: 0, col: 0 },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--set-cell", "0:1:2=승인",
      "--add-row", "0",
      "--add-row", "0:2:3:1",
      "--add-col", "1:end:2",
      "--delete-row", "0:4",
      "--delete-col", "0:3",
      "--merge-cells", "0:0:0:0:2",
      "--split-cell", "0:0:0",
    ]);
  });

  it("serializes table create/clone/delete ops (EditArgs.add_table/.clone_table/.delete_table)", () => {
    const ops: EditOp[] = [
      // --add-table "anchor=>json" (array of row arrays)
      {
        kind: "add-table",
        anchor: "표 1.",
        rows: [
          ["항목", "금액"],
          ["인건비", "100"],
        ],
      },
      // --clone-table "source_table=>anchor[=>blank|keep]"
      { kind: "clone-table", sourceTable: 0, anchor: "별첨 2", mode: "keep" },
      { kind: "clone-table", sourceTable: 1, anchor: "별첨 3" },
      // --delete-table "n" | "anchor"
      { kind: "delete-table", target: 2 },
      { kind: "delete-table", target: "불필요한 표" },
    ];
    expect(opsToArgv(ops)).toEqual([
      "--add-table", '표 1.=>[["항목","금액"],["인건비","100"]]',
      "--clone-table", "0=>별첨 2=>keep",
      "--clone-table", "1=>별첨 3",
      "--delete-table", "2",
      "--delete-table", "불필요한 표",
    ]);
  });

  it("serializes field/bookmark deletion ops (EditArgs.delete_field/.delete_bookmark)", () => {
    expect(
      opsToArgv([
        { kind: "delete-field", name: "legacy_date" },
        { kind: "delete-bookmark", name: "old_anchor" },
      ]),
    ).toEqual([
      "--delete-field", "legacy_date",
      "--delete-bookmark", "old_anchor",
    ]);
  });
});

/**
 * `--delete-table` carries one value whose meaning the engine decides by shape
 * rather than by a separator: `spec.trim().parse::<usize>()` selects the
 * 0-based index and everything else is an anchor paragraph (edit.rs
 * `EditOperation::DeleteTable`, documented in `cli.rs`). A target that value
 * cannot express is refused before serialization rather than reaching another
 * table (#58 item 13e).
 */
describe("the argv delete-table value means what it says (#58 item 13e)", () => {
  const refusal = (target: number | string): HwpEngineError => {
    let failure: unknown;
    try {
      opsToArgv([{ kind: "delete-table", target }]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HwpEngineError);
    return failure as HwpEngineError;
  };

  it("refuses an anchor the engine would read as a table index", () => {
    for (const anchor of ["3", " 3 ", "+3", "007"]) {
      const failure = refusal(anchor);
      expect(failure.code).toBe("bad_request");
      // The refusal prints the anchor it cannot address, so the caller can tell
      // which op in a batch it came from.
      expect(failure.message).toContain(JSON.stringify(anchor));
      expect(failure.message).toContain("is read as table index");
      expect(failure.message).toContain("upgrade the host");
      expect(failure.cause).toBeInstanceOf(Error);
    }
  });

  it("refuses a number the engine would read as an anchor name", () => {
    for (const target of [-1, 3.5, Number.NaN]) {
      const failure = refusal(target);
      expect(failure.code).toBe("bad_request");
      expect(failure.message).toContain(`delete-table target ${String(target)}`);
      expect(failure.message).toContain("anchor paragraph name");
    }
  });

  it("serializes an index as an index and a real anchor as an anchor", () => {
    expect(opsToArgv([
      { kind: "delete-table", target: 3 },
      { kind: "delete-table", target: "불필요한 표" },
      // The engine reads these as anchor names, so they may be carried as-is.
      { kind: "delete-table", target: "3.5" },
      { kind: "delete-table", target: "-1" },
      { kind: "delete-table", target: "" },
    ])).toEqual([
      "--delete-table", "3",
      "--delete-table", "불필요한 표",
      "--delete-table", "3.5",
      "--delete-table", "-1",
      "--delete-table", "",
    ]);
  });

  it("reads the flag back with the engine's own rule", () => {
    expect(argvToOps(["--delete-table", "3"])).toEqual([{ kind: "delete-table", target: 3 }]);
    expect(argvToOps(["--delete-table", " 3 "])).toEqual([{ kind: "delete-table", target: 3 }]);
    // `Number("")` is 0 and `Number("3.5")` is a fractional index; the engine
    // treats both as anchors, and so does the reader now.
    expect(argvToOps(["--delete-table", ""])).toEqual([{ kind: "delete-table", target: "" }]);
    expect(argvToOps(["--delete-table", "3.5"])).toEqual([{ kind: "delete-table", target: "3.5" }]);
  });
});

describe("argvToOps round-trip", () => {
  const roundTripCases: EditOp[] = [
    { kind: "replace", find: "a", replace: "b" },
    { kind: "set-cell", table: 0, row: 1, col: 2, value: "v" },
    { kind: "set-field", name: "n", value: "v" },
    { kind: "set-meta", key: "author", value: "이영준" },
    { kind: "create-field", anchor: "x", name: "f", value: "1" },
    { kind: "create-bookmark", anchor: "x", name: "b" },
    { kind: "create-hyperlink", anchor: "x", text: "t", url: "https://a.b" },
    { kind: "insert-image", anchor: "x", path: "p.png", width: 10, height: 20 },
    { kind: "seal", anchor: "x", path: "s.png", size: 20 },
    { kind: "set-format", find: "t", props: { bold: "on", size: "16" } },
    { kind: "set-align", find: "t", alignment: "justify" },
    { kind: "insert-para", anchor: "x", text: "t" },
    { kind: "insert-para-before", anchor: "x", text: "t" },
    { kind: "delete-para", text: "t" },
    { kind: "add-row", table: 0, at: 2, count: 3, templateRow: 1 },
    { kind: "add-col", table: 1, at: "end", count: 2 },
    { kind: "delete-row", table: 0, row: 4 },
    { kind: "delete-col", table: 0, col: 3 },
    { kind: "merge-cells", table: 0, r1: 0, c1: 0, r2: 1, c2: 1 },
    { kind: "split-cell", table: 0, row: 0, col: 0 },
    { kind: "add-table", anchor: "x", rows: [["a", "b"], ["c"]] },
    { kind: "clone-table", sourceTable: 0, anchor: "x", mode: "blank" },
    { kind: "set-para", find: "t", key: "indent", value: "10" },
    { kind: "set-page", key: "width", value: "210" },
    { kind: "delete-image", anchor: "x" },
    { kind: "delete-table", target: 1 },
    { kind: "delete-table", target: "anchor text" },
    { kind: "delete-field", name: "f" },
    { kind: "delete-bookmark", name: "b" },
  ];

  it.each(roundTripCases.map((op) => [op.kind, op] as const))(
    "round-trips %s",
    (_kind, op) => {
      expect(argvToOps(opsToArgv([op]))).toEqual([op]);
    },
  );

  it("rejects a flag without a value", () => {
    expect(() => argvToOps(["--replace"])).toThrow(/no value/);
  });
});

describe("opsToJson", () => {
  const json = (ops: EditOp[]): unknown => JSON.parse(opsToJson(ops));

  it("emits edit-ops-v1 tagged entries for the text ops", () => {
    expect(
      json([
        { kind: "replace", find: "a=>b", replace: "c=d" },
        { kind: "set-cell", table: 0, row: 1, col: 2, value: "v" },
        { kind: "set-field", name: "n", value: "v" },
        { kind: "set-meta", key: "author", value: "이영준" },
        { kind: "create-field", anchor: "x", name: "f", value: "1" },
        { kind: "create-field", anchor: "x", name: "g" },
        { kind: "create-bookmark", anchor: "x", name: "b" },
        { kind: "create-hyperlink", anchor: "x", text: "t", url: "https://a.b" },
        { kind: "create-hyperlink", anchor: "x", url: "https://a.b" },
        { kind: "delete-para", text: "t" },
        { kind: "delete-image", anchor: "x" },
        { kind: "delete-field", name: "f" },
        { kind: "delete-bookmark", name: "b" },
      ]),
    ).toEqual([
      // Separators inside string payloads cross as data, not grammar.
      { op: "replace", from: "a=>b", to: "c=d" },
      { op: "set_cell", table: 0, row: 1, col: 2, text: "v" },
      { op: "set_field", name: "n", value: "v" },
      { op: "set_meta", key: "author", value: "이영준" },
      { op: "create_field", anchor: "x", name: "f", value: "1" },
      { op: "create_field", anchor: "x", name: "g" },
      { op: "create_bookmark", anchor: "x", name: "b" },
      { op: "create_hyperlink", anchor: "x", display: "t", url: "https://a.b" },
      { op: "create_hyperlink", anchor: "x", url: "https://a.b" },
      { op: "delete_para", matching: "t" },
      { op: "delete_image", anchor: "x" },
      { op: "delete_field", name: "f" },
      { op: "delete_bookmark", name: "b" },
    ]);
  });

  it("emits edit-ops-v1 entries for the image, paragraph and table ops", () => {
    expect(
      json([
        { kind: "insert-image", anchor: "x", path: "p.png", width: 10, height: 20 },
        { kind: "insert-image", anchor: "x", path: "p.png" },
        { kind: "seal", anchor: "x", path: "s.png", size: 20 },
        { kind: "set-format", find: "t", props: { bold: "on", size: "16" } },
        { kind: "set-align", find: "t", alignment: "justify" },
        { kind: "insert-para", anchor: "x", text: "t" },
        { kind: "insert-para-before", anchor: "x", text: "t" },
        { kind: "add-row", table: 0, at: 2, count: 3, templateRow: 1 },
        { kind: "add-row", table: 0, at: "end" },
        { kind: "add-col", table: 1, at: "end", count: 2 },
        { kind: "delete-row", table: 0, row: 4 },
        { kind: "delete-col", table: 0, col: 3 },
        { kind: "merge-cells", table: 0, r1: 0, c1: 0, r2: 1, c2: 1 },
        { kind: "split-cell", table: 0, row: 0, col: 0 },
        { kind: "add-table", anchor: "x", rows: [["a", "b"], ["c"]] },
        { kind: "clone-table", sourceTable: 0, anchor: "x", mode: "blank" },
        { kind: "delete-table", target: 1 },
        { kind: "delete-table", target: "anchor text" },
      ]),
    ).toEqual([
      { op: "insert_image", anchor: "x", path: "p.png", width_mm: "10mm", height_mm: "20mm" },
      { op: "insert_image", anchor: "x", path: "p.png" },
      { op: "seal", anchor: "x", path: "s.png", size_mm: "20mm" },
      // The CLI flag's bare `size=16` is points; the schema wants the suffix.
      { op: "set_format", pattern: "t", bold: "on", size: "16pt" },
      { op: "set_align", pattern: "t", align: "justify" },
      { op: "insert_para", anchor: "x", text: "t" },
      { op: "insert_para", anchor: "x", text: "t", before: true },
      { op: "add_row", table: 0, at: 2, count: 3, template_row: 1 },
      // The CLI's bare "end" is the schema's omitted `at`: both append.
      { op: "add_row", table: 0 },
      { op: "add_col", table: 1, count: 2 },
      { op: "delete_row", table: 0, row: 4 },
      { op: "delete_col", table: 0, col: 3 },
      { op: "merge_cells", table: 0, r1: 0, c1: 0, r2: 1, c2: 1 },
      { op: "split_cell", table: 0, row: 0, col: 0 },
      { op: "add_table", anchor: "x", rows: [["a", "b"], ["c"]] },
      { op: "clone_table", source_table: 0, anchor: "x", text_mode: "blank" },
      { op: "delete_table", index: 1 },
      { op: "delete_table", anchor: "anchor text" },
    ]);
  });

  it("keeps the reserved op/pattern fields when set-format props collide with them", () => {
    // props is a free Record<string, string>; a caller-supplied "pattern" or
    // "op" key is invalid on this channel (the CLI's schema rejects it), and
    // it must never override the op's own target on the way there.
    expect(
      json([{ kind: "set-format", find: "target", props: { pattern: "other", op: "x", bold: "on" } }]),
    ).toEqual([{ bold: "on", op: "set_format", pattern: "target" }]);
  });

  it("maps set-para/set-page keys to the schema's suffixed unit fields", () => {
    expect(
      json([
        { kind: "set-para", find: "t", key: "line-spacing", value: "160%" },
        { kind: "set-para", find: "t", key: "line-spacing", value: "160" },
        { kind: "set-para", find: "t", key: "line-spacing", value: "12pt" },
        { kind: "set-para", find: "t", key: "indent", value: "10" },
        { kind: "set-para", find: "t", key: "indent", value: "10.5mm" },
        { kind: "set-para", find: "t", key: "top", value: "5" },
        { kind: "set-page", key: "width", value: "210" },
        { kind: "set-page", key: "margin-top", value: "25" },
        { kind: "set-page", key: "orientation", value: "landscape" },
      ]),
    ).toEqual([
      { op: "set_para", pattern: "t", line_spacing_pct: "160%" },
      { op: "set_para", pattern: "t", line_spacing_pct: "160%" },
      { op: "set_para", pattern: "t", line_spacing_pt: "12pt" },
      { op: "set_para", pattern: "t", indent_mm: "10mm" },
      { op: "set_para", pattern: "t", indent_mm: "10.5mm" },
      { op: "set_para", pattern: "t", top_mm: "5mm" },
      { op: "set_page", width_mm: "210mm" },
      { op: "set_page", margin_top_mm: "25mm" },
      { op: "set_page", orientation: "landscape" },
    ]);
  });

  it("rejects unit values outside the edit-ops-v1 grammar with a cause and next step", () => {
    for (const [op, field] of [
      [{ kind: "set-page", key: "width", value: "-5" }, "set_page.width_mm"],
      [{ kind: "set-format", find: "t", props: { size: ".5" } }, "set_format.size"],
      [{ kind: "set-para", find: "t", key: "indent", value: "1e2" }, "set_para.indent_mm"],
      [{ kind: "set-para", find: "t", key: "indent", value: "12in" }, "set_para.indent_mm"],
    ] as const) {
      let failure: unknown;
      try {
        opsToJson([op]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HwpEngineError);
      const engineError = failure as HwpEngineError;
      expect(engineError.code).toBe("bad_request");
      expect(engineError.message).toContain(field);
      expect(engineError.message).toContain("provide a nonnegative decimal");
      expect(engineError.cause).toBeInstanceOf(Error);
      expect((engineError.cause as Error).message).toContain(field);
    }
  });

  it("validates numeric image and seal dimensions before serializing units", () => {
    const json = (ops: EditOp[]): unknown => JSON.parse(opsToJson(ops));
    expect(
      json([
        { kind: "insert-image", anchor: "x", path: "p.png", width: 1e-7, height: 1e2 },
        { kind: "seal", anchor: "x", path: "s.png", size: 1e-7 },
      ]),
    ).toEqual([
      { op: "insert_image", anchor: "x", path: "p.png", width_mm: "0.0000001mm", height_mm: "100mm" },
      { op: "seal", anchor: "x", path: "s.png", size_mm: "0.0000001mm" },
    ]);

    for (const [op, field] of [
      { kind: "insert-image", anchor: "x", path: "p.png", width: -5, height: 20 },
      { kind: "seal", anchor: "x", path: "s.png", size: Number.POSITIVE_INFINITY },
    ].map((op, index) => [op, index === 0 ? "insert_image.width_mm" : "seal.size_mm"] as const)) {
      let failure: unknown;
      try {
        opsToJson([op as EditOp]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HwpEngineError);
      expect((failure as HwpEngineError).message).toContain(field);
      expect((failure as HwpEngineError).cause).toBeInstanceOf(Error);
    }
  });
});


describe("addressed edit-ops-v1", () => {
  const address = { id: "1234567890abcdef.0.1" };
  it("serializes every addressed arm without text selectors", () => {
    const ops: EditOp[] = [
      { kind: "replace", address, find: "반복문구", replace: "수정" },
      { kind: "set-format", address: { ...address, chars: [0, 3] }, props: { bold: "on" } },
      { kind: "set-align", address, alignment: "center" },
      { kind: "set-para", address, key: "line-spacing", value: "180" },
      { kind: "insert-para", address, text: "뒤" },
      { kind: "insert-para-before", address, text: "앞" },
      { kind: "delete-para", address },
      { kind: "move-para", address, to: { address: { at: { section: 0, paragraph: 0 } }, position: "before" } },
      { kind: "indent-para", address },
      { kind: "outdent-para", address },
    ];
    expect(JSON.parse(opsToJson(ops))).toEqual([
      { op: "replace", address, from: "반복문구", to: "수정" },
      { op: "set_format", address: { ...address, chars: [0, 3] }, bold: "on" },
      { op: "set_align", address, align: "center" },
      { op: "set_para", address, line_spacing_pct: "180%" },
      { op: "insert_para", address, text: "뒤" },
      { op: "insert_para", address, text: "앞", before: true },
      { op: "delete_para", address },
      { op: "move_para", address, to: { address: { at: { section: 0, paragraph: 0 } }, position: "before" } },
      { op: "indent_para", address },
      { op: "outdent_para", address },
    ]);
    for (const op of ops) expect(() => opsToArgv([op])).toThrow(/Update the host and Tauri client.*docs\/integration-maru[.]md/);
  });
  it("keeps reserved format fields under serializer control", () => {
    expect(JSON.parse(opsToJson([{ kind: "set-format", address,
      props: { bold: "on", op: "delete_para", address: "bad", pattern: "all" } }]))).toEqual([
      { op: "set_format", address, bold: "on" },
    ]);
  });
  /**
   * edit-ops-v1 spells this arm `insert_blocks` with `position` (not `before`),
   * and takes the component's blocks verbatim; measured on ahwp 1.6.0, whose
   * parser rejects any other spelling before touching the document.
   */
  it("serializes insert-blocks with the blocks and the optional style policy", () => {
    const blocks: Blocks = [{ type: "paragraph", runs: [{ type: "text", text: "요약" }] }];
    expect(JSON.parse(opsToJson([{ kind: "insert-blocks", address, position: "after", blocks }]))).toEqual([
      { op: "insert_blocks", address, position: "after", blocks },
    ]);
    expect(JSON.parse(opsToJson([{ kind: "insert-blocks", address, position: "before", blocks,
      styles: { "요약표 머리": { based_on: "바탕글", bold: true } },
      missingStyle: "refuse" }]))).toEqual([
      { op: "insert_blocks", address, position: "before", blocks,
        styles: { "요약표 머리": { based_on: "바탕글", bold: true } },
        missing_style: "refuse" },
    ]);
  });
});
