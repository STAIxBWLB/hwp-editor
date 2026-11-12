import { malformedLayouts } from "./fixtures/layout.js";
import { readFileSync } from "node:fs";
import { RENDER_LAYOUT_NEXT_STEP } from "../src/layout.js";
/**
 * createTauriEngine tests with a mock invoke. Pin the bridge contract:
 * command names, payload shapes (protocol.ts mirroring + opsArgv fragments),
 * the path-vs-base64 transfer convention, and error wrapping.
 */
import { describe, expect, it } from "vitest";
import { base64 } from "../src/http-engine.js";
import type { DocumentHandle, EditOp, HwpErrorCode } from "../src/index.js";
import { HwpEngineError, isHwpEngineError } from "../src/index.js";
import { createTauriEngine, type TauriInvoke } from "../src/tauri.js";
import { STOPPED_WITHOUT_DIAGNOSTIC } from "../src/index.js";
import { DRIFT, MIXED_CONFLICT, RANGE_TAG, RUN_CONFLICT, UNMATCHED } from "./fixtures/refusal-stderr.js";

interface Call {
  cmd: string;
  args?: Record<string, unknown> | undefined;
}

function mockInvoke(responses: Record<string, unknown>): {
  invoke: TauriInvoke;
  calls: Call[];
} {
  const calls: Call[] = [];
  const invoke: TauriInvoke = <T>(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === "hwped_capabilities" && !(cmd in responses)) return Promise.resolve({version:"0.20.0",editable:true,formats:["hwp","hwpx"]} as T);
    if (cmd in responses) return Promise.resolve(responses[cmd] as T);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  };
  return { invoke, calls };
}

const doc: DocumentHandle = {
  name: "회의록.hwpx",
  data: new TextEncoder().encode("bytes"),
};

describe("createTauriEngine transfer convention", () => {
  it("sends workspace-relative paths when pathOf resolves one", async () => {
    const envelope = { markdown: "# 제목", segments: [] };
    const { invoke, calls } = mockInvoke({ hwped_read: envelope });
    const engine = createTauriEngine(invoke, {
      workspaceRoot: "/work",
      pathOf: (d) => `docs/${d.name}`,
    });
    await expect(engine.read(doc)).resolves.toEqual(envelope);
    expect(calls[0]).toEqual({
      cmd: "hwped_read",
      args: {
        document: { name: "회의록.hwpx", path: "docs/회의록.hwpx" },
        workspaceRoot: "/work",
      },
    });
  });

  it("falls back to base64 bytes when pathOf returns undefined", async () => {
    const { invoke, calls } = mockInvoke({
      hwped_validate: { valid: true, errors: [] },
    });
    const engine = createTauriEngine(invoke);
    await expect(engine.validate(doc)).resolves.toEqual({
      valid: true,
      errors: [],
    });
    expect(calls[0]?.args?.["document"]).toEqual({
      name: "회의록.hwpx",
      dataBase64: base64.encode(doc.data),
    });
    expect(calls[0]?.args).not.toHaveProperty("workspaceRoot");
  });
});

