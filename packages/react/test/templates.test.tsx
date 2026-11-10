import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Capabilities, DocumentHandle, HwpEngine, TemplateInputs } from "@hwp-editor/core";
import { TEMPLATE_METHODS } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const original: DocumentHandle = { name: "source.hwpx", data: new TextEncoder().encode("source") };
const filled: DocumentHandle = { name: "filled.hwpx", data: new TextEncoder().encode("filled") };
const inputs: TemplateInputs = { items: [
  { key: "document_no", label: "문서번호", kind: "slot", required: true },
  { key: "approval", label: "결재 상태", kind: "field", required: false },
] };

function templateEngine(version = "1.4.0", slotLoader?: (doc: DocumentHandle) => Promise<TemplateInputs>) {
  const base = createMockEngine();
  const methods = Object.fromEntries(TEMPLATE_METHODS.map((name) => [name, vi.fn()])) as Partial<HwpEngine>;
  const engine = Object.assign(base, methods, {
    slots: vi.fn(slotLoader ?? (async () => inputs)),
    fill: vi.fn(async () => ({ document: filled, report: { replaced: 2, counts: { slot: 1, field: 1 } } })),
    lint: vi.fn(async () => ({ findings: [] })),
    listTemplates: vi.fn(async () => [{ id: "gongmun-basic", label: "공문" }]),
    create: vi.fn(async () => filled),
  });
  const capabilities: Capabilities = {
    version,
    editable: true,
    formats: ["hwpx"],
    templateMethods: version === "1.4.0" ? [...TEMPLATE_METHODS] : [],
  };
  vi.spyOn(engine, "capabilities").mockResolvedValue(capabilities);
  return engine;
}

describe.each([["en", en], ["ko", ko]] as const)("template panels locale=%s", (locale, t) => {
  it("explains when the host version is too old", async () => {
    const engine = templateEngine("1.3.9");
    render(<HwpEditor locale={locale} engine={engine} file={original} />);
    fireEvent.click(await screen.findByRole("tab", { name: t["tabs.templates"] }));
    expect(await screen.findByText(new RegExp("1\\.4\\.0"))).toBeTruthy();
    expect(screen.getByText((text) => text.includes(t["templates.remedy"]))).toBeTruthy();
    expect(engine.slots).not.toHaveBeenCalled();
  });

  it("explains when a current host omits a method", async () => {
    const engine = templateEngine();
    Object.defineProperty(engine, "slots", { value: undefined });
    render(<HwpEditor locale={locale} engine={engine} file={original} />);
    fireEvent.click(await screen.findByRole("tab", { name: t["tabs.templates"] }));
    expect(await screen.findByText((text) => text.includes(t["templates.methodSlots"]))).toBeTruthy();
    expect(screen.getByText((text) => text.includes(t["templates.remedy"]))).toBeTruthy();
  });

  it("previews without changing the store, then applies as one undo step", async () => {
    const engine = templateEngine();
    const onChange = vi.fn();
    render(<HwpEditor locale={locale} engine={engine} file={original} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("tab", { name: t["tabs.templates"] }));
    const input = await screen.findByLabelText("문서번호");
    fireEvent.change(input, { target: { value: "2026-001" } });
    fireEvent.change(screen.getByLabelText("결재 상태"), { target: { value: "승인" } });
    fireEvent.click(screen.getByRole("button", { name: t["templates.previewFill"] }));
    await screen.findByRole("button", { name: t["templates.apply"] });
    expect(engine.fill).toHaveBeenCalledWith(original, { document_no: "2026-001", approval: "승인" });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t["templates.apply"] }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(filled));
    expect((screen.getByRole("button", { name: t["toolbar.revert"] }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: t["toolbar.revert"] }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(original));
  });

  it("keeps template application disabled in read-only mode", async () => {
    const engine = templateEngine();
    render(<HwpEditor locale={locale} engine={engine} file={original} readOnly />);
    fireEvent.click(await screen.findByRole("tab", { name: t["tabs.templates"] }));
    const input = await screen.findByLabelText("문서번호");
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: t["templates.previewFill"] }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("ignores slot results from a document that was replaced during the request", async () => {
  let finishOld: ((value: TemplateInputs) => void) | undefined;
  const engine = templateEngine("1.4.0", (doc) => doc.name === original.name
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ items: [{ key: "current_only", label: "Current field", kind: "slot", required: false }] }));
  const { rerender } = render(<HwpEditor engine={engine} file={original} />);
  fireEvent.click(await screen.findByRole("tab", { name: en["tabs.templates"] }));
  rerender(<HwpEditor engine={engine} file={filled} />);
  await screen.findByLabelText("Current field");
  finishOld?.({ items: [{ key: "stale", label: "Stale field", kind: "slot", required: false }] });
  await waitFor(() => expect(screen.queryByLabelText("Stale field")).toBeNull());
});

it("refuses a malformed list default before rendering list fields", async () => {
  render(<HwpEditor engine={templateEngine()} file={original} />);
  fireEvent.click(await screen.findByRole("tab", {name:en["tabs.templates"]}));
  await screen.findByLabelText("문서번호");
  const file=new File(["{}"],"bad.json",{type:"application/json"});
  Object.defineProperty(file,"text",{value:async()=>JSON.stringify({version:"1.0",variables:{rows:{type:"list",fields:{name:{type:"string"}},default:[null]}},source:{mode:"compose",document:{}}})});
  fireEvent.change(screen.getByLabelText(en["templates.specLabel"]),{target:{files:[file]}});
  expect(await screen.findByText(en["templates.invalidList"]({variable:"rows"}))).toBeTruthy();
  expect(screen.queryByRole("button",{name:en["templates.listAdd"]})).toBeNull();
});

it("explains missing host methods even on a recent engine version", async () => {
  const engine=templateEngine();
  delete (engine as HwpEngine).slots;
  render(<HwpEditor engine={engine} file={original} />);
  fireEvent.click(await screen.findByRole("tab",{name:en["tabs.templates"]}));
  const message=en["templates.methodMissing"]({method:en["templates.methodSlots"]});
  expect(await screen.findByText((text)=>text.includes(message))).toBeTruthy();
});
