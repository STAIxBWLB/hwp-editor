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

for (const { spec, out } of specs) {
  const target = join(fixturesDir, out);
  execFileSync(BIN, ["compose", spec, "-o", target], {
    cwd: dirname(spec),
    stdio: "inherit",
  });
  console.log(`seeded ${out}`);
}
rmSync(tableSpecPath, { force: true });

const fixtures = readdirSync(fixturesDir).filter((f) => /\.hwpx?$/.test(f)).sort();
for (const f of fixtures) cpSync(join(fixturesDir, f), join(publicDir, f));
writeFileSync(join(publicDir, "manifest.json"), JSON.stringify({ fixtures }, null, 2));
console.log(`fixtures: ${fixtures.join(", ")}`);