describe("createTauriEngine commands", () => {
  it("render passes options through and decodes page bytes", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const { invoke, calls } = mockInvoke({
      hwped_render: {
        pages: [
          {
            page: 1,
            width: 595,
            height: 842,
            dpi: 96,
            format: "svg",
            dataBase64: base64.encode(png),
          },
        ],
      },
    });
    const engine = createTauriEngine(invoke);
    const pages = await engine.render(doc, { pages: "1-2", dpi: 144 });
    expect(calls[0]?.cmd).toBe("hwped_render");
    expect(calls[0]?.args?.["options"]).toEqual({ pages: "1-2", dpi: 144 });
    expect(pages).toEqual([
      { page: 1, width: 595, height: 842, dpi: 96, format: "svg", data: png },
    ]);
  });

  it("preserves layout from a capable Tauri host", async () => {
    const layout = { width_pt: 600, height_pt: 800, truncated: false, rows: [
      { id: "para-1", kind: "para", box: null, source_chars: null },
      { id: "para-1", kind: "para", box: { x0: 10, y0: 20, x1: 200, y1: 40 }, source_chars: { start: 2, end: 6 } },
    ] };
    const { invoke } = mockInvoke({ hwped_render: { pages: [{
      page: 3, width: 1200, height: 1600, dpi: 144, format: "png", dataBase64: "AQI=", layout,
    }] } });
    const [page] = await createTauriEngine(invoke).render(doc);
    expect(page?.layout).toEqual(layout);
    expect(page?.data).toEqual(new Uint8Array([1, 2]));
  });

  it("edit serializes ops via opsToArgv and forwards flags", async () => {
    const edited = new Uint8Array([9, 9]);
    const { invoke, calls } = mockInvoke({
      hwped_edit: { name: doc.name, dataBase64: base64.encode(edited) },
    });
    const engine = createTauriEngine(invoke);
    const ops: EditOp[] = [{ kind: "replace", find: "구교재", replace: "신교재" }];
    const result = await engine.edit(doc, ops, {
      verify: true,
      allowPartial: true,
    });
    const edit = calls.find(call => call.cmd === "hwped_edit");
    expect(edit).toBeDefined();
    expect(edit?.args).not.toHaveProperty("ops");
    expect(edit?.args?.["opsArgv"]).toEqual([
      "--replace",
      "구교재=>신교재",
    ]);
    expect(edit?.args?.["verify"]).toBe(true);
    expect(edit?.args?.["allowPartial"]).toBe(true);
    expect(result).toEqual({ name: doc.name, data: edited });
  });

  it("forwards the report opt-in, parses the answer, and leaves it absent otherwise", async () => {
    const edited = new Uint8Array([8]);
    const report = JSON.parse(
      readFileSync(new URL("./fixtures/edit-report-insert-table.json", import.meta.url), "utf8"),
    ) as unknown;

    // Asked for and answered: the flag crosses the bridge and the report comes
    // back parsed, so a host on Tauri can select what an insertion created.
    const asked = mockInvoke({
      hwped_edit: { name: doc.name, dataBase64: base64.encode(edited), report },
    });
    const withReport = await createTauriEngine(asked.invoke).edit(doc, [], { report: true });
    expect(asked.calls.find(call => call.cmd === "hwped_edit")?.args?.["report"]).toBe(true);
    expect(withReport.report?.contract).toBe("hwp-edit-report-v1");
    expect(withReport.data).toEqual(edited);
    // The host's report names where it staged the document, which is no more a
    // caller's business on this transport than it is over HTTP.
    expect(withReport.report?.output).toBe(doc.name);
    expect(JSON.stringify(withReport.report)).not.toContain("/tmp/t21-table.hwpx");

    // Not asked: no flag, and no report invented for the caller.
    const unasked = mockInvoke({
      hwped_edit: { name: doc.name, dataBase64: base64.encode(edited), report },
    });
    const withoutReport = await createTauriEngine(unasked.invoke).edit(doc, []);
    expect(unasked.calls.find(call => call.cmd === "hwped_edit")?.args).not.toHaveProperty("report");
    expect(withoutReport.report).toBeUndefined();

    // Asked but the host answers without one, or with an unreadable one: the
    // edit still stands and the ids stay unknown.
    for (const answer of [
      { name: doc.name, dataBase64: base64.encode(edited) },
      { name: doc.name, dataBase64: base64.encode(edited), report: { contract: "something-else" } },
    ]) {
      const host = mockInvoke({ hwped_edit: answer });
      const result = await createTauriEngine(host.invoke).edit(doc, [], { report: true });
      expect(result.report).toBeUndefined();
      expect(result.data).toEqual(edited);
    }
  });

  /**
   * t12-a9: a preset batch needs BOTH flags, and the report's verdict, on this
   * transport too. The HTTP client and the CLI engine obeyed one core rule and
   * this client obeyed none of it, so a desktop host aborted the whole edit on
   * a table-less document and lost the body-style update.
   */
  const presetCaps = { version: "1.4.0", editable: true, formats: ["hwp", "hwpx"], editOps: "v1" };
  const presetBatch: EditOp[] = [
    { kind: "update-style", style: 7, size: "12" },
    { kind: "style-tables", preset: "official" },
  ];
  const presetOutcomes = (ops: { op: string; status: "applied" | "failed"; pieces?: number; reason?: string }[]) => ({
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "/tmp/staged/once.hwpx",
    dry_run: false,
    ops: ops.map((outcome, index) => ({
      index,
      op: outcome.op,
      status: outcome.status,
      pieces_touched: outcome.pieces ?? 0,
      changed: [],
      reason: outcome.reason ?? null,
    })),
    applied_count: ops.filter((outcome) => outcome.status === "applied").length,
    failed_count: ops.filter((outcome) => outcome.status === "failed").length,
  });

  it("t12-a9: asks for allowPartial and report for a preset batch, whatever the caller passed", async () => {
    const host = mockInvoke({
      hwped_capabilities: presetCaps,
      hwped_edit: {
        name: doc.name,
        dataBase64: base64.encode(new Uint8Array([7])),
        report: presetOutcomes([
          { op: "update_style", status: "applied", pieces: 1 },
          { op: "style_tables", status: "failed", reason: "style_tables: no styleable table" },
        ]),
      },
    });
    const result = await createTauriEngine(host.invoke).edit(doc, presetBatch, { verify: true });
    const args = host.calls.find(call => call.cmd === "hwped_edit")?.args;
    // The caller asked for neither; the batch needs both.
    expect(args?.["allowPartial"]).toBe(true);
    expect(args?.["report"]).toBe(true);
    // The preset's own miss is not a failed edit: the document is published
    // and the report says which op was skipped.
    expect(result.data).toEqual(new Uint8Array([7]));
    expect(result.report?.ops[1]?.reason).toContain("no styleable table");
  });

  it("t12-a9: refuses a preset batch the host published with another op unapplied", async () => {
    const host = mockInvoke({
      hwped_capabilities: presetCaps,
      hwped_edit: {
        name: doc.name,
        dataBase64: base64.encode(new Uint8Array([7])),
        report: presetOutcomes([
          { op: "update_style", status: "failed", reason: "update_style: no match or no change" },
          { op: "style_tables", status: "applied", pieces: 1 },
        ]),
      },
    });
    const error = await createTauriEngine(host.invoke).edit(doc, presetBatch, {}).catch((e: unknown) => e);
    expect(isHwpEngineError(error)).toBe(true);
    expect((error as HwpEngineError).code).toBe("bad_request");
    expect((error as HwpEngineError).message).toContain("no match or no change");
    expect((error as HwpEngineError).message).toContain("apply again");
  });

  it("t12-a9: refuses a preset batch whose host answers without a readable report", async () => {
    for (const answer of [
      { name: doc.name, dataBase64: base64.encode(new Uint8Array([7])) },
      { name: doc.name, dataBase64: base64.encode(new Uint8Array([7])), report: { contract: "something-else" } },
    ]) {
      const host = mockInvoke({ hwped_capabilities: presetCaps, hwped_edit: answer });
      const error = await createTauriEngine(host.invoke).edit(doc, presetBatch, {}).catch((e: unknown) => e);
      expect(isHwpEngineError(error)).toBe(true);
      expect((error as HwpEngineError).code).toBe("unavailable");
      expect((error as HwpEngineError).message).toContain("edit-report-v1");
    }
  });

  it("compose sends the spec verbatim and decodes the document", async () => {
    const bytes = new Uint8Array([7]);
    const report = { warnings: [] };
    const { invoke, calls } = mockInvoke({
      hwped_compose: { name: "out.hwpx", dataBase64: base64.encode(bytes), report },
    });
    const engine = createTauriEngine(invoke);
    const spec = { version: "2.0", document: { sections: [] } };
    const result = await engine.compose(spec as never, "out.hwpx");
    expect(calls[0]?.args).toEqual({ spec, name: "out.hwpx" });
    expect(result.document).toEqual({ name: "out.hwpx", data: bytes });
    expect(result.report).toEqual(report);
  });

  it("capabilities hits hwped_capabilities with no payload", async () => {
    const caps = { version: "0.16.0", editable: true, formats: ["hwp", "hwpx"] };
    const { invoke, calls } = mockInvoke({ hwped_capabilities: caps });
    const engine = createTauriEngine(invoke);
    await expect(engine.capabilities()).resolves.toEqual({ ...caps, templateMethods: [] });
    expect(calls[0]).toEqual({ cmd: "hwped_capabilities", args: {} });
  });
});

