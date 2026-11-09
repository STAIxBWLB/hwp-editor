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

const fixtures = readdirSync(fixturesDir).filter((f) => /\.hwpx?$/.test(f)).sort();
for (const f of fixtures) cpSync(join(fixturesDir, f), join(publicDir, f));
writeFileSync(join(publicDir, "manifest.json"), JSON.stringify({ fixtures }, null, 2));
console.log(`fixtures: ${fixtures.join(", ")}`);
