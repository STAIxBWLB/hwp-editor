import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { createHttpEngine, type DocumentHandle, type FormBindingPlan } from "@hwp-editor/core";
import { createCliEngine } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { BIN, multipartRequest } from "./helpers.js";

let released = false;
try { released = /\b2\.0\.0\b/.test(execFileSync(BIN, ["--version"], { encoding: "utf8" })); } catch { /* CI without a binary skips integration. */ }
const fixture = async (): Promise<DocumentHandle> => ({ name: "form.hwpx", data: new Uint8Array(await readFile(new URL("./fixtures/form-g5.hwpx", import.meta.url))) });

describe.skipIf(!released)("form binding on released ahwp 2.0.0", () => {
  it("discovers, previews, atomically applies and refuses stale plans over HTTP", async () => {
    const native = createCliEngine({ bin: BIN });
    const handler = createHwpEditorHandler({ engine: native });
    const fetcher: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const bytes = await req.arrayBuffer();
      const headers = new Headers(req.headers); if (req.method !== "GET") headers.set("content-length", String(bytes.byteLength));
      return handler(new Request(req.url, { method: req.method, headers, ...(req.method === "GET" ? {} : { body: bytes }) }));
    };
    const engine = createHttpEngine("http://local/api", { fetch: fetcher });
    expect((await engine.capabilities()).formBindings).toBe("v1");
    const document = await fixture(), original = document.data.slice();
    const discovery = await engine.discoverForms!(document);
    const target = discovery.occurrences.find(item => item.bindable)!;
    expect(target).toBeDefined();
    const plan: FormBindingPlan = { version: 1, source_sha256: discovery.source_sha256, structural_sha256: discovery.structural_sha256, bindings: [{ key: "reviewed", targets: [{ occurrence_id: target.id, copies: [0], max_chars: 100, allow_reflow: true }] }] };
    const preview = await engine.applyFormBindings!(document, plan, { reviewed: "Reviewed binding" }, { dryRun: true });
    expect(preview.receipt.published).toBe(false); expect(preview.document).toBeUndefined();
    expect(preview.preview.changes[0]?.new_text).toBe("Reviewed binding");
    const applied = await engine.applyFormBindings!(document, plan, { reviewed: "Reviewed binding" }, { dryRun: false });
    expect(applied.receipt.published).toBe(true);
    expect((await native.read(applied.document!)).markdown).toContain("Reviewed binding");
    expect(document.data).toEqual(original);
    await expect(engine.applyFormBindings!(document, { ...plan, source_sha256: "0".repeat(64) }, { reviewed: "x" }, { dryRun: true })).rejects.toThrow(/refused.*rediscover/i);
    await expect(engine.applyFormBindings!(document, plan, { reviewed: "x" }, { name: "wrong.hwp" })).rejects.toThrow(/same-format/);
    const malicious = multipartRequest("http://local/form-bindings", { file: document, plan: JSON.stringify(plan), values: JSON.stringify({ reviewed: "x" }), receipt: "/private/escape.json" });
    expect((await handler(malicious)).status).toBe(400);
  });
  it("refuses growth without reflow separately from a sufficient character budget", async () => {
    const engine = createCliEngine({ bin: BIN }), document = await fixture();
    const discovery = await engine.discoverForms(document);
    const target = discovery.occurrences.find(item => item.bindable && item.old_text.length === 2)!;
    expect(target).toBeDefined();
    const plan: FormBindingPlan = { version: 1, source_sha256: discovery.source_sha256, structural_sha256: discovery.structural_sha256, bindings: [{ key: "value", targets: [{ occurrence_id: target.id, max_chars: 5, allow_reflow: false }] }] };
    await expect(engine.applyFormBindings(document, plan, { value: "ABCDE" }, { dryRun: true })).rejects.toThrow(/growth_without_reflow; limit=2.*allow reflow.*within 2 characters/);
    plan.bindings[0]!.targets[0]!.allow_reflow = true;
    expect((await engine.applyFormBindings(document, plan, { value: "ABCDE" }, { dryRun: true })).receipt.published).toBe(false);
  });
  it("supports same-format HWP dry run and apply", async () => {
    const engine = createCliEngine({ bin: BIN });
    const source = (await engine.compose({ version: "2.0", document: { version: "1.0", sections: [{ blocks: [{ type: "paragraph", runs: [{ type: "text", text: "Name: {{name}}" }] }] }] } }, "form.hwp")).document;
    const discovery = await engine.discoverForms(source);
    const target = discovery.occurrences.find(item => item.bindable)!;
    const plan: FormBindingPlan = { version: 1, source_sha256: discovery.source_sha256, structural_sha256: discovery.structural_sha256, bindings: [{ key: "name", targets: [{ occurrence_id: target.id, max_chars: 30, allow_reflow: true }] }] };
    expect((await engine.applyFormBindings(source, plan, { name: "Reviewed" }, { dryRun: true })).receipt.published).toBe(false);
    const result = await engine.applyFormBindings(source, plan, { name: "Reviewed" });
    expect(result.document?.name).toBe("form.hwp");
    expect((await engine.read(result.document!)).markdown).toContain("Reviewed");
  });
});