/** Reject `hwped_capabilities` with `value` and hand back the thrown error. */
async function rejectionOf(value: unknown): Promise<unknown> {
  const invoke: TauriInvoke = () => Promise.reject(value);
  const engine = createTauriEngine(invoke);
  return await engine.capabilities().then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

describe("createTauriEngine errors", () => {
  it("wraps invoke rejections with the command name", async () => {
    const invoke: TauriInvoke = () =>
      Promise.reject("cli_missing: hwp is not available");
    const engine = createTauriEngine(invoke);
    await expect(engine.capabilities()).rejects.toThrow(
      "hwped_capabilities failed: cli_missing: hwp is not available",
    );
  });

  // Every prefix maru can emit (dev/maru/src-tauri/src/hwped.rs), plus the
  // two shapes with no prefix at all. A maru cli_missing must land on the
  // same code an HTTP 503 does, or success criterion 1 is false.
  const PREFIX_CASES: readonly (readonly [string, HwpErrorCode])[] = [
    ["cli_missing: hwp is not available", "unavailable"],
    ["hwp_spawn_failed: No such file or directory", "unavailable"],
    ["hwp_timeout: hwp render timed out after 60000ms", "timeout"],
    ["hwp_aborted: cancelled by the host", "failed"],
    ["hwp_failed: hwp exited with status 1", "failed"],
    ["hwp_version: 0.15.1 is older than 0.16.0", "version"],
    ["hwped_bad_request: document is missing", "bad_request"],
    ["hwped_task_failed: task join error", "failed"],
    ["hwp_stage_failed: could not create temp dir", "internal"],
    ["hwp_parse_failed: not a valid hwpx container", "failed"],
    ["something else", "failed"],
    ["", "failed"],
  ];

  it.each(PREFIX_CASES)("maps the rejection %j to %s", async (detail, code) => {
    const err = await rejectionOf(detail);
    expect(isHwpEngineError(err)).toBe(true);
    expect((err as HwpEngineError).code).toBe(code);
    expect((err as HwpEngineError).message).toBe(
      `hwped_capabilities failed: ${detail}`,
    );
    expect((err as HwpEngineError).cause).toBe(detail);
  });

  it("prefers a structured { code, message } rejection over prefix parsing", async () => {
    const raw = { code: "protected", message: "document is protected" };
    const err = (await rejectionOf(raw)) as HwpEngineError;
    expect(err.code).toBe("protected");
    expect(err.message).toBe("hwped_capabilities failed: document is protected");
    expect(err.cause).toBe(raw);
  });

  it("reads refusal and insertion from a structured rejection through the validators (#88)", async () => {
    const good = (await rejectionOf({ code: "failed", message: "x", refusal: "range_tag", insertion: { kind: "invalid_definition" } })) as HwpEngineError;
    expect(good.refusal).toBe("range_tag");
    expect(good.insertion).toEqual({ kind: "invalid_definition" });
    const bad = (await rejectionOf({ code: "failed", message: "x", refusal: "bogus", insertion: { kind: "nope" } })) as HwpEngineError;
    expect(bad.refusal).toBeUndefined();
    expect(bad.insertion).toBeUndefined();
  });

  it("narrows an unknown structured code to internal instead of casting it in", async () => {
    const err = (await rejectionOf({ code: "not-a-real-code" })) as HwpEngineError;
    expect(err.code).toBe("internal");
  });

  it("carries no own status: there is no HTTP status on this transport", async () => {
    const err = (await rejectionOf("hwp_timeout: too slow")) as HwpEngineError;
    expect("status" in err).toBe(false);
  });
});

/**
 * Regression: the Tauri transport used to lose `protected` entirely.
 *
 * maru's vocabulary (dev/maru/src-tauri/src/hwped.rs) has no
 * protected-specific prefix, so a refusal on a 배포용 document arrives under
 * `hwp_failed:` and `prefixToCode` can only read it as `failed`. Downstream,
 * `engineErrorKind` (packages/react/src/errors.ts) returns as soon as it
 * recognises a code and never reads the prose, so the Korean markers in
 * `classifyEngineError` were never consulted and the badge disappeared. The
 * pre-existing structured-`{ code: "protected" }` test could not catch this:
 * that branch is dead until maru moves off `Result<T, String>`.
 */
describe("createTauriEngine protection backstop", () => {
  const rejectWith = (detail: string): TauriInvoke => <T>(cmd: string) => cmd === "hwped_capabilities"
    ? Promise.resolve({version:"0.20.0",editable:true,formats:["hwp","hwpx"]} as T)
    : Promise.reject(detail);

  const MARKER_CASES: readonly (readonly [string, string])[] = [
    ["암호화된 문서", "encrypted document; hwp-cli refuses edit/compose"],
    ["DRM", "DRM-protected document; hwp-cli refuses edit/compose"],
    ["서명된 문서", "signed document; hwp-cli refuses edit/compose"],
    [
      "배포용 문서",
      "distribution (배포용) document; hwp-cli refuses edit/compose",
    ],
  ];

  it.each(MARKER_CASES)(
    "upgrades an edit refusal carrying %j to protected",
    async (marker, message) => {
      const engine = createTauriEngine(
        rejectWith(`hwp_failed: hwp exited with status 1: ${marker}는 편집할 수 없습니다`),
      );
      const err = (await engine
        .edit(doc, [{ kind: "replace", find: "가", replace: "나" }])
        .then(() => null, (e: unknown) => e)) as HwpEngineError;
      expect(err.code).toBe("protected");
      expect(err.message).toBe(`hwped_edit failed: ${message}`);
    },
  );

  it("upgrades a compose refusal the same way", async () => {
    const engine = createTauriEngine(
      rejectWith("hwp_failed: 배포용 문서에는 쓸 수 없습니다"),
    );
    const err = (await engine
      .compose({ version: "2.0", document: { sections: [] } } as never, "out.hwpx")
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.code).toBe("protected");
    expect(err.message).toBe(
      "hwped_compose failed: distribution (배포용) document; hwp-cli refuses edit/compose",
    );
  });

  // D-11, mirrored from the CLI server: hwp-cli can still READ documents it
  // refuses to edit, so a read/render failure is a real failure. Relabelling
  // it protected would send the user to the wrong remedy.
  it("leaves a read refusal alone even when it carries a marker", async () => {
    const engine = createTauriEngine(
      rejectWith("hwp_failed: 배포용 문서 처리 중 오류"),
    );
    const err = (await engine.read(doc).then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.code).toBe("failed");
  });

  // Only `failed` is upgraded: a timeout that happens to name a marker is a
  // timeout, not a protection refusal.
  it("does not upgrade a non-failed code that mentions a marker", async () => {
    const engine = createTauriEngine(
      rejectWith("hwp_timeout: 배포용 문서 편집이 60000ms 후 시간 초과"),
    );
    const err = (await engine
      .edit(doc, [{ kind: "replace", find: "가", replace: "나" }])
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.code).toBe("timeout");
  });

  it("leaves an unmarked edit failure as failed, with its detail intact", async () => {
    const detail = "hwp_failed: hwp exited with status 1: 지원하지 않는 HWP 버전입니다";
    const engine = createTauriEngine(rejectWith(detail));
    const err = (await engine
      .edit(doc, [{ kind: "replace", find: "가", replace: "나" }])
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.code).toBe("failed");
    expect(err.message).toBe(`hwped_edit failed: ${detail}`);
  });
});


it("rejects addressed edits before invoking the legacy Tauri host", async () => {
  const calls: string[] = [];
  const invoke: TauriInvoke = async <T>(cmd: string) => {
    calls.push(cmd);
    return {} as T;
  };
  await expect(createTauriEngine(invoke).edit({ name: "test.hwpx", data: new Uint8Array() }, [
    { kind: "set-format", address: { at: { section: 0, paragraph: 1, run: 0 }, chars: [0, 3] }, props: { bold: "on" } },
  ])).rejects.toThrow(/JSON transport/);
  expect(calls).toEqual(["hwped_capabilities"]);
});

describe("Tauri present layout validation", () => {
  it.each(malformedLayouts)("rejects malformed $field before exposing page geometry", async ({value,field}) => {
    const {invoke}=mockInvoke({hwped_render:{pages:[{page:1,width:600,height:800,dpi:96,format:"png",dataBase64:base64.encode(new Uint8Array([1])),layout:value}]}});
    const failure=await createTauriEngine(invoke).render(doc).catch((error:unknown)=>error);
    expect(failure).toMatchObject({code:"failed",message:expect.stringContaining(field)});
    expect((failure as Error).message).toContain(RENDER_LAYOUT_NEXT_STEP);
  });
});

describe("Tauri JSON edit channel", () => {
  const caps={version:"1.4.0",editable:true,formats:["hwp","hwpx"],editOps:"v1"};
  it("sends only ops with addresses and literal separators when v1 is advertised", async () => {
    const {invoke,calls}=mockInvoke({hwped_capabilities:caps,hwped_edit:{name:doc.name,dataBase64:"AQI="}});
    const engine=createTauriEngine(invoke,{workspaceRoot:"/work",pathOf:()=>"docs/source.hwpx"});
    expect((await engine.capabilities()).editOps).toBe("v1");
    await engine.edit(doc,[
      {kind:"replace",find:"가=>나:@",replace:"값=다"},
      {kind:"set-format",address:{id:"run-1",chars:[1,4]},props:{bold:"on"}},
    ],{verify:true,allowPartial:false});
    const edits=calls.filter(call=>call.cmd==="hwped_edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.args).toEqual({document:{name:doc.name,path:"docs/source.hwpx"},workspaceRoot:"/work",ops:[
      {op:"replace",from:"가=>나:@",to:"값=다"},
      {op:"set_format",address:{id:"run-1",chars:[1,4]},bold:"on"},
    ],verify:true,allowPartial:false});
    expect(edits[0]!.args).not.toHaveProperty("opsArgv");
  });
  it("does not retry the legacy channel after a JSON edit fails", async () => {
    const calls:Call[]=[];
    const invoke:TauriInvoke=<T>(cmd:string,args?:Record<string,unknown>)=>{
      calls.push({cmd,args});
      if(cmd==="hwped_capabilities")return Promise.resolve(caps as T);
      return Promise.reject("hwped_bad_request: ops is refused");
    };
    await expect(createTauriEngine(invoke).edit(doc,[{kind:"set-format",address:{id:"run-1"},props:{bold:"on"}}])).rejects.toMatchObject({code:"bad_request"});
    expect(calls.filter(call=>call.cmd==="hwped_edit")).toHaveLength(1);
    expect(calls.find(call=>call.cmd==="hwped_edit")!.args).not.toHaveProperty("opsArgv");
  });
  it("omits unimplemented capability versions and uses the legacy channel", async () => {
    const {invoke,calls}=mockInvoke({hwped_capabilities:{...caps,editOps:"v2"},hwped_edit:{name:doc.name,dataBase64:"AQI="}});
    const engine=createTauriEngine(invoke);
    expect(await engine.capabilities()).not.toHaveProperty("editOps");
    await engine.edit(doc,[{kind:"set-field",name:"title",value:"x"}]);
    expect(calls.find(call=>call.cmd==="hwped_edit")!.args).toMatchObject({opsArgv:["--set-field","title=x"]});
  });
});

