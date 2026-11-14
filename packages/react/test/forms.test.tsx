import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormDiscovery, FormApplyResult, FormBindingPlan, FormApplyOptions, DocumentHandle } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { createMockEngine } from "./mock-engine.js";
import { en, ko } from "../src/messages.js";

afterEach(cleanup);
const hash = "a".repeat(64), id = `occ-${hash}`;
const original = { name: "source.hwpx", data: new Uint8Array([1]) };
const bound = { name: "source.hwpx", data: new Uint8Array([2]) };
const discovery: FormDiscovery = { version: 1, source_sha256: hash, structural_sha256: hash, occurrences: [{ id, kind: "placeholder", label: "Name", paragraph_id: "p", section: 0, indices: [0], model_route: "body", table_id: null, table_index: null, row: null, col: null, start: 0, end: 4, old_text: "Name", prior_sha256: hash, bindable: true, cause: null, next_step: null, label_occurrences: 1, label_ambiguous: false }] };
function engineFor(capable = true, targets = discovery) {
  const engine = createMockEngine();
  vi.spyOn(engine, "capabilities").mockResolvedValue({ version: "2.0.0", editable: true, formats: ["hwpx"], ...(capable ? { formBindings: "v1" } : {}) });
  return Object.assign(engine, {
    discoverForms: vi.fn(async () => targets),
    applyFormBindings: vi.fn(async (_doc: DocumentHandle, plan: FormBindingPlan, values: Record<string, string>, options?: FormApplyOptions): Promise<FormApplyResult> => ({
      receipt: { version: 1, source_sha256: hash, plan_sha256: hash, values_sha256: hash, output_sha256: hash, published: options?.dryRun !== true, occurrence_ids: [id], targets: 1, cloned_profiles: 0, native_warning_count: 0, semantic_budget: "selected_text_and_declared_clones_only", render_font_native: "unverified" },
      preview: { version: 1, source_sha256: hash, plan_sha256: hash, values_sha256: hash, copies: [], native_warnings: [], changes: [{ occurrence_id: id, copy: 0, profile_id: null, paragraph_id: "p", section: 0, indices: [0], row: null, col: null, start: 0, end: 4, old_text: "Name", new_text: values[id]!, max_chars: plan.bindings[0]!.targets[0]!.max_chars, allow_reflow: true }] },
      ...(options?.dryRun === true ? {} : { document: bound }),
    })),
  });
}
describe.each([["en", en], ["ko", ko]] as const)("Form panel %s", (locale, t) => {
  it("requires explicit selection and budgets, dry-runs then applies the exact reviewed plan", async () => {
    const engine = engineFor(), onChange = vi.fn();
    render(<HwpEditor engine={engine} file={original} locale={locale} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("tab", { name: t["tabs.forms"] }));
    expect(engine.discoverForms).toHaveBeenCalledWith(original);
    expect(engine.applyFormBindings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(t["forms.select"]));
    fireEvent.change(screen.getByLabelText(t["forms.value"]), { target: { value: "Lee 😀" } });
    fireEvent.change(screen.getByLabelText(t["forms.maxChars"]), { target: { value: "8" } });
    fireEvent.click(screen.getByLabelText(t["forms.reflow"]));
    fireEvent.click(screen.getByRole("button", { name: t["forms.preview"] }));
    await screen.findByRole("button", { name: t["forms.apply"] });
    const plan = { version: 1, source_sha256: hash, structural_sha256: hash, bindings: [{ key: id, targets: [{ occurrence_id: id, copies: [0], max_chars: 8, allow_reflow: true }] }], repeats: [], constraints: [] };
    expect(engine.applyFormBindings).toHaveBeenCalledWith(original, plan, { [id]: "Lee 😀" }, { dryRun: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t["forms.apply"] }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(engine.applyFormBindings).toHaveBeenLastCalledWith(original, plan, { [id]: "Lee 😀" }, { dryRun: false });
  });
  it("invalidates preview on input changes and refuses values over max_chars before any engine call", async () => {
    const engine = engineFor(); render(<HwpEditor engine={engine} file={original} locale={locale} />);
    fireEvent.click(await screen.findByRole("tab", { name: t["tabs.forms"] }));
    fireEvent.click(screen.getByLabelText(t["forms.select"]));
    fireEvent.click(screen.getByRole("button", { name: t["forms.preview"] }));
    await screen.findByRole("button", { name: t["forms.apply"] });
    fireEvent.change(screen.getByLabelText(t["forms.value"]), { target: { value: "too long" } });
    expect(screen.queryByRole("button", { name: t["forms.apply"] })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t["forms.preview"] }));
    await screen.findByRole("alert");
    expect(engine.applyFormBindings).toHaveBeenCalledTimes(1);
  });
});
it("hides forms when host capability is absent or discovery is empty", async () => {
  const engine = engineFor(false);
  const view = render(<HwpEditor engine={engine} file={original} />);
  await waitFor(() => expect(engine.capabilities).toHaveBeenCalled());
  expect(screen.queryByRole("tab", { name: "Form" })).toBeNull(); expect(engine.discoverForms).not.toHaveBeenCalled();
  view.unmount();
  const empty = engineFor(true, { ...discovery, occurrences: [] }); render(<HwpEditor engine={empty} file={original} />);
  await waitFor(() => expect(empty.discoverForms).toHaveBeenCalled());
  expect(screen.queryByRole("tab", { name: "Form" })).toBeNull();
});

it("reports discovery failure with a visible next step", async () => {
  const engine = engineFor();
  engine.discoverForms.mockRejectedValueOnce(new Error("engine refused"));
  render(<HwpEditor engine={engine} file={original} />);
  expect(await screen.findByText(en["forms.discoveryFailed"])).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Form" })).toBeNull();
});
