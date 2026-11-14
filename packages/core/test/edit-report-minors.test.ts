import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEditReport } from "../src/edit-report.js";
import type { EditReport } from "../src/edit-report.js";

const fixture = (name: string): EditReport =>
  parseEditReport(JSON.parse(readFileSync(new URL(`./fixtures/refusal-reports-v1.3/${name}`, import.meta.url), "utf8")));
const documentProtected = (protection: string): unknown => ({
  schema_version: "1.2", contract: "hwp-edit-report-v1", output: "synthetic.hwpx", dry_run: false,
  ops: [], applied_count: 0, failed_count: 0,
  refusal: { code: "document_protected", values: { protection }, message: "SYNTHETIC: protected." },
});
const verifyMismatch = (counts: unknown): unknown => ({
  schema_version: "1.3", contract: "hwp-edit-report-v1", output: "synthetic.hwpx", dry_run: false,
  ops: [], applied_count: 0, failed_count: 0,
  refusal: { code: "verify_mismatch", values: { counts }, message: "SYNTHETIC: mismatch." },
});

describe("edit-report-v1 minor refusal codes", () => {
  it("parses each document_protected value", () => {
    for (const protection of ["password", "certificate_encryption", "certificate_drm", "drm", "signature"]) {
      expect(parseEditReport(documentProtected(protection)).refusal).toMatchObject({
        code: "document_protected", values: { protection }, message: "SYNTHETIC: protected.",
      });
    }
    expect(fixture("document-protected-password.json").schema_version).toBe("1.2");
    expect(fixture("document-protected-certificate_encryption.json").refusal?.code).toBe("document_protected");
    expect(fixture("document-protected-certificate_drm.json").refusal?.code).toBe("document_protected");
    expect(fixture("document-protected-drm.json").refusal?.code).toBe("document_protected");
    expect(fixture("document-protected-signature.json").refusal?.code).toBe("document_protected");
  });

  it("parses verify_mismatch counts and the empty-list digest-only case", () => {
    expect(fixture("verify-mismatch-counts.json").refusal).toMatchObject({
      code: "verify_mismatch", values: { counts: [
        { name: "tables", expected: 1, actual: 2 },
        { name: "text_chars", expected: 12, actual: 11 },
      ] },
    });
    expect(fixture("verify-mismatch-digest.json").refusal).toMatchObject({
      code: "verify_mismatch", values: { counts: [] },
    });
    expect(parseEditReport(verifyMismatch([])).refusal?.code).toBe("verify_mismatch");
  });

  it("projects an unknown nonempty code in a valid 1.x report to unclassified", () => {
    const raw = documentProtected("password") as Record<string, any>;
    raw.schema_version = "1.99";
    raw.refusal = { code: "future_refusal", values: { future_value: "opaque" }, message: "SYNTHETIC: future refusal." };
    expect(parseEditReport(raw).refusal).toEqual({
      code: "unclassified", values: {}, message: "SYNTHETIC: future refusal.",
    });
  });

  it("rejects missing, nonstring, and empty refusal codes", () => {
    for (const code of [undefined, null, 42, "", "   "]) {
      const raw = documentProtected("password") as Record<string, any>;
      raw.refusal = { code, values: {}, message: "SYNTHETIC: malformed." };
      expect(() => parseEditReport(raw)).toThrow(/Invalid edit report/);
    }
    const missing = documentProtected("password") as Record<string, any>;
    missing.refusal = { values: {}, message: "SYNTHETIC: malformed." };
    expect(() => parseEditReport(missing)).toThrow(/Invalid edit report/);
  });

  it("rejects malformed consumed refusal values and messages", () => {
    const malformed: unknown[] = [
      documentProtected("unknown"),
      { ...documentProtected("password") as object, refusal: { code: "document_protected", values: {}, message: "SYNTHETIC: malformed." } },
      { ...documentProtected("password") as object, refusal: { code: "document_protected", values: { protection: 1 }, message: "SYNTHETIC: malformed." } },
      verifyMismatch(null),
      verifyMismatch([{ name: "unknown", expected: 1, actual: 2 }]),
      verifyMismatch([{ name: "tables", expected: -1, actual: 2 }]),
      verifyMismatch([{ name: "tables", expected: 1.5, actual: 2 }]),
      verifyMismatch([{ name: "tables", expected: Number.MAX_SAFE_INTEGER + 1, actual: 2 }]),
      verifyMismatch([{ name: "tables", expected: 1, actual: "2" }]),
      verifyMismatch([{ expected: 1, actual: 2 }]),
      verifyMismatch([{ name: "tables", actual: 2 }]),
      verifyMismatch([{ name: "tables", expected: 1 }]),
    ];
    for (const raw of malformed) expect(() => parseEditReport(raw)).toThrow(/Invalid edit report/);

    const invalidMessage = documentProtected("password") as Record<string, any>;
    invalidMessage.refusal.message = 17;
    expect(() => parseEditReport(invalidMessage)).toThrow(/Invalid edit report/);
    const missingMessage = documentProtected("password") as Record<string, any>;
    delete missingMessage.refusal.message;
    expect(() => parseEditReport(missingMessage)).toThrow(/Invalid edit report/);
    const malformedUnknown = documentProtected("password") as Record<string, any>;
    malformedUnknown.refusal = { code: "future_refusal", values: null, message: "SYNTHETIC: future." };
    expect(() => parseEditReport(malformedUnknown)).toThrow(/Invalid edit report/);
    const malformedKnown = documentProtected("password") as Record<string, any>;
    malformedKnown.refusal = { code: "add_table.anchor_not_found", values: {}, message: "SYNTHETIC: malformed known refusal." };
    expect(() => parseEditReport(malformedKnown)).toThrow(/Invalid edit report/);
  });

  it("applies the same validation to per-operation refusals", () => {
    const raw = documentProtected("password") as Record<string, any>;
    raw.ops = [{
      index: 0, op: "replace", status: "failed", pieces_touched: 0, changed: [], reason: "replace: refused",
      refusal: { code: "document_protected", values: { protection: "signature" }, message: "SYNTHETIC: protected." },
    }];
    raw.failed_count = 1;
    expect(parseEditReport(raw).ops[0]?.refusal).toMatchObject({ code: "document_protected", values: { protection: "signature" } });
    raw.ops[0].refusal.values.protection = "unknown";
    expect(() => parseEditReport(raw)).toThrow(/Invalid edit report/);
  });
});