it("does not advertise or silently drop unsupported Tauri image bytes", async () => {
  const {invoke,calls}=mockInvoke({hwped_capabilities:{version:"1.4.0",editable:true,editOps:"v1",imageAssets:"v1",formats:["hwpx"],templateMethods:["slots","template"]}});
  const engine=createTauriEngine(invoke);
  const caps = await engine.capabilities();
  expect(caps).not.toHaveProperty("imageAssets");
  expect(caps).toMatchObject({editOps:"v1",templateMethods:["slots","template"]});
  await expect(engine.edit(doc,[{kind:"insert-image",anchor:"x",path:"x.png"}],{assets:[{name:"x.png",data:new Uint8Array([1])}]})).rejects.toThrow(/unsupported.*Tauri.*HTTP/);
  expect(calls.filter(call=>call.cmd==="hwped_edit")).toEqual([]);
});

describe("Tauri edit refusal classification (#80)", () => {
  const reject = (detail: string): TauriInvoke => <T>(cmd: string): Promise<T> =>
    cmd === "hwped_capabilities"
      ? Promise.resolve({ version: "0.20.0", editable: true, formats: ["hwp", "hwpx"] } as T)
      : Promise.reject(detail);

  it.each([
    [UNMATCHED, "unmatched_replace"],
    [RUN_CONFLICT, "run_range_conflict"],
    [DRIFT, "run_range_conflict"],
    [RANGE_TAG, "range_tag"],
  ] as const)("marks maru's hwp_failed edit with the HTTP marker (%#)", async (stderr, kind) => {
    const raw = `hwp_failed: hwp edit failed (exit 3): /tmp/stage-1/in.hwp\n${stderr}`;
    const engine = createTauriEngine(reject(raw));
    const err = (await engine.edit(doc, [{ kind: "replace", find: "a", replace: "b" }])
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.code).toBe("failed");
    // The same message shape the HTTP transport sends, and nothing of stderr.
    expect(err.message).toBe(`hwped_edit failed: hwp edit failed (exit 3): edit refused: ${kind}`);
    expect(err.refusal).toBe(kind);
    expect(err.message).not.toContain("/tmp/");
    expect(err.message).not.toContain("Error:");
    // The engine cause is kept for an operator.
    expect(err.cause).toBe(raw);
  });

  it("words an unclassified edit failure as HTTP does: the engine's Error: line and the step (t37-a2)", async () => {
    const raw = `hwp_failed: hwp edit failed (exit 3): ${MIXED_CONFLICT}`;
    const err = (await createTauriEngine(reject(raw)).edit(doc, [{ kind: "replace", find: "a", replace: "b" }])
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.message).toBe(
      "hwped_edit failed: hwp edit failed (exit 3): 주소 지정 편집이 서로 충돌합니다. " +
      "Fix or remove the pending edit it names, then apply again.",
    );
    expect(err.cause).toBe(raw);
    expect(err.refusal).toBeUndefined();
  });

  it("says the engine stopped and to apply again when it wrote no stderr (t34-a1)", async () => {
    const raw = "hwp_failed: hwp edit failed (exit 101): ";
    const err = (await createTauriEngine(reject(raw)).edit(doc, [{ kind: "replace", find: "a", replace: "b" }])
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.code).toBe("failed");
    expect(err.message).toBe(
      "hwped_edit failed: hwp edit failed (exit 101): the engine stopped without writing a diagnostic " +
      "(most likely it was killed or ran out of memory), so nothing was applied. " +
      "Apply again; if it fails the same way, report it with the host log.",
    );
    expect(err.message).not.toContain("refused");
    expect(err.message).not.toContain("last pending edit");
    expect(err.refusal).toBeUndefined();
    expect(err.cause).toBe(raw);
  });

  it("sets no refusal when the user's own value ends an unclassified stderr (#82)", async () => {
    // add_table's anchor is printed with Display, last on stderr (hwp-convert edit.rs:2107).
    const raw = "hwp_failed: hwp edit failed (exit 3): Error: 앵커를 찾을 수 없습니다: x edit refused: range_tag";
    const err = (await createTauriEngine(reject(raw)).edit(doc, [{ kind: "replace", find: "a", replace: "b" }])
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.refusal).toBeUndefined();
  });
});

