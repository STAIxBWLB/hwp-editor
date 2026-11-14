import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHttpEngine, createTauriEngine, HwpEngineError, PROTECTED_NEXT_STEP, type TauriInvoke } from "../src/index.js";
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/refusal-reports-v1.3/${name}.json`, import.meta.url), "utf8"));
const document = { name: "source.hwpx", data: new Uint8Array([1]) };
const protections = [
  ["password", "failed", "password"], ["certificate_encryption", "protected", "encrypted document"],
  ["certificate_drm", "protected", "DRM-protected document"], ["drm", "protected", "DRM-protected document"], ["signature", "protected", "signed document"],
] as const;
const diagnostic = "hwp_failed: hwp edit failed (exit 1): Error: DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 DRM 보안을 해제한 뒤 다시 저장하세요.";
async function refused(transport: "http" | "tauri", report: unknown): Promise<HwpEngineError> {
  const payload = { code: "failed", message: diagnostic, report, engineVersion: "2.1.0", refusal: "range_tag" };
  const invoke: TauriInvoke = async <T,>(cmd: string): Promise<T> => {
    if (cmd === "hwped_capabilities") return { version: "2.1.0", editable: true, formats: ["hwpx"], editOps: "v1" } as T;
    throw payload;
  };
  const engine = transport === "tauri" ? createTauriEngine(invoke)
    : createHttpEngine("http://fixture", { fetch: async () => Response.json({ error: payload }, { status: 422 }) });
  const result = await engine.edit(document, []).catch(error => error);
  expect(result).toBeInstanceOf(HwpEngineError); return result;
}
describe.each(["http", "tauri"] as const)("typed report minors over %s", transport => {
  it.each(protections)("maps %s without using contradictory diagnostic prose", async (protection, code, reason) => {
    const error = await refused(transport, fixture(`document-protected-${protection}`));
    expect(error.code).toBe(code); expect(error.message).toContain(reason);
    if (code === "protected") expect(error.message).toContain(PROTECTED_NEXT_STEP);
    else {
      expect(error.message).toMatch(/password.*(?:supply|provide|enter|open)/i);
      expect(error.message).toContain("word processor");
      expect(error.message).not.toContain("--password-stdin");
      expect(error.message).not.toContain(PROTECTED_NEXT_STEP);
    }
    expect(error.refusal).toBeUndefined();
  });
  it.each(["counts", "digest"])("names only typed verification invariants (%s)", async kind => {
    const report = fixture(`verify-mismatch-${kind}`) as { refusal: { message: string } };
    report.refusal.message = "PRIVATE_CONTENT /private/path";
    const error = await refused(transport, report);
    expect(error.code).toBe("failed"); expect(error.refusal).toBe("output_validation");
    expect(error.message).not.toMatch(/PRIVATE_CONTENT|private\/path|DRM/);
    expect(error.message).toMatch(/retry|reopen|save/i);
    if (kind === "counts") { expect(error.message).toContain("tables"); expect(error.message).toContain("text_chars"); }
    else expect(error.message).toMatch(/canonical digest/i);
  });
  it("fails closed on malformed protection values instead of reading protection prose", async () => {
    const report = fixture("document-protected-password") as { refusal: { values: unknown } };
    report.refusal.values = { protection: "bogus" };
    const error = await refused(transport, report);
    expect(error.code).toBe("failed"); expect(error.refusal).toBeUndefined();
    expect(error.message).toContain("Invalid refused edit report");
  });
  it("keeps unknown future codes unclassified, even beside protection prose", async () => {
    const report = fixture("verify-mismatch-digest") as { schema_version: string; refusal: unknown };
    report.schema_version = "1.99"; report.refusal = { code: "future_code", values: { ignored: "PRIVATE" }, message: "unread" };
    const error = await refused(transport, report);
    expect(error.code).toBe("failed"); expect(error.refusal).toBe("unclassified_refusal");
  });
});
