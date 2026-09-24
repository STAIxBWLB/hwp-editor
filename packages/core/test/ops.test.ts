/**
 * opsToArgv/argvToOps/opsToJson tests. Expected flag spellings and value
 * formats are pinned to crates/hwp-cli/src/cli.rs `EditArgs` (lines
 * ~569-676) — each test cites the clap long name from that struct — and the
 * opsToJson expectations to schemas/edit-ops-v1.schema.json at hwp-cli
 * v0.20.0.
 */
import { describe, expect, it } from "vitest";
import { argvToOps, opsToArgv, opsToJson, type EditOp } from "../src/ops.js";

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
        { kind: "set-para", find: "t", key: "indent", value: "-10" },
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
      { op: "set_para", pattern: "t", indent_mm: "-10mm" },
      { op: "set_para", pattern: "t", top_mm: "5mm" },
      { op: "set_page", width_mm: "210mm" },
      { op: "set_page", margin_top_mm: "25mm" },
      { op: "set_page", orientation: "landscape" },
    ]);
  });
});