describe("Tauri insert_blocks parity with HTTP (#88)", () => {
  const reject = (detail: string): TauriInvoke => <T>(cmd: string): Promise<T> =>
    cmd === "hwped_capabilities"
      ? Promise.resolve({ version: "0.20.0", editable: true, formats: ["hwp", "hwpx"], editOps: "v1" } as T)
      : Promise.reject(detail);
  const INSERT: EditOp[] = [{
    kind: "insert-blocks", address: { at: { section: 0, paragraph: 0 } }, position: "after",
    blocks: [{ type: "paragraph", runs: [{ type: "text", text: "x" }] }],
  }];

  it("sets insertion and writes the server's cause line, with no raw stderr", async () => {
    const stderr = "note: staged /tmp/stage/in.hwpx\nError: 스타일 '결재란 셀'을 대상 문서에서 찾을 수 없습니다. " +
      "styles 정의를 제공하고 missing_style=create로 다시 시도하거나 hwp styles에서 기존 스타일을 선택하세요";
    const err = (await createTauriEngine(reject(`hwp_failed: hwp edit failed (exit 3): ${stderr}`)).edit(doc, INSERT)
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.insertion).toEqual({ kind: "unknown_style", style: "결재란 셀" });
    expect(err.message).toBe("hwped_edit failed: hwp edit failed (exit 3): insert_blocks refused: unknown_style; 결재란 셀");
    expect(err.message).not.toContain("/tmp/");
  });

  it("writes the same stopped-without-diagnostic sentence as HTTP for empty stderr", async () => {
    const err = (await createTauriEngine(reject("hwp_failed: hwp edit failed (exit 1): ")).edit(doc, INSERT)
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.message).toBe(`hwped_edit failed: hwp edit failed (exit 1): ${STOPPED_WITHOUT_DIAGNOSTIC}`);
  });
});

