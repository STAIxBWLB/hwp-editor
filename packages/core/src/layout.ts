import { HwpEngineError } from "./errors.js";
import type { LayoutRow, PageLayout } from "./engine.js";

export const RENDER_LAYOUT_NEXT_STEP = "check that the hwp-cli version pinned in cli-engine.ts emits render-layout-v1 (hwp-render-layout-v1, schema 1.x)";

function invalid(cause: string): never {
  throw new HwpEngineError("failed", `invalid render layout geometry: ${cause}; ${RENDER_LAYOUT_NEXT_STEP}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function positiveSize(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(`${field} must be a positive finite number`);
  return value;
}
function layoutRow(value: unknown): LayoutRow {
  const row = object(value, "row");
  if (typeof row.id !== "string" || row.id.length === 0) invalid("row.id must be a nonempty string");
  if (typeof row.kind !== "string" || !["para", "table", "cell", "bookmark"].includes(row.kind)) invalid("row.kind is unsupported");
  let box: LayoutRow["box"] = null;
  if (row.box !== null) {
    const raw = object(row.box, "row.box");
    if (![raw.x0, raw.y0, raw.x1, raw.y1].every(n => typeof n === "number" && Number.isFinite(n))) invalid("row.box coordinates must be finite numbers");
    const x0 = raw.x0 as number, y0 = raw.y0 as number, x1 = raw.x1 as number, y1 = raw.y1 as number;
    if (x0 > x1 || y0 > y1) invalid("row.box must satisfy x0 <= x1 and y0 <= y1");
    box = { x0, y0, x1, y1 };
  }
  let source_chars: LayoutRow["source_chars"] = null;
  if (row.source_chars !== null) {
    const range = object(row.source_chars, "row.source_chars");
    if (![range.start, range.end].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) || (range.end as number) < (range.start as number)) invalid("row.source_chars must contain ordered nonnegative integer offsets");
    source_chars = { start: range.start as number, end: range.end as number };
  }
  return { id: row.id, kind: row.kind as LayoutRow["kind"], box, source_chars };
}

/** Validate a present normalized layout before any adapter exposes its geometry. */
export function parsePageLayout(value: unknown): PageLayout {
  const page = object(value, "layout");
  const width_pt = positiveSize(page.width_pt, "layout.width_pt");
  const height_pt = positiveSize(page.height_pt, "layout.height_pt");
  if (!Array.isArray(page.rows)) invalid("layout.rows must be an array");
  if (typeof page.truncated !== "boolean") invalid("layout.truncated must be a boolean");
  return { width_pt, height_pt, rows: page.rows.map(layoutRow), truncated: page.truncated };
}

/** Validate the CLI artifact using the same row/page checks as HTTP and Tauri. */
export function parseRenderLayouts(source: string): Map<number, PageLayout> {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { invalid("artifact is not valid JSON"); }
  const raw = object(value, "artifact");
  if (raw.contract !== "hwp-render-layout-v1") invalid("contract must be hwp-render-layout-v1");
  if (typeof raw.schema_version !== "string" || !/^1[.][0-9]+$/.test(raw.schema_version)) invalid("schema_version must be 1.x");
  if (typeof raw.truncated !== "boolean") invalid("truncated must be a boolean");
  if (!Array.isArray(raw.selected_pages) || raw.selected_pages.length === 0) invalid("selected_pages must be a nonempty array");
  if (!Array.isArray(raw.pages)) invalid("pages must be an array");
  const selected = raw.selected_pages as unknown[];
  if (!selected.every(n => typeof n === "number" && Number.isSafeInteger(n) && n > 0) || new Set(selected).size !== selected.length) invalid("selected_pages must contain unique positive integers");
  const layouts = new Map<number, PageLayout>();
  for (const entry of raw.pages) {
    const page = object(entry, "pages entry");
    if (typeof page.page !== "number" || !Number.isSafeInteger(page.page) || page.page <= 0) invalid("pages.page must be a positive integer");
    if (!selected.includes(page.page) || layouts.has(page.page)) invalid("pages.page must uniquely match selected_pages");
    layouts.set(page.page, parsePageLayout({ width_pt: page.width_pt, height_pt: page.height_pt, rows: page.rows, truncated: raw.truncated }));
  }
  if (layouts.size !== selected.length) invalid("pages must account for every selected_pages entry");
  return layouts;
}
