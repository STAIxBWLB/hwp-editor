import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDIT_REFUSAL_CODES, legacyRefusalSupported, parseEditReport, refusalCodesSupported, reportRefusalFields, sanitizeEditReport } from "../src/index.js";

const read = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/refusal-reports-v1.1/${name}`, import.meta.url), "utf8"));
const manifest = read("manifest.json") as { cases: { name: string; report: string; code: string }[] };
const report = (name: string): any => read(`${name}.json`);

const expected: Record<string, object> = {
  range_tag_shift: { refusal: "range_tag" },
  keep_together_unsupported: { refusal: "keep_together_unsupported" },
  section_owner_insert: { refusal: "section_owner" },
  section_owner_move: { refusal: "section_owner" },
  "add_table.anchor_not_found": { refusal: "anchor_not_found" },
  "insert_blocks.invalid_definition": { insertion: { kind: "invalid_definition" } },
  "insert_blocks.style_not_paragraph": { insertion: { kind: "invalid_definition" } },
  "insert_blocks.duplicate_style": { insertion: { kind: "invalid_definition" } },
  "insert_blocks.style_cycle": { insertion: { kind: "invalid_definition" } },
  "insert_blocks.style_id_overflow": { insertion: { kind: "invalid_definition" } },
  "insert_blocks.invalid_spec": { insertion: { kind: "invalid_definition" } },
  no_applicable_edits: { refusal: "no_applicable_edits" },
  unclassified: { refusal: "unclassified_refusal" },
};

describe("real edit-report-v1 1.1 refusals (#119 item 1)", () => {
  it("covers every stable engine code with a released 2.0.0 capture", () => {
    expect([...new Set(manifest.cases.map(c => c.code))].sort()).toEqual([...EDIT_REFUSAL_CODES].sort());
  });
  it.each(manifest.cases)("parses and maps $name ($code)", ({ name, report: file, code }) => {
    const raw = read(file);
    const parsed = parseEditReport(raw);
    expect(parsed).toEqual(raw);
    expect(parsed.refusal?.code).toBe(code);
    const fields = reportRefusalFields(parsed);
    if (code === "insert_blocks.unknown_style") {
      expect(fields).toEqual({ insertion: { kind: "unknown_style", style: raw.refusal.values.style } });
    } else if (code === "layout_overflow") {
      expect(fields).toEqual({ insertion: { kind: "layout_overflow", blockMm: 400, insertionMm: 170 } });
    } else if (code === "preservation_loss") {
      expect(fields).toEqual({ refusal: name === "preservation-font" ? "font_type_info" : "preservation_loss" });
    } else if (code === "unapplied_requests") {
      expect(fields).toEqual({ refusal: name === "unapplied-replace" ? "unmatched_replace" : "unapplied_requests" });
    } else expect(fields).toEqual(expected[code]);
  });
  it.each(["1.0", "1.1", "1.27"])("accepts supported schema major at %s", schema_version => {
    expect(parseEditReport({ ...report("preservation-font"), schema_version }).refusal?.code).toBe("preservation_loss");
  });
  it("redacts staged paths in top-level and per-op diagnostics without mutating the report", () => {
    const raw = report("invalid-definition-compile");
    raw.output = "/stage/private/edited.hwpx";
    raw.refusal.values.detail = "cannot read /stage/private/asset.png";
    raw.ops[0].refusal = raw.refusal;
    const parsed = parseEditReport(raw);
    const safe = sanitizeEditReport(parsed, "caller.hwpx", "/stage/private");
    expect(safe.output).toBe("caller.hwpx");
    expect(JSON.stringify(safe)).not.toContain("/stage/private");
    expect(JSON.stringify(parsed)).toContain("/stage/private");
    expect(reportRefusalFields(safe)).toEqual({ insertion: { kind: "invalid_definition" } });
  });
  it("preserves typed user identifiers even when they resemble file paths", () => {
    const raw = report("unknown-style");
    raw.refusal.values.style = "/private/user/chosen-style";
    const safe = sanitizeEditReport(parseEditReport(raw), "caller.hwpx", "/private/user");
    expect(reportRefusalFields(safe)).toEqual({ insertion: { kind: "unknown_style", style: "/private/user/chosen-style" } });
    const anchor = report("anchor-miss");
    anchor.refusal.values.anchor = "/private/user/chosen-anchor";
    expect(sanitizeEditReport(parseEditReport(anchor), "caller.hwpx").refusal).toEqual(anchor.refusal);
  });
  it("keeps absent refusal absent on old/success reports", () => {
    const raw = report("range-tag-shift");
    delete raw.refusal;
    expect(reportRefusalFields(parseEditReport(raw))).toEqual({});
  });
  it("does not infer a cause from message, issue prose, user paths or an incomplete outcome list", () => {
    const raw = report("legacy-row");
    raw.refusal.message = "font_type_info_unrepresentable layout_overflow range_tag_shift";
    expect(reportRefusalFields(parseEditReport(raw))).toEqual({ refusal: "unclassified_refusal" });
    const layout = report("layout-overflow");
    layout.refusal.values.issues[0].message = "column widths total 99999 mm; body width is 1 mm";
    layout.refusal.values.issues[0].path = ["$", "styles", "font_type_info_unrepresentable; layout_overflow"];
    expect(reportRefusalFields(parseEditReport(layout))).toEqual({ insertion: { kind: "layout_overflow", blockMm: 400, insertionMm: 170 } });
    layout.refusal.code = "insert_blocks.invalid_definition";
    expect(reportRefusalFields(parseEditReport(layout))).toEqual({ insertion: { kind: "invalid_definition" } });
    const partial = report("unapplied-replace");
    partial.failed_count++;
    expect(reportRefusalFields(parseEditReport(partial))).toEqual({ refusal: "unapplied_requests" });
  });
});

describe("malformed refusal fields fail closed", () => {
  it.each([null, [], {}, { code: "bogus", values: {}, message: "x" }, { code: "range_tag_shift", values: null, message: "x" }, { code: "range_tag_shift", values: {}, message: 1 }])("rejects malformed refusal %j", refusal => {
    expect(() => parseEditReport({ ...report("range-tag-shift"), refusal })).toThrow("Invalid edit report");
  });
  it.each([
    ["keep-together", "op_index", -1], ["keep-together", "requested", []],
    ["unknown-style", "style", " "], ["unknown-style", "missing_style", true],
    ["style-id-overflow", "style_id", 1.5], ["invalid-definition-compile", "detail", {}],
    ["layout-overflow", "container_width_mm", -1], ["layout-overflow", "issues", []],
    ["preservation-font", "events", []],
  ] as const)("rejects %s values.%s", (name, key, value) => {
    const raw = report(name); raw.refusal.values[key] = value;
    expect(() => parseEditReport(raw)).toThrow("Invalid edit report");
  });
  it.each([["code", false], ["count", 0], ["resource", "bogus"], ["disposition", "bogus"]])("rejects malformed preservation event %s", (key, value) => {
    const raw = report("preservation-font"); raw.refusal.values.events[0][String(key)] = value;
    expect(() => parseEditReport(raw)).toThrow("Invalid edit report");
  });
  it("validates per-op refusals as well as the top-level field", () => {
    const raw = report("range-tag-shift");
    raw.ops[0].refusal.values = null;
    expect(() => parseEditReport(raw)).toThrow("Invalid edit report");
  });
  it("rejects malformed numeric/path issue fields without searching their text", () => {
    const raw = report("layout-overflow"); raw.refusal.values.issues[0].path = ["$", -1];
    expect(() => parseEditReport(raw)).toThrow("Invalid edit report");
    raw.refusal.values.issues[0].path = ["$"]; raw.refusal.values.issues[0].measured_width_mm = "400";
    expect(() => parseEditReport(raw)).toThrow("Invalid edit report");
  });
});

describe("version gate for stderr compatibility", () => {
  it.each(["0.20.0", "1.4.0", "1.6.2"])("permits only explicit old engine %s", version => {
    expect(legacyRefusalSupported(version)).toBe(true); expect(refusalCodesSupported(version)).toBe(false);
  });
  it.each(["1.6.3", "1.6.4", "2.0.0"])("uses structured codes on %s", version => {
    expect(legacyRefusalSupported(version)).toBe(false); expect(refusalCodesSupported(version)).toBe(true);
  });
  it.each([undefined, null, "", "2", "unknown", 1])("does not assume an unknown version %j is old", version => {
    expect(legacyRefusalSupported(version)).toBe(false);
  });
});