describe("Tauri unclassified edit failures keep no path (t37-a2)", () => {
  const reject = (detail: string): TauriInvoke => <T>(cmd: string): Promise<T> =>
    cmd === "hwped_capabilities"
      ? Promise.resolve({ version: "0.20.0", editable: true, formats: ["hwp", "hwpx"], editOps: "v1" } as T)
      : Promise.reject(detail);

  it("redacts a staged path with spaces through its file name", async () => {
    const raw = "hwp_failed: hwp edit failed (exit 1): Error: failed to read /Users/a b/Library/Caches/in.hwpx at byte 3";
    const err = (await createTauriEngine(reject(raw)).edit(doc, [{ kind: "replace", find: "a", replace: "b" }])
      .then(() => null, (e: unknown) => e)) as HwpEngineError;
    expect(err.message).toBe(
      "hwped_edit failed: hwp edit failed (exit 1): failed to read <path> at byte 3. Fix or remove the pending edit it names, then apply again.",
    );
    expect(err.message).not.toMatch(/Users|Library|b\//u);
    expect(err.cause).toBe(raw);
  });
});

/**
 * #97 item 1: the Tauri bridge publishes no `bodyTables` today, and that is the
 * fallback the table panel allows table editing under. These pin the two shapes
 * it can send once the host learns to count: a number survives, anything else
 * is dropped by the same core projection the HTTP client uses.
 */
describe("the read bridge's table count (#97)", () => {
  it("carries the host's table count to the caller", async () => {
    const envelope = { markdown: "x", segments: [], bodyTables: 2 };
    const { invoke } = mockInvoke({ hwped_read: envelope });
    await expect(createTauriEngine(invoke).read(doc)).resolves.toEqual(envelope);
  });

  it("drops a count that is not a non-negative integer", async () => {
    const { invoke } = mockInvoke({ hwped_read: { markdown: "x", segments: [], bodyTables: -1 } });
    expect(await createTauriEngine(invoke).read(doc)).not.toHaveProperty("bodyTables");
  });
});
