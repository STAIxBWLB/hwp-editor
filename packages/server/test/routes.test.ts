import { describe, expect, it } from "vitest";

import { STOPPED_WITHOUT_DIAGNOSTIC } from "@hwp-editor/core";
import type {
  DocumentHandle,
  EditOp,
  HwpEngine,
  PageImage,
  RenderOptions,
} from "@hwp-editor/core";

import { createHwpEditorHandler } from "../src/routes.js";
import { createSessionStore } from "../src/session.js";
import { hwpxBytes, jsonRequest, multipartRequest } from "./helpers.js";

/** Must pass routes.ts's magic-byte sniff, or every POST here is a 400. */
const DOC: DocumentHandle = {
  name: "sample.hwpx",
  data: hwpxBytes(),
};

/** In-memory HwpEngine stub — route shape tests do not need the binary. */
function stubEngine(overrides: Partial<HwpEngine> = {}): HwpEngine {
  return {
    async read() {
      return { markdown: "# hi", segments: [] };
    },
    async render(_doc: DocumentHandle, _options?: RenderOptions): Promise<PageImage[]> {
      return [
        { page: 1, width: 100, height: 200, dpi: 96, format: "svg", data: new Uint8Array([60]) },
      ];
    },
    async edit(document: DocumentHandle, ops: EditOp[]) {
      expect(Array.isArray(ops)).toBe(true);
      return { name: document.name, data: new Uint8Array([9, 9, 9]) };
    },
    async compose(_spec, name: string) {
      return { document: { name, data: new Uint8Array([7, 7]) }, report: { ok: true } };
    },
    async validate() {
      return { valid: true, errors: [] };
    },
    async capabilities() {
      return { version: "0.16.0", editable: true, formats: ["hwp", "hwpx"] };
    },
    ...overrides,
  };
}

const BASE = "http://localhost/api/hwp-editor";

