import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { LayoutRow } from "@hwp-editor/core";
import { createCliEngine } from "../src/cli-engine.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const row: LayoutRow = {
  id: "para-2", kind: "para", box: { x0: 20, y0: 40, x1: 180, y1: 55 },
  source_chars: { start: 2, end: 8 },
};
const artifact = {
  schema_version: "1.0", contract: "hwp-render-layout-v1", truncated: true,
  selected_pages: [2, 3],
  pages: [
    { page: 2, width_pt: 200, height_pt: 300, rows: [row, { ...row, box: null, source_chars: null }] },
    { page: 3, width_pt: 400, height_pt: 500, rows: [] },
  ],
};

/** Isolated executable producer, including the engine's version/flag handshake. */
function renderBin(layout: unknown, selected = [2, 3]): string {
  const dir = mkdtempSync(join(tmpdir(), "hwp-layout-test-"));
  dirs.push(dir);
  const bin = join(dir, "hwp");
  const help = readFileSync(fileURLToPath(new URL("./fixtures/edit-help.txt", import.meta.url)), "utf8");
  writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("hwp 0.20.0"); process.exit(0); }
if (args[0] === "edit" && args[1] === "--help") { console.log(${JSON.stringify(help)}); process.exit(0); }
if (args[0] !== "render") process.exit(1);
const field = flag => args[args.indexOf(flag) + 1];
const selected = ${JSON.stringify(selected)};
const out = field("-o");
for (const page of selected) fs.writeFileSync(selected.length === 1 ? out : out.replace(/\\.svg$/, "-" + page + ".svg"), '<svg width="200pt" height="300pt"></svg>');
fs.writeFileSync(field("--report"), JSON.stringify({selected_pages: selected}));
const layout = ${JSON.stringify(layout ?? null)};
if (layout !== null) fs.writeFileSync(field("--layout-json"), typeof layout === "string" ? layout : JSON.stringify(layout));
`);
  chmodSync(bin, 0o700);
  return bin;
}

const document = { name: "layout.hwpx", data: new Uint8Array([1]) };

describe("render-layout-v1 retention", () => {
  it("joins by actual page number and retains point geometry, duplicates, nulls and truncation", async () => {
    const pages = await createCliEngine({ bin: renderBin(artifact) }).render(document);
    expect(pages.map(p => p.page)).toEqual([2, 3]);
    expect(pages[0]!.layout).toEqual({ width_pt: 200, height_pt: 300, rows: artifact.pages[0]!.rows, truncated: true });
    expect(pages[1]!.layout).toEqual({ width_pt: 400, height_pt: 500, rows: [], truncated: true });
  });

  it.each(["1.1", "1.12"])("accepts additive schema version %s", async (schema_version) => {
    const pages = await createCliEngine({ bin: renderBin({ ...artifact, schema_version }) }).render(document);
    expect(pages[0]!.layout!.rows).toEqual(artifact.pages[0]!.rows);
  });

  it.each([
    { x0: 180, y0: 40, x1: 20, y1: 55 },
    { x0: 20, y0: 55, x1: 180, y1: 40 },
  ])("rejects inverted boxes %j with actionable diagnostics", async (box) => {
    const layout = { ...artifact, pages: [{ ...artifact.pages[0], rows: [{ ...row, box }] }, artifact.pages[1]] };
    await expect(createCliEngine({ bin: renderBin(layout) }).render(document)).rejects.toMatchObject({
      reason: "failed", message: expect.stringContaining("row.box must satisfy x0 <= x1 and y0 <= y1"),
    });
  });

  it("uses the report page for a single selected page, not image-array index", async () => {
    const layout = { ...artifact, selected_pages: [3], pages: [artifact.pages[1]] };
    const [page] = await createCliEngine({ bin: renderBin(layout, [3]) }).render(document, { pages: "3" });
    expect(page!.page).toBe(3);
    expect(page!.layout!.width_pt).toBe(400);
  });

  it("keeps geometry absent for older producers that omit the artifact", async () => {
    const pages = await createCliEngine({ bin: renderBin(undefined) }).render(document);
    expect(pages).toHaveLength(2);
    expect(pages.every(page => page.layout === undefined)).toBe(true);
  });

  it.each([
    "not json",
    { ...artifact, contract: "unknown" },
    { ...artifact, schema_version: "2.0" },
    { ...artifact, pages: [{ ...artifact.pages[0], width_pt: 0 }, artifact.pages[1]] },
    { ...artifact, pages: [{ ...artifact.pages[0], rows: [{ ...row, box: { x0: 1 } }] }, artifact.pages[1]] },
    { ...artifact, pages: [{ ...artifact.pages[0], rows: [{ ...row, source_chars: { start: 8, end: 2 } }] }, artifact.pages[1]] },
    { ...artifact, pages: [artifact.pages[0]] },
  ])("rejects malformed present geometry instead of claiming exact selection", async (layout) => {
    await expect(createCliEngine({ bin: renderBin(layout) }).render(document, { format: "png" }))
      .rejects.toMatchObject({ reason: "failed", message: expect.stringMatching(/invalid render layout geometry: .+; check that the hwp-cli version pinned in cli-engine[.]ts emits render-layout-v1/) });
  });
});
