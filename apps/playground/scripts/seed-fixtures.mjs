#!/usr/bin/env node
/**
 * Seed playground fixtures by composing self-contained specs, written by this
 * script, with the real binary. Nothing outside this repository is read.
 * Writes to fixtures/ (canonical) and public/fixtures/ (served statically so
 * the page can fetch them), plus public/fixtures/manifest.json.
 *
 * Usage: pnpm seed   (HWP_EDITOR_BIN selects the binary; otherwise `hwp` on PATH)
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.HWP_EDITOR_BIN?.trim() || "hwp";

const fixturesDir = join(appDir, "fixtures");
const publicDir = join(appDir, "public", "fixtures");
rmSync(fixturesDir, { recursive: true, force: true });
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(fixturesDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const specs = [];

// Self-contained table demo (gives /edit --set-cell something to chew on).
const tableSpec = {
  version: "2.0",
  document: {
    version: "1.0",
    sections: [
      {
        blocks: [
          {
            type: "paragraph",
            runs: [{ type: "text", text: "표 편집 데모 — 셀을 바꿔 보세요." }],
          },
          {
            type: "table",
            columns: [{ width_mm: 50 }, { width_mm: 50 }, { width_mm: 50 }],
            rows: [
              ["항목", "수량", "비고"],
              ["사과", "3", "[[edit me]]"],
              ["배", "5", ""],
            ].map((row) => ({
              cells: row.map((text) => ({
                blocks: [{ type: "paragraph", runs: [{ type: "text", text }] }],
              })),
            })),
          },
        ],
      },
    ],
  },
};
const tableSpecPath = join(fixturesDir, "_table-demo.spec.json");
writeFileSync(tableSpecPath, JSON.stringify(tableSpec));
specs.push({ spec: tableSpecPath, out: "table-demo.hwpx" });

// Exact-selection fixture: varied text lengths and alignments across page breaks.
const layoutSpec = {
  version: "2.0",
  document: {
    version: "1.0",
    styles: {
      body: { font_size_pt: 11, spacing_after_pt: 12 },
      right: { font_size_pt: 11, align: "right", spacing_after_pt: 12 },
      large: { font_size_pt: 19, spacing_after_pt: 16 },
    },
    sections: [{
      page: { width_mm: 150, height_mm: 180, margin_left_mm: 15, margin_right_mm: 15,
        margin_top_mm: 15, margin_bottom_mm: 15 },
      blocks: Array.from({ length: 12 }, (_, index) => [
        ...(index > 0 && index % 4 === 0 ? [{ type: "break", kind: "page" }] : []),
        { type: "paragraph", style: index % 4 === 0 ? "large" : index % 2 ? "right" : "body",
          runs: [{ type: "text", text: `위치 검증 문단 ${index + 1}. ` +
            (index % 3 === 0 ? "서로 다른 길이의 문장을 실제 배치 좌표로 선택합니다. ".repeat(3) : "짧은 본문입니다.") }] },
      ]).flat(),
    }],
  },
};
const layoutSpecPath = join(fixturesDir, "_layout-demo.spec.json");
writeFileSync(layoutSpecPath, JSON.stringify(layoutSpec));
specs.push({ spec: layoutSpecPath, out: "z-layout-demo.hwpx" });

// T3 selection fixture: five paragraphs plus repeated text in distinct formatting runs.
const selectionSpec = {
  version: "2.0",
  document: { version: "1.0", sections: [{ blocks: [
    { type: "paragraph", runs: [
      { type: "text", text: "동일문" }, { type: "text", text: " / ", bold: true },
      { type: "text", text: "동일문", italic: true },
    ] },
    ...["둘째 😀문단", "셋째 문단", "넷째 문단", "다섯째 문단"].map(text => ({ type: "paragraph", runs: [{ type: "text", text }] })),
  ] }] },
};
const selectionSpecPath = join(fixturesDir, "_selection-demo.spec.json");
writeFileSync(selectionSpecPath, JSON.stringify(selectionSpec));
specs.push({ spec: selectionSpecPath, out: "z-selection-demo.hwpx" });

// T4 autofill fixture: one named slot plus label/value rows. `hwp slots
// --forms` discovers the table label cells as native form inputs.
const templateSpec = {
  version: "2.0",
  document: {
    version: "1.0",
    sections: [{
      blocks: [
        { type: "paragraph", runs: [{ type: "text", text: "공문서 입력 양식" }] },
        { type: "paragraph", runs: [{ type: "text", text: "문서번호: {{document_no}}" }] },
        { type: "paragraph", runs: [{ type: "text", text: "결재 상태: " }, { type: "field", name: "approval", value: "대기" }] },
        {
          type: "table",
          columns: [{ width_mm: 45 }, { width_mm: 100 }],
          rows: [["부서", ""], ["담당자", ""], ["시행일", ""]].map((row) => ({
            cells: row.map((text) => ({ blocks: [{ type: "paragraph", runs: [{ type: "text", text }] }] })),
          })),
        },
      ],
    }],
  },
};
const templateSpecPath = join(fixturesDir, "_template-demo.spec.json");
writeFileSync(templateSpecPath, JSON.stringify(templateSpec));
specs.push({ spec: templateSpecPath, out: "template-demo.hwpx" });

// WP3 styles fixture: two named paragraph styles whose body row every body
// paragraph inherits, one run formatted directly so AC6's "leaves directly
// formatted text as it was" has something to leave alone, and a 2x2 table so
// the preset has a table it can style. A one-column frame block is skipped by
// the engine, and a document with no eligible table is the case the
// `--style-tables` flag aborts on.
const stylesSpec = {
  version: "2.0",
  document: {
    version: "1.0",
    metadata: { title: "스타일 데모" },
    styles: {
      body: { font_family: "함초롬바탕", font_size_pt: 12, line_height_percent: 160, align: "justify" },
      heading: { font_family: "함초롬바탕", font_size_pt: 15, bold: true, align: "left" },
    },
    sections: [{
      blocks: [
        { type: "paragraph", style: "heading", runs: [{ type: "text", text: "스타일 데모" }] },
        { type: "paragraph", style: "body", runs: [{ type: "text", text: "첫 번째 본문 문단입니다." }] },
        { type: "paragraph", style: "body", runs: [
          { type: "text", text: "두 번째 본문 " },
          { type: "text", text: "직접 서식", font_size_pt: 20, bold: true },
        ] },
        {
          type: "table",
          columns: [{ width_mm: 60 }, { width_mm: 60 }],
          rows: [["항목", "값"], ["사과", "3"]].map((row) => ({
            cells: row.map((text) => ({ blocks: [{ type: "paragraph", runs: [{ type: "text", text }] }] })),
          })),
        },
      ],
    }],
  },
};
const stylesSpecPath = join(fixturesDir, "_styles-demo.spec.json");
writeFileSync(stylesSpecPath, JSON.stringify(stylesSpec));
specs.push({ spec: stylesSpecPath, out: "styles-demo.hwpx" });

// The other half of the preset switch: a document with NO table at all. This
// is the document `hwp edit --style-tables` aborts the whole edit on, and the
// reason the preset travels as an op with `--allow-partial` beside it. Its body
// style is deliberately not the official profile's (11pt, 140%) so the style
// update is visible in the answer while `style_tables` reports nothing to
// style; the CI run reads both.
const stylesPlainSpec = {
  version: "2.0",
  document: {
    version: "1.0",
    metadata: { title: "표 없는 스타일 데모" },
    styles: {
      body: { font_family: "함초롬바탕", font_size_pt: 11, line_height_percent: 140, align: "justify" },
      heading: { font_family: "함초롬바탕", font_size_pt: 15, bold: true, align: "left" },
    },
    sections: [{
      blocks: [
        { type: "paragraph", style: "heading", runs: [{ type: "text", text: "표가 없는 문서" }] },
        { type: "paragraph", style: "body", runs: [{ type: "text", text: "첫 번째 본문 문단입니다." }] },
        { type: "paragraph", style: "body", runs: [{ type: "text", text: "두 번째 본문 문단입니다." }] },
      ],
    }],
  },
};
const stylesPlainSpecPath = join(fixturesDir, "_styles-plain-demo.spec.json");
writeFileSync(stylesPlainSpecPath, JSON.stringify(stylesPlainSpec));
specs.push({ spec: stylesPlainSpecPath, out: "styles-plain-demo.hwpx" });

for (const { spec, out } of specs) {
  const target = join(fixturesDir, out);
  execFileSync(BIN, ["compose", spec, "-o", target], {
    cwd: dirname(spec),
    stdio: "inherit",
  });
  console.log(`seeded ${out}`);
}
rmSync(tableSpecPath, { force: true });
rmSync(layoutSpecPath, { force: true });
rmSync(templateSpecPath, { force: true });
rmSync(selectionSpecPath, { force: true });
rmSync(stylesSpecPath, { force: true });
rmSync(stylesPlainSpecPath, { force: true });

// Use the CLI's canonical official template for a stable no-error lint case.
execFileSync(BIN, ["new", "--template", "gongmun-basic", "-o", join(fixturesDir, "official-demo.hwpx")], {
  cwd: fixturesDir,
  stdio: "inherit",
});

const fixtures = readdirSync(fixturesDir).filter((f) => /\.hwpx?$/.test(f)).sort();
for (const f of fixtures) cpSync(join(fixturesDir, f), join(publicDir, f));
writeFileSync(join(publicDir, "manifest.json"), JSON.stringify({ fixtures }, null, 2));
console.log(`fixtures: ${fixtures.join(", ")}`);
