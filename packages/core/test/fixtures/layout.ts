import type { PageLayout } from "../../src/engine.js";

export const validLayout: PageLayout = { width_pt: 600, height_pt: 800, truncated: true, rows: [
  { id: "para-1", kind: "para", box: { x0: 10, y0: 20, x1: 200, y1: 40 }, source_chars: { start: 0, end: 5 } },
  { id: "para-1", kind: "para", box: null, source_chars: null },
] };
export const malformedLayouts: { field: string; value: unknown }[] = [
  { field: "layout", value: null },
  { field: "layout.rows", value: { ...validLayout, rows: null } },
  { field: "layout.width_pt", value: { ...validLayout, width_pt: 0 } },
  { field: "row.box", value: { ...validLayout, rows: [{ ...validLayout.rows[0], box: { x0: 200, y0: 20, x1: 10, y1: 40 } }] } },
];
