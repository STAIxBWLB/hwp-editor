import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpEngine, PROTECTED_NEXT_STEP } from "@hwp-editor/core";
import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";
import { hwpxBytes } from "./helpers.js";
afterEach(disposeFakeBins);
const fixture = (name: string) => readFileSync(new URL(`../../core/test/fixtures/refusal-reports-v1.3/${name}.json`, import.meta.url), "utf8");
const document = { name: "caller.hwpx", data: hwpxBytes() };
const cases = [["password","failed","password"],["certificate_encryption","protected","encrypted document"],["certificate_drm","protected","DRM-protected document"],["drm","protected","DRM-protected document"],["signature","protected","signed document"]] as const;
function host(name: string) {
  const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReport: fixture(name), editStderrLines: ["Error: DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 DRM 보안을 해제한 뒤 다시 저장하세요."] });
  return createCliEngine({ bin });
}
describe("schema-driven refusal minors at server boundary", () => {
  it.each(cases)("maps %s from report before the stderr protection backstop", async (protection, code, reason) => {
    const native = host(`document-protected-${protection}`);
    const error = await native.edit(document, []).catch(error => error) as HwpCliError;
    expect(error.reason).toBe(code); expect(error.message).toContain(reason); expect(error.report?.refusal?.code).toBe("document_protected");
    if (code === "protected") expect(error.message).toContain(PROTECTED_NEXT_STEP);
    else expect(error.message).not.toContain(PROTECTED_NEXT_STEP);
    const handler = createHwpEditorHandler({ engine: native });
    const client = createHttpEngine("http://fixture", { fetch: async (input, init) => {
      const request = new Request(input, init); request.headers.set("content-length", String((await request.clone().arrayBuffer()).byteLength)); return handler(request);
    } });
    const wireError = await client.edit(document, []).catch(error => error);
    expect(wireError.code).toBe(code); expect(wireError.message).toContain(reason);
  });
  it.each(["counts","digest"])("maps verify_mismatch %s without classifying protection prose", async kind => {
    const error = await host(`verify-mismatch-${kind}`).edit(document, []).catch(error => error) as HwpCliError;
    expect(error.reason).toBe("failed"); expect(error.refusal).toBe("output_validation"); expect(error.message).not.toContain("DRM");
    if (kind === "counts") { expect(error.message).toContain("tables"); expect(error.message).toContain("text_chars"); }
    else expect(error.message).toMatch(/canonical digest/);
  });
});
