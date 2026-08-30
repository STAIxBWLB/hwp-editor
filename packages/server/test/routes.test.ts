import { describe, expect, it } from "vitest";

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
      return { version: "0.8.8", editable: true, formats: ["hwp", "hwpx"] };
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
    expect(body.version).toBe("0.8.8");
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

  it("a protected document is a 422 whose error.code is protected", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const engine = stubEngine({
      async edit() {
        throw new HwpCliError("protected", "encrypted document; hwp-cli refuses edit/compose");
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
        "hwp binary not found: /missing/hwp (install hwp-cli >= 0.8.8, or set HWP_EDITOR_BIN / the bin option)",
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
