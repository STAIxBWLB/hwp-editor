import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { FormBindingPlan } from "@hwp-editor/core";
import { createFormCommands } from "../src/form-engine.js";
import { HwpCliError } from "../src/cli-engine.js";

const hash = "a".repeat(64), id = `occ-${hash}`;
const document = { name: "form.hwpx", data: new Uint8Array([1]) };
const discovery = { version: 1, source_sha256: hash, structural_sha256: hash, occurrences: [{ id, kind: "cell_text", label: "", paragraph_id: "p", section: 0, indices: [0], model_route: "body", table_id: "t", table_index: 0, row: 0, col: 0, start: 0, end: 2, old_text: "AB", prior_sha256: hash, bindable: true, cause: null, next_step: null, label_occurrences: 0, label_ambiguous: false }] };
const plan: FormBindingPlan = { version: 1, source_sha256: hash, structural_sha256: hash, bindings: [{ key: "value", targets: [{ occurrence_id: id, max_chars: 5, allow_reflow: false }] }] };
async function commands(test: (engine: ReturnType<typeof createFormCommands>, run: ReturnType<typeof vi.fn>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hwp-form-refusal-"));
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "slots") return JSON.stringify(discovery);
    throw new HwpCliError("failed", "unclassified length equal sum numeric budget stale unsupported", "PRIVATE_TEXT");
  });
  const engine = createFormCommands({ version: async () => "2.0.0", work: async fn => fn(dir), stage: async () => join(dir, "in.hwpx"), run });
  try { await test(engine, run); } finally { await rm(dir, { recursive: true, force: true }); }
}
describe("content-free form refusal classes", () => {
  it("does not guess a native class from unclassified prose", async () => {
    await commands(async (engine, run) => {
      const error = await engine.applyFormBindings(document, plan, { value: "AB" }, { dryRun: true }).catch(error => error);
      expect(error.message).toContain("(engine_refused)");
      expect(error.message).not.toMatch(/character_budget|numeric_constraint|stale_source|PRIVATE_TEXT/);
      const edit = run.mock.calls.find(([args]) => args[0] === "edit")![0];
      expect(edit).not.toContain("--report");
      expect(edit).toContain("--dry-run");
    });
  });
  it("classifies growth from fresh typed source/value data before invoking edit", async () => {
    await commands(async (engine, run) => {
      await expect(engine.applyFormBindings(document, plan, { value: "ABCDE" }, { dryRun: true })).rejects.toThrow(/growth_without_reflow; limit=2.*allow reflow.*within 2 characters/);
      expect(run.mock.calls.some(([args]) => args[0] === "edit")).toBe(false);
    });
  });
  it("does not use a stale catalogue to assign a growth cause", async () => {
    await commands(async (engine) => {
      await expect(engine.applyFormBindings(document, { ...plan, source_sha256: "b".repeat(64) }, { value: "ABCDE" })).rejects.toThrow(/engine_refused/);
    });
  });
});
