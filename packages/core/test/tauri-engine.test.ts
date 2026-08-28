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
    expect(calls[0]?.cmd).toBe("hwped_edit");
    expect(calls[0]?.args?.["opsArgv"]).toEqual([
      "--replace",
      "구교재=>신교재",
    ]);
    expect(calls[0]?.args?.["verify"]).toBe(true);
    expect(calls[0]?.args?.["allowPartial"]).toBe(true);
    expect(result).toEqual({ name: doc.name, data: edited });
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
    const caps = { version: "0.8.8", editable: true, formats: ["hwp", "hwpx"] };
    const { invoke, calls } = mockInvoke({ hwped_capabilities: caps });
    const engine = createTauriEngine(invoke);
    await expect(engine.capabilities()).resolves.toEqual(caps);
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
    ["hwp_version: 0.8.6 is older than 0.8.8", "version"],
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

  it("narrows an unknown structured code to internal instead of casting it in", async () => {
    const err = (await rejectionOf({ code: "not-a-real-code" })) as HwpEngineError;
    expect(err.code).toBe("internal");
  });

  it("carries no own status: there is no HTTP status on this transport", async () => {
    const err = (await rejectionOf("hwp_timeout: too slow")) as HwpEngineError;
    expect("status" in err).toBe(false);
  });
});