describe("routes (stub engine)", () => {
  it("GET /capabilities returns engine capabilities", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(new Request(`${BASE}/capabilities`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("0.16.0");
    expect(body.editable).toBe(true);
  });

  it("POST /read returns the cat envelope", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markdown: "# hi", segments: [] });
  });

  it("POST /read without a file is a 400 ErrorResponse", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(multipartRequest(`${BASE}/read`, { nope: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
    expect(typeof body.error.message).toBe("string");
  });

  it("POST /render passes options through and base64-encodes pages", async () => {
    let seen: RenderOptions | undefined;
    const engine = stubEngine({
      async render(_doc, options) {
        seen = options;
        return [{ page: 2, width: 1, height: 1, dpi: 150, format: "png", data: new Uint8Array([1, 2]) }];
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(
      multipartRequest(`${BASE}/render`, { file: DOC, pages: "2", dpi: "150", format: "png" }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ pages: "2", dpi: 150, format: "png" });
    const body = await res.json();
    expect(body.pages[0].dataBase64).toBe(Buffer.from([1, 2]).toString("base64"));
    expect(body.pages[0].page).toBe(2);
  });

  it("POST /render preserves page layout geometry on the wire", async () => {
    const layout = {
      width_pt: 595, height_pt: 842, truncated: true,
      rows: [
        { id: "p2", kind: "para" as const, box: { x0: 50, y0: 70, x1: 120, y1: 85 }, source_chars: { start: 0, end: 6 } },
        { id: "p2", kind: "para" as const, box: null, source_chars: null },
      ],
    };
    const engine = stubEngine({
      async render() {
        return [{ page: 2, width: 794, height: 1123, dpi: 96, format: "png", data: new Uint8Array([1]), layout }];
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/render`, { file: DOC, pages: "2" }));
    expect(res.status).toBe(200);
    expect((await res.json()).pages[0].layout).toEqual(layout);
  });

  it("POST /render rejects a non-numeric dpi", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(multipartRequest(`${BASE}/render`, { file: DOC, dpi: "abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("POST /edit parses ops and returns the edited document", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const ops: EditOp[] = [{ kind: "replace", find: "a", replace: "b" }];
    const res = await handler(
      multipartRequest(`${BASE}/edit`, { file: DOC, ops: JSON.stringify(ops), verify: "true" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("sample.hwpx");
    expect(body.dataBase64).toBe(Buffer.from([9, 9, 9]).toString("base64"));
  });

  /**
   * The palette cannot select, reorder or remove what it inserted without the
   * ids, and they exist only in `edit-report-v1`. The route must therefore
   * forward the opt-in and carry the report, and must leave the field off —
   * not empty — when nobody asked, so a client never mistakes `null` ids for
   * "no segments were created".
   */
  it("POST /edit forwards the report opt-in and returns edit-report-v1", async () => {
    // `output` is path-shaped on purpose: the engine writes the report for the
    // `-o` path it was given, and that path is inside a work dir. A name must
    // come back instead, or the response tells a caller where the server
    // staged the document.
    const staged = "/var/folders/tmp/hwp-editor-abc123/out.hwpx";
    const report = {
      schema_version: "1.0",
      contract: "hwp-edit-report-v1" as const,
      output: staged,
      dry_run: false,
      ops: [{ index: 0, op: "insert_blocks", status: "applied" as const, pieces_touched: 1,
        changed: [{ before: null, after: "a84ac20e7a012e4a.0.2" }], reason: null,
        missing_style: "create" as const }],
      applied_count: 1,
      failed_count: 0,
    };
    let asked: boolean | undefined;
    const engine = stubEngine({
      async edit(_doc, _ops, options) {
        asked = options?.report;
        return { name: "sample.hwpx", data: Uint8Array.from([9, 9, 9]), ...(options?.report ? { report } : {}) };
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, ops: "[]", report: "true" }));
    expect(res.status).toBe(200);
    expect(asked).toBe(true);
    const answer = (await res.json()) as { report: typeof report };
    expect(answer.report).toEqual({ ...report, output: "sample.hwpx" });
    expect(JSON.stringify(answer)).not.toContain("/var/folders/tmp");

    const off = createHwpEditorHandler({ engine, sessions: false });
    const without = await off(multipartRequest(`${BASE}/edit`, { file: DOC, ops: "[]" }));
    expect((await without.json()).report).toBeUndefined();
  });

  it("POST /edit with malformed ops JSON is a 400", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    for (const bad of ["{nope", "{}", ""]) {
      const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, ops: bad }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });

  it("POST /compose accepts a JSON body and returns document + report", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(
      jsonRequest(`${BASE}/compose`, { spec: { version: "2.0", document: {} }, name: "out.hwpx" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("out.hwpx");
    expect(body.dataBase64).toBe(Buffer.from([7, 7]).toString("base64"));
    expect(body.report).toEqual({ ok: true });
  });

  it("POST /compose rejects a body without spec or name", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(
      jsonRequest(`${BASE}/compose`, { name: "out.hwpx" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST /validate returns the validation report", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(multipartRequest(`${BASE}/validate`, { file: DOC }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true, errors: [] });
  });

  it("unknown actions 404 and wrong methods 405", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const notFound = await handler(new Request(`${BASE}/explode`, { method: "POST" }));
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error.code).toBe("not_found");
    const wrongMethod = await handler(new Request(`${BASE}/read`));
    expect(wrongMethod.status).toBe(405);
    const postCapabilities = await handler(new Request(`${BASE}/capabilities`, { method: "POST" }));
    expect(postCapabilities.status).toBe(405);
  });

  it("engine failures map to non-2xx ErrorResponses", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const engine = stubEngine({
      async read() {
        throw new HwpCliError("failed", "boom");
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toEqual({ code: "failed", message: "boom" });
  });

  it("sends a classified edit refusal as its own error.refusal field (#82)", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const engine = stubEngine({
      async edit() {
        throw new HwpCliError("failed", "hwp edit failed (exit 3): edit refused: range_tag", "stderr", undefined, "range_tag");
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, ops: JSON.stringify([]) }));
    const body = await res.json();
    expect(body.error).toEqual({ code: "failed", message: "hwp edit failed (exit 3): edit refused: range_tag", refusal: "range_tag" });
  });

  it("sends the insert_blocks class as error.insertion (#88)", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const engine = stubEngine({
      async edit() {
        throw new HwpCliError("failed", "hwp edit failed (exit 3): insert_blocks refused: invalid_definition", "e", undefined, undefined, { kind: "invalid_definition" });
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, ops: JSON.stringify([]) }));
    const body = await res.json();
    expect(body.error.insertion).toEqual({ kind: "invalid_definition" });
    expect(body.error).not.toHaveProperty("refusal");
  });

  it("sends the stopped-without-diagnostic marker as error.stopped (#91)", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const message = `hwp edit failed (exit 137): ${STOPPED_WITHOUT_DIAGNOSTIC}`;
    const engine = stubEngine({
      async edit() {
        throw new HwpCliError("failed", message, "", undefined, undefined, undefined, true);
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, ops: JSON.stringify([]) }));
    const body = await res.json();
    expect(body.error).toEqual({ code: "failed", message, stopped: true });
    expect(body.error).not.toHaveProperty("refusal");
    expect(body.error).not.toHaveProperty("insertion");
  });

  it("sends no refusal field for an unclassified failure, whatever its message says (#82)", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const engine = stubEngine({
      async edit() {
        throw new HwpCliError("failed", "hwp edit failed (exit 3): edit refused: range_tag");
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, ops: JSON.stringify([]) }));
    const body = await res.json();
    expect(body.error).not.toHaveProperty("refusal");
  });

  it("a protected document is a 422 whose error.code is protected", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const engine = stubEngine({
      async edit() {
        throw new HwpCliError("protected", "encrypted document; remove the protection in a word processor that can open it, save a copy, then reopen that copy here");
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, ops: "[]" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("protected");
    expect(typeof body.error.message).toBe("string");
  });

  it("a missing binary is a clear 503 on every action, including capabilities", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const unavailable = async (): Promise<never> => {
      throw new HwpCliError(
        "unavailable",
        "hwp binary not found: /missing/hwp (install agent-hwp, whose command is `ahwp`, or set HWP_EDITOR_BIN / the bin option)",
      );
    };
    const engine = stubEngine({
      read: unavailable,
      capabilities: unavailable,
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });

    const caps = await handler(new Request(`${BASE}/capabilities`));
    expect(caps.status).toBe(503);
    const body = await caps.json();
    expect(body.error.code).toBe("unavailable");
    expect(body.error.message).toContain("hwp binary not found");
    expect(body.error.message).toContain("HWP_EDITOR_BIN");

    const read = await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(read.status).toBe(503);
    expect((await read.json()).error.code).toBe("unavailable");
  });

  it("an engine timeout is a 504", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const engine = stubEngine({
      async render() {
        throw new HwpCliError("timeout", "hwp render timed out after 60000ms");
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/render`, { file: DOC }));
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("timeout");
  });

  it("unexpected engine exceptions surface as 500", async () => {
    const engine = stubEngine({
      async validate() {
        throw new Error("surprise");
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/validate`, { file: DOC }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal");
  });
});

describe("routes + sessions (stub engine)", () => {
  it("edit creates no session: the server keeps no pre-edit copy (BUG-07)", async () => {
    const sessions = createSessionStore();
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions });
    const res = await handler(
      multipartRequest(`${BASE}/edit`, {
        file: { name: "doc.hwpx", data: hwpxBytes() },
        ops: JSON.stringify([{ kind: "replace", find: "a", replace: "b" }]),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).dataBase64).toBe(Buffer.from([9, 9, 9]).toString("base64"));
    expect(sessions.size()).toBe(0);
  });

  it("read attaches the inspection to a session — the one thing the store still does", async () => {
    const sessions = createSessionStore();
    const engine = Object.assign(stubEngine(), {
      async describe() {
        return {
          envelope: { markdown: "# described", segments: [] },
          fields: null,
          bookmarks: null,
          slots: null,
          info: null,
          capabilities: { editable: true },
        };
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions });
    const res = await handler(
      multipartRequest(`${BASE}/read`, { file: { name: "doc.hwpx", data: hwpxBytes() } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).markdown).toBe("# described");
    expect(sessions.size()).toBe(1);
    expect(sessions.get(sessions.ids()[0]!).inspection?.envelope.markdown).toBe("# described");
  });
});

describe("HTTP image asset admission", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  function request(parts: Array<{ name: string; data: Uint8Array }>, ops: EditOp[], extra?: (form: FormData) => void): Request {
    const form = new FormData();
    form.append("file", new Blob([DOC.data as BlobPart]), DOC.name);
    form.append("ops", JSON.stringify(ops));
    for (const part of parts) form.append("asset", new Blob([part.data as BlobPart]), part.name);
    extra?.(form);
    return new Request(`${BASE}/edit`, { method: "POST", body: form, headers: { "content-length": "1000" } });
  }

  it("passes matching uploaded bytes to a v1 engine", async () => {
    let seen: EditOp[] | undefined;
    let seenBytes: Uint8Array | undefined;
    const engine = stubEngine({
      async capabilities() { return { version: "1.0.0", editable: true, imageAssets: "v1", formats: ["hwp", "hwpx"] }; },
      async edit(_doc, ops, options) { seen = ops; seenBytes = options?.assets?.[0]?.data; return { name: "out.hwpx", data: png }; },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const ops: EditOp[] = [{ kind: "insert-image", anchor: "Figure", path: "figure.png" }];
    const res = await handler(request([{ name: "figure.png", data: png }], ops));
    expect(res.status).toBe(200);
    expect(seen).toEqual(ops);
    expect(seenBytes).toEqual(png);
  });

  it.each([
    { assets: [{ name: "../x.png", data: png }], ops: [{ kind: "insert-image", anchor: "x", path: "../x.png" } as EditOp] },
    { assets: [{ name: "x.png", data: png }, { name: "x.png", data: png }], ops: [{ kind: "insert-image", anchor: "x", path: "x.png" } as EditOp] },
    { assets: [{ name: "x.png", data: new Uint8Array([1, 2, 3]) }], ops: [{ kind: "insert-image", anchor: "x", path: "x.png" } as EditOp] },
    { assets: [{ name: "x.png", data: png }], ops: [{ kind: "insert-image", anchor: "x", path: "other.png" } as EditOp] },
  ])("rejects unsafe, duplicate, unsigned, and unreferenced assets before engine calls", async ({ assets, ops }) => {
    let calls = 0;
    const handler = createHwpEditorHandler({ engine: stubEngine({ async edit() { calls++; return { name: "x", data: png }; } }), sessions: false });
    const res = await handler(request(assets, ops));
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  /**
   * A mismatch has two shapes and they are not the same refusal (#58 item 7).
   * An upload no op names involves no path, so it is the caller's form to
   * correct: bad_request. An insert-image op naming a path no upload supplied
   * asks the server to read a local file: path_traversal.
   */
  it("answers an unreferenced upload as bad_request and a server-local path as path_traversal", async () => {
    let calls = 0;
    const handler = createHwpEditorHandler({ engine: stubEngine({ async edit() { calls++; return { name: "x", data: png }; } }), sessions: false });
    const unreferenced = await handler(request([{ name: "extra.png", data: png }], []));
    expect(unreferenced.status).toBe(400);
    expect(await unreferenced.json()).toMatchObject({
      error: { code: "bad_request", message: expect.stringMatching(/not referenced by any insert-image op.*remove the unreferenced upload/i) },
    });
    expect(calls).toBe(0);
    const local = await handler(request([{ name: "figure.png", data: png }], [{ kind: "insert-image", anchor: "x", path: "/etc/passwd.png" }]));
    expect(local.status).toBe(400);
    expect(await local.json()).toMatchObject({ error: { code: "path_traversal" } });
    expect(calls).toBe(0);
  });

  it("rejects missing assets, seal, and unsupported engines before edit", async () => {
    let calls = 0;
    const handler = createHwpEditorHandler({ engine: stubEngine({ async edit() { calls++; return { name: "x", data: png }; } }), sessions: false });
    const missing = await handler(request([], [{ kind: "insert-image", anchor: "x", path: "x.png" }]));
    const seal = await handler(request([], [{ kind: "seal", anchor: "x", path: "x.png", size: 20 }]));
    expect(missing.status).toBe(400);
    expect(seal.status).toBe(400);
    expect(calls).toBe(0);
    const unsupported = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await unsupported(request([{ name: "x.png", data: png }], [{ kind: "insert-image", anchor: "x", path: "x.png" }]));
    expect(res.status).toBe(400);
    // The next step names the upgrade first: on the CLI engine `imageAssets` is
    // withheld below 1.4.0 because that is the version this editor verifies
    // uploads against (#58 item 9), and "configure a host that advertises it"
    // alone sent the caller hunting for a different adapter (#58 item 31).
    expect(await res.json()).toMatchObject({
      error: { code: "bad_request", message: expect.stringMatching(/upgrade hwp-cli to 1\.4\.0 or newer/) },
    });
  });

  it("checks asset count and Blob.size before reading uploaded bytes", async () => {
    let calls = 0;
    const handler = createHwpEditorHandler({ engine: stubEngine({ async edit() { calls++; return { name: "x", data: png }; } }), sessions: false });
    const ops = Array.from({ length: 9 }, (_, i) => ({ kind: "insert-image" as const, anchor: `x${i}`, path: `x${i}.png` }));
    const tooMany = await handler(request(ops.map((op) => ({ name: op.path, data: png })), ops));
    expect(tooMany.status).toBe(400);
    const tooLarge = await handler(request([
      { name: "large.png", data: new Uint8Array(10 * 1024 * 1024 + 1) },
    ], [{ kind: "insert-image", anchor: "x", path: "large.png" }]));
    expect(tooLarge.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("rejects other file-valued multipart fields", async () => {
    let calls = 0;
    const handler = createHwpEditorHandler({ engine: stubEngine({ async edit() { calls++; return { name: "x", data: png }; } }), sessions: false });
    const res = await handler(request([], [], (form) => form.append("extra", new Blob([png]), "other.png")));
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("refuses authorization before reading multipart or calling the engine", async () => {
    let calls = 0;
    let buffered = false;
    const denied = new Request(`${BASE}/edit`, { method: "POST", body: "unused", headers: { "content-length": "100" } });
    Object.defineProperty(denied, "formData", { value: async () => { buffered = true; throw new Error("should not parse"); } });
    const handler = createHwpEditorHandler({
      engine: stubEngine({ async edit() { calls++; return { name: "x", data: png }; } }),
      authorize: async () => null,
      sessions: false,
    });
    expect((await handler(denied)).status).toBe(403);
    expect(buffered).toBe(false);
    expect(calls).toBe(0);
  });
});

it("permits reuse of one uploaded image by multiple insertions", async () => {
  const png=new Uint8Array([137,80,78,71,13,10,26,10]);
  const form=new FormData();
  form.append("file",new Blob([DOC.data as BlobPart]),DOC.name);
  form.append("asset",new Blob([png]),"same.png");
  const ops=[{kind:"insert-image",anchor:"first",path:"same.png"},{kind:"insert-image",anchor:"second",path:"same.png"}];
  form.append("ops",JSON.stringify(ops));
  let received:unknown;
  const handler=createHwpEditorHandler({sessions:false,engine:stubEngine({capabilities:async()=>({version:"1.4.0",editable:true,formats:["hwpx"],imageAssets:"v1"}),edit:async(document,actual)=>{received=actual;return document;}})});
  const response=await handler(new Request(`${BASE}/edit`,{method:"POST",body:form,headers:{"content-length":"1000"}}));
  expect(response.status).toBe(200); expect(received).toEqual(ops);
});
