import { createRef } from "react";
import type { HwpEditorHandle } from "../src/HwpEditor.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Capabilities, DocumentHandle, HwpEngine, TemplateInputs } from "@hwp-editor/core";
import { TEMPLATE_METHODS } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine, makeEnvelope } from "./mock-engine.js";

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
  expect((await screen.findByRole("alert")).textContent).toContain(en["templates.invalidList"]({variable:"rows"}));
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

it("builds typed scalar and list inputs without asking for data JSON", async () => {
  const engine=templateEngine() as HwpEngine;
  const template=vi.fn(async()=>({document:filled,report:{schema_version:"1.0",mode:"compose",deterministic:true}}));
  engine.template=template;
  render(<HwpEditor engine={engine} file={original} />);
  fireEvent.click(await screen.findByRole("tab",{name:en["tabs.templates"]}));
  await screen.findByLabelText("문서번호");
  const variables={title:{type:"string",default:"Hello"},budget:{type:"number",default:1},date:{type:"date",default:"2026-11-11"},enabled:{type:"bool",default:true},mode:{type:"enum",values:["A","B"],default:"A"},rows:{type:"list",fields:{name:{type:"string"},count:{type:"number"}},default:[{name:"sample",count:2}]}};
  const spec={version:"1.0",variables,source:{mode:"compose",document:{}}};
  const file=new File(["{}"],"typed.json",{type:"application/json"});
  Object.defineProperty(file,"text",{value:async()=>JSON.stringify(spec)});
  fireEvent.change(screen.getByLabelText(en["templates.specLabel"]),{target:{files:[file]}});
  expect((await screen.findByLabelText("budget") as HTMLInputElement).type).toBe("number");
  expect((screen.getByLabelText("date") as HTMLInputElement).type).toBe("date");
  expect((screen.getByLabelText("enabled") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("mode") as HTMLSelectElement).value).toBe("A");
  fireEvent.change(screen.getByLabelText(en["templates.listFieldAria"]({row:1,field:"count"})),{target:{value:"3"}});
  fireEvent.click(screen.getByRole("button",{name:en["templates.previewSpec"]}));
  await waitFor(()=>expect(template).toHaveBeenCalledWith(spec,{version:"1.0",values:{title:"Hello",budget:1,date:"2026-11-11",enabled:true,mode:"A",rows:[{name:"sample",count:3}]}},original.name));
});

it("allows typed TemplateSpec on a host that omits document fill", async () => {
  const engine=templateEngine();
  delete (engine as HwpEngine).fill;
  render(<HwpEditor engine={engine} file={original} />);
  fireEvent.click(await screen.findByRole("tab",{name:en["tabs.templates"]}));
  expect((await screen.findByLabelText(en["templates.specLabel"]) as HTMLInputElement).disabled).toBe(false);
});

it("treats prototype-named document slots as input data", async () => {
  const engine=templateEngine("1.4.0",async()=>({items:[{key:"constructor",label:"Constructor slot",kind:"slot",required:true}]}));
  render(<HwpEditor engine={engine} file={original} />);
  fireEvent.click(await screen.findByRole("tab",{name:en["tabs.templates"]}));
  const input=await screen.findByLabelText("Constructor slot");
  expect((input as HTMLInputElement).value).toBe("");
  fireEvent.change(input,{target:{value:"safe"}});
  fireEvent.click(screen.getByRole("button",{name:en["templates.previewFill"]}));
  await waitFor(()=>expect(engine.fill).toHaveBeenCalledWith(original,{constructor:"safe"}));
});

it("refuses queue and normal apply mid-replacement, leaving exactly one undo", async () => {
  const engine=templateEngine();
  const originalRead=engine.read;
  let finishRead: ((value: ReturnType<typeof makeEnvelope>) => void) | undefined;
  engine.read=vi.fn(document=>document===filled ? new Promise<ReturnType<typeof makeEnvelope>>(resolve=>{finishRead=resolve;}) : originalRead(document));
  const onChange=vi.fn(), onError=vi.fn(), ref=createRef<HwpEditorHandle>();
  render(<HwpEditor ref={ref} engine={engine} file={original} onChange={onChange} onError={onError} />);
  fireEvent.click(await screen.findByRole("tab",{name:en["tabs.templates"]}));
  fireEvent.change(await screen.findByLabelText("문서번호"),{target:{value:"2026-101"}});
  fireEvent.click(screen.getByRole("button",{name:en["templates.previewFill"]}));
  fireEvent.click(await screen.findByRole("button",{name:en["templates.apply"]}));
  await waitFor(()=>expect(finishRead).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("tab",{name:en["tabs.fields"]}));
  const field=await screen.findByLabelText(en["fields.fieldValueAria"]({name:"date"}));
  expect((field as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(field,{target:{value:"2026-11-11"}});
  const queue=screen.getByRole("button",{name:en["fields.setValue"]});
  expect((queue as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(queue);
  const apply=screen.getByRole("button",{name:en["toolbar.applying"],exact:true});
  expect((apply as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(apply);
  await ref.current!.apply();
  expect(engine.calls.edit).toEqual([]);
  finishRead!(makeEnvelope());
  await waitFor(()=>expect(onChange).toHaveBeenLastCalledWith(filled));
  expect(onError).not.toHaveBeenCalled();
  const pendingZero=en["toolbar.pendingEdits"]({count:0});
  expect(screen.getByLabelText(pendingZero).textContent).toBe(pendingZero);
  fireEvent.click(screen.getByRole("button",{name:en["toolbar.revert"]}));
  await waitFor(()=>expect(onChange).toHaveBeenLastCalledWith(original));
  expect((screen.getByRole("button",{name:en["toolbar.revert"]}) as HTMLButtonElement).disabled).toBe(true);
});

it("submits unchecked required bool variables and new list bool fields as false", async () => {
  const engine=templateEngine() as HwpEngine;
  const template=vi.fn(async()=>({document:filled,report:{schema_version:"1.0",mode:"compose",deterministic:true}}));
  engine.template=template;
  render(<HwpEditor engine={engine} file={original} />);
  fireEvent.click(await screen.findByRole("tab",{name:en["tabs.templates"]}));
  await screen.findByLabelText("문서번호");
  const spec={version:"1.0",variables:{approved:{type:"bool",required:true},preset:{type:"bool",default:true},rows:{type:"list",fields:{accepted:{type:"bool",required:true},preset:{type:"bool",default:true}}}},source:{mode:"compose",document:{}}};
  const file=new File(["{}"],"bools.json",{type:"application/json"});
  Object.defineProperty(file,"text",{value:async()=>JSON.stringify(spec)});
  fireEvent.change(screen.getByLabelText(en["templates.specLabel"]),{target:{files:[file]}});
  expect((await screen.findByLabelText("approved") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("preset") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:en["templates.listAdd"]}));
  expect((screen.getByLabelText(en["templates.listFieldAria"]({row:1,field:"accepted"})) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:en["templates.previewSpec"]}));
  await waitFor(()=>expect(template).toHaveBeenCalledWith(spec,{version:"1.0",values:{approved:false,preset:true,rows:[{accepted:false,preset:true}]}},original.name));
});
