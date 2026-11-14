import { describe, it, expect, vi } from "vitest";
import { createHttpEngine } from "../src/http-engine.js";
import { createTauriEngine, type TauriInvoke } from "../src/tauri.js";
import type { FormBindingPlan } from "../src/forms.js";

const hash = "a".repeat(64), id = `occ-${hash}`;
const doc = { name: "form.hwpx", data: new Uint8Array([1, 2]) };
const discovery = { version: 1, source_sha256: hash, structural_sha256: hash, occurrences: [] };
const plan: FormBindingPlan = { version: 1, source_sha256: hash, structural_sha256: hash, bindings: [{ key: "name", targets: [{ occurrence_id: id, max_chars: 10, allow_reflow: true }] }] };
const result = (published = false) => ({ receipt: { version: 1, source_sha256: hash, plan_sha256: hash, values_sha256: hash, output_sha256: hash, published, occurrence_ids: [id], targets: 1, cloned_profiles: 0, native_warning_count: 0, semantic_budget: "selected_text_and_declared_clones_only", render_font_native: "unverified" }, preview: { version: 1, source_sha256: hash, plan_sha256: hash, values_sha256: hash, copies: [], changes: [], native_warnings: [] }, ...(published ? { name: doc.name, dataBase64: "AwQ=" } : {}) });

describe("form transports", () => {
  it("sends exact HTTP multipart routes and mode, validates results", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      return Response.json(String(input).endsWith("form-discovery") ? discovery : result((init?.body as FormData).get("dryRun") === "false"));
    });
    const engine = createHttpEngine("http://host/api", { fetch: fetcher });
    expect(await engine.discoverForms!(doc)).toEqual(discovery);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://host/api/form-discovery");
    const dry = await engine.applyFormBindings!(doc, plan, { name: "Lee" }, { dryRun: true });
    expect(dry.document).toBeUndefined();
    const body = fetcher.mock.calls[1]?.[1]?.body as FormData;
    expect(fetcher.mock.calls[1]?.[0]).toBe("http://host/api/form-bindings");
    expect(JSON.parse(String(body.get("plan")))).toEqual(plan); expect(JSON.parse(String(body.get("values")))).toEqual({ name: "Lee" }); expect(body.get("dryRun")).toBe("true");
    expect((await engine.applyFormBindings!(doc, plan, { name: "Lee" })).document?.data).toEqual(new Uint8Array([3, 4]));
  });
  it("gates both Tauri commands on explicit capability and sends the documented arguments", async () => {
    let capable = false;
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "hwped_capabilities") return { version: "2.0.0", editable: true, formats: ["hwpx"], ...(capable ? { formBindings: "v1" } : {}) };
      if (cmd === "hwped_discover_forms") return discovery;
      if (cmd === "hwped_apply_form_bindings") return result((args?.options as { dryRun: boolean }).dryRun === false);
      throw new Error("unexpected command");
    });
    const engine = createTauriEngine(invoke as TauriInvoke, { workspaceRoot: "/workspace", pathOf: () => "docs/form.hwpx" });
    await expect(engine.discoverForms!(doc)).rejects.toThrow(/capability/);
    await expect(engine.applyFormBindings!(doc, plan, { name: "Lee" })).rejects.toThrow(/capability/);
    expect(invoke.mock.calls.every(([cmd]) => cmd === "hwped_capabilities")).toBe(true);
    capable = true;
    await engine.discoverForms!(doc);
    expect(invoke).toHaveBeenLastCalledWith("hwped_discover_forms", { document: { name: doc.name, path: "docs/form.hwpx" }, workspaceRoot: "/workspace" });
    await engine.applyFormBindings!(doc, plan, { name: "Lee" }, { dryRun: true });
    expect(invoke).toHaveBeenLastCalledWith("hwped_apply_form_bindings", { document: { name: doc.name, path: "docs/form.hwpx" }, workspaceRoot: "/workspace", plan, values: { name: "Lee" }, options: { name: doc.name, dryRun: true } });
    expect((await engine.applyFormBindings!(doc, plan, { name: "Lee" })).document?.name).toBe(doc.name);
  });
  it("refuses malformed versions and inconsistent published dry-run responses", async () => {
    const engine = createHttpEngine("http://host", { fetch: vi.fn(async () => Response.json(result(true))) });
    await expect(engine.applyFormBindings!(doc, plan, { name: "Lee" }, { dryRun: true })).rejects.toThrow(/mismatch/);
    const bad = createHttpEngine("http://host", { fetch: vi.fn(async () => Response.json({ ...discovery, version: 2 })) });
    await expect(bad.discoverForms!(doc)).rejects.toThrow(/version/);
  });
});
