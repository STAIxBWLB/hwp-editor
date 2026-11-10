import { describe, expect, it } from "vitest";
import { createHttpEngine, base64 } from "../src/http-engine.js";
import { createTauriEngine, type TauriInvoke } from "../src/tauri.js";
import type { DocumentHandle } from "../src/engine.js";

const doc: DocumentHandle = { name: "서식.hwpx", data: new TextEncoder().encode("doc") };
const bytes = new Uint8Array([1, 2, 3]);
const b64 = base64.encode(bytes);
const fillReport = { replaced: 1, counts: { 이름: 1 } };
const inputs = { items: [{ key: "이름", label: "이름", kind: "slot", required: true }] };
const lint = { findings: [{ rule_id: "R1", severity: "warning", line: 1, col: 0, message: "확인" }] };

function httpEngine(responseFor: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const engine = createHttpEngine("/api", {
    fetch: ((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify(responseFor(String(url), init ?? {}))));
    }) as typeof fetch,
  });
  return { engine, calls };
}

describe("HTTP template transport", () => {
  it("forwards all template wires and normalizes reports", async () => {
    const { engine, calls } = httpEngine((url) => {
      if (url.endsWith("/slots")) return inputs;
      if (url.endsWith("/fill")) return { name: "filled.hwpx", dataBase64: b64, report: fillReport };
      if (url.endsWith("/lint")) return lint;
      if (url.endsWith("/templates")) return [{ id: "gongmun-basic", label: "공문" }];
      if (url.endsWith("/create")) return { name: "new.hwpx", dataBase64: b64 };
      if (url.endsWith("/template")) return { name: "made.hwpx", dataBase64: b64, report: { schema_version: "1.0", mode: "compose", deterministic: true } };
      return {};
    });
    expect(await engine.slots?.(doc)).toEqual(inputs);
    expect(await engine.fill?.(doc, { 이름: "영준" })).toEqual({ document: { name: "filled.hwpx", data: bytes }, report: fillReport });
    expect(await engine.lint?.(doc, "report")).toEqual(lint);
    expect(await engine.listTemplates?.()).toEqual([{ id: "gongmun-basic", label: "공문" }]);
    expect(await engine.create?.("gongmun-basic", "new.hwpx")).toEqual({ name: "new.hwpx", data: bytes });
    const spec = { version: "1.0" } as never;
    const data = {} as never;
    await engine.template?.(spec, data, "made.hwpx");
    const fillForm = calls.find((call) => call.url.endsWith("/fill"))?.init.body as FormData;
    expect(fillForm.get("values")).toBe(JSON.stringify({ 이름: "영준" }));
    expect(calls.find((call) => call.url.endsWith("/lint"))?.init.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith("/template"))?.init.body))).toEqual({ spec, data, name: "made.hwpx" });
  });

  it("refuses malformed fill and lint reports with field causes", async () => {
    const { engine } = httpEngine((url) => url.endsWith("/fill")
      ? { name: "x.hwpx", dataBase64: b64, report: { replaced: "one", counts: {} } }
      : { findings: [{ rule_id: "R", severity: "unknown", line: 1, col: 0, message: "bad" }] });
    await expect(engine.fill?.(doc, {})).rejects.toThrow("fill.replaced");
    await expect(engine.lint?.(doc)).rejects.toThrow("finding.severity");
  });

  it("refuses malformed template reports", async () => {
    const { engine } = httpEngine(() => ({ name: "out.hwpx", dataBase64: b64, report: { warnings: [] } }));
    await expect(engine.template?.({} as never, {} as never, "out.hwpx")).rejects.toThrow("template.schema_version/mode/deterministic");
  });

  it("defaults missing templateMethods to an empty list for older hosts", async () => {
    const { engine } = httpEngine(() => ({ version: "1.3.0", editable: true, formats: ["hwpx"] }));
    await expect(engine.capabilities()).resolves.toMatchObject({ templateMethods: [] });
  });
});

describe("Tauri template transport", () => {
  it("forwards commands with document scope and parses replies", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const responses: Record<string, unknown> = {
      hwped_slots: inputs,
      hwped_fill: { name: "filled.hwpx", dataBase64: b64, report: fillReport },
      hwped_lint: lint,
      hwped_list_templates: [{ id: "gongmun-basic", label: "공문" }],
      hwped_create: { name: "new.hwpx", dataBase64: b64 },
      hwped_template: { name: "made.hwpx", dataBase64: b64, report: { schema_version: "1.0", mode: "compose", deterministic: true } },
    };
    const invoke: TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args: args ?? {} });
      return Promise.resolve(responses[cmd] as T);
    };
    const engine = createTauriEngine(invoke, { workspaceRoot: "/work", pathOf: () => "docs/source.hwpx" });
    expect(await engine.slots?.(doc)).toEqual(inputs);
    expect(await engine.fill?.(doc, { 이름: "영준" })).toMatchObject({ document: { name: "filled.hwpx" }, report: fillReport });
    expect(await engine.lint?.(doc, "gongmun")).toEqual(lint);
    expect(await engine.listTemplates?.()).toEqual([{ id: "gongmun-basic", label: "공문" }]);
    expect(await engine.create?.("gongmun-basic", "new.hwpx")).toMatchObject({ name: "new.hwpx" });
    await engine.template?.({} as never, {} as never, "made.hwpx");
    expect(calls[1]).toEqual({ cmd: "hwped_fill", args: { document: { name: "서식.hwpx", path: "docs/source.hwpx" }, values: { 이름: "영준" }, workspaceRoot: "/work" } });
  });

  it("refuses malformed reports and defaults old host advertisement", async () => {
    const invoke: TauriInvoke = <T>(cmd: string) => Promise.resolve((cmd === "hwped_fill"
      ? { name: "x.hwpx", dataBase64: b64, report: { replaced: -1, counts: {} } }
      : { version: "1.3.0", editable: true, formats: [] }) as T);
    const engine = createTauriEngine(invoke);
    await expect(engine.fill?.(doc, {})).rejects.toThrow("fill.replaced");
    await expect(engine.capabilities()).resolves.toMatchObject({ templateMethods: [] });
  });

  it("refuses malformed template reports", async () => {
    const invoke: TauriInvoke = <T>(cmd: string) => Promise.resolve((cmd === "hwped_template"
      ? { name: "x.hwpx", dataBase64: b64, report: { warnings: [] } }
      : {}) as T);
    const engine = createTauriEngine(invoke);
    await expect(engine.template?.({} as never, {} as never, "x.hwpx")).rejects.toThrow("template.schema_version/mode/deterministic");
  });

  it("names an unimplemented template command as unsupported by the host", async () => {
    const invoke: TauriInvoke = () => Promise.reject(new Error("unknown command hwped_slots"));
    const engine = createTauriEngine(invoke);
    await expect(engine.slots?.(doc)).rejects.toThrow("unsupported by this host");
    await expect(engine.slots?.(doc)).rejects.toThrow("upgrade the host");
  });
});
