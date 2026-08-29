/**
 * Owns the route admission gate: the `authorize` hook (SEC-01), the option
 * pass-through through the Next.js factory (SEC-02) and the pre-buffer size
 * cap (SEC-03).
 *
 * Deliberately needs no binary. It drives the real handler over the in-memory
 * `stubEngine` shape copied from routes.test.ts:20-46, so a refusal can be
 * proven by asserting the engine was never entered — which is the provable
 * form of "refused before the body was buffered" (D-04).
 *
 * The describe titles `authorize`, `next forwards` and `size cap` are the
 * selectors 04-VALIDATION.md runs SEC-01/02/03 with. `vitest -t` matches
 * describe and it titles, so renaming one reports green against zero tests.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  DocumentHandle,
  EditOp,
  HwpEngine,
  PageImage,
  RenderOptions,
} from "@hwp-editor/core";

import { createHwpEditorRoutes } from "../src/next.js";
import { createHwpEditorHandler, type AuthorizeFn, type HwpAction } from "../src/routes.js";
import { hwpBytes, hwpxBytes, jsonRequest, multipartRequest } from "./helpers.js";

/**
 * Capture the options the handler hands its default engine. Only the locale
 * case constructs a default engine; every other test passes `engine`, so the
 * spy is inert for them.
 */
const cliEngineCalls: unknown[] = [];
vi.mock("../src/cli-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli-engine.js")>();
  return {
    ...actual,
    createCliEngine: (opts: unknown) => {
      cliEngineCalls.push(opts);
      return actual.createCliEngine(opts as Parameters<typeof actual.createCliEngine>[0]);
    },
  };
});

/** Must pass routes.ts's magic-byte sniff, or every POST here is a 400. */
const DOC: DocumentHandle = {
  name: "sample.hwpx",
  data: hwpxBytes(),
};

const BASE = "http://localhost/api/hwp-editor";

/** In-memory HwpEngine stub — admission tests never reach the binary. */
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
    async edit(document: DocumentHandle, _ops: EditOp[]) {
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

/** Stub recording every entry, so an empty `calls` proves non-entry. */
function countingEngine(): { engine: HwpEngine; calls: string[] } {
  const calls: string[] = [];
  const engine = stubEngine({
    async read() {
      calls.push("read");
      return { markdown: "# hi", segments: [] };
    },
    async render(): Promise<PageImage[]> {
      calls.push("render");
      return [
        { page: 1, width: 100, height: 200, dpi: 96, format: "svg", data: new Uint8Array([60]) },
      ];
    },
    async edit(document: DocumentHandle) {
      calls.push("edit");
      return { name: document.name, data: new Uint8Array([9, 9, 9]) };
    },
    async validate() {
      calls.push("validate");
      return { valid: true, errors: [] };
    },
    async capabilities() {
      calls.push("capabilities");
      return { version: "0.8.8", editable: true, formats: ["hwp", "hwpx"] };
    },
  });
  return { engine, calls };
}

/** authorize that refuses everything, recording the actions it saw. */
function denyAll(): { authorize: AuthorizeFn; seen: HwpAction[]; requests: Request[] } {
  const seen: HwpAction[] = [];
  const requests: Request[] = [];
  const authorize: AuthorizeFn = async (req, action) => {
    seen.push(action);
    requests.push(req);
    return null;
  };
  return { authorize, seen, requests };
}

describe("authorize", () => {
  it("refuses POST /read with 403 forbidden before the body is buffered", async () => {
    const { engine, calls } = countingEngine();
    const { authorize, seen } = denyAll();
    const handler = createHwpEditorHandler({ engine, sessions: false, authorize });
    const res = await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "forbidden" } });
    expect(calls).toEqual([]);
    expect(seen).toEqual(["read"]);
  });

  it("refuses GET /capabilities too — it discloses the binary version", async () => {
    const { engine, calls } = countingEngine();
    const { authorize, seen } = denyAll();
    const handler = createHwpEditorHandler({ engine, sessions: false, authorize });
    const res = await handler(new Request(`${BASE}/capabilities`));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(calls).toEqual([]);
    expect(seen).toEqual(["capabilities"]);
  });

  it("admits the request when the hook returns a scope string", async () => {
    const handler = createHwpEditorHandler({
      engine: stubEngine(),
      sessions: false,
      authorize: async () => "tenant-a",
    });
    const res = await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markdown: "# hi", segments: [] });
  });

  it("allows everything when no hook is supplied (D-02)", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const read = await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(read.status).toBe(200);
    const caps = await handler(new Request(`${BASE}/capabilities`));
    expect(caps.status).toBe(200);
    expect((await caps.json()).version).toBe("0.8.8");
  });

  it("is called once per request with the live Request and the action name", async () => {
    const seen: HwpAction[] = [];
    const requests: Request[] = [];
    const handler = createHwpEditorHandler({
      engine: stubEngine(),
      sessions: false,
      authorize: async (req, action) => {
        seen.push(action);
        requests.push(req);
        return "s";
      },
    });
    await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    await handler(new Request(`${BASE}/capabilities`));
    expect(seen).toEqual(["read", "capabilities"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(new URL(requests[0]!.url).pathname.endsWith("/read")).toBe(true);
  });

  it("gives two concurrent requests their own call with their own Request", async () => {
    const requests: Request[] = [];
    const handler = createHwpEditorHandler({
      engine: stubEngine(),
      sessions: false,
      authorize: async (req) => {
        requests.push(req);
        // Yield, so the two calls genuinely interleave.
        await new Promise((r) => setTimeout(r, 0));
        return "s";
      },
    });
    const [a, b] = await Promise.all([
      handler(multipartRequest(`${BASE}/read`, { file: DOC })),
      handler(multipartRequest(`${BASE}/validate`, { file: DOC })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    const paths = requests.map((r) => new URL(r.url).pathname.split("/").pop()).sort();
    expect(paths).toEqual(["read", "validate"]);
  });

  it("answers a wrong-method request 405 without calling the hook", async () => {
    const { authorize, seen } = denyAll();
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false, authorize });
    const res = await handler(new Request(`${BASE}/read`));
    expect(res.status).toBe(405);
    expect((await res.json()).error.message).toBe("read requires POST");
    expect(seen).toEqual([]);
  });

  it("answers an unknown action 404 without calling the hook", async () => {
    const { authorize, seen } = denyAll();
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false, authorize });
    const res = await handler(new Request(`${BASE}/explode`, { method: "POST" }));
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });
});

describe("next forwards", () => {
  it("carries authorize through createHwpEditorRoutes, refusing the same way", async () => {
    const { engine, calls } = countingEngine();
    const { authorize } = denyAll();
    const { POST } = createHwpEditorRoutes({ engine, sessions: false, authorize });
    const res = await POST(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(calls).toEqual([]);
  });

  it("carries authorize through the GET handler as well", async () => {
    const { engine, calls } = countingEngine();
    const { authorize } = denyAll();
    const { GET } = createHwpEditorRoutes({ engine, sessions: false, authorize });
    const res = await GET(new Request(`${BASE}/capabilities`));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("called with no argument behaves like createHwpEditorHandler({})", async () => {
    // No engine, no bin: the default CliEngine is constructed either way, so
    // the observable equivalence is the routing shape, not an engine call.
    const routes = createHwpEditorRoutes();
    const direct = createHwpEditorHandler({});
    const viaRoutes = await routes.POST(new Request(`${BASE}/explode`, { method: "POST" }));
    const viaDirect = await direct(new Request(`${BASE}/explode`, { method: "POST" }));
    expect(viaRoutes.status).toBe(404);
    expect(await viaRoutes.json()).toEqual(await viaDirect.json());
  });
});

/**
 * Present `content-length` to the handler exactly as written, bypassing the
 * trimming a `Headers` object applies on `set`. `" 10"` cannot otherwise be
 * observed: Headers normalizes it to `"10"` before the handler ever sees it.
 */
function withRawContentLength(req: Request, raw: string): Request {
  const headers = {
    get: (name: string) =>
      name.toLowerCase() === "content-length" ? raw : req.headers.get(name),
  };
  return new Proxy(req, {
    get(target, prop) {
      if (prop === "headers") return headers;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Request;
}

describe("size cap", () => {
  it("admits a request whose Content-Length is exactly the cap", async () => {
    const { engine, calls } = countingEngine();
    const req = multipartRequest(`${BASE}/read`, { file: DOC });
    const declared = Number(req.headers.get("content-length"));
    expect(Number.isSafeInteger(declared)).toBe(true);
    const handler = createHwpEditorHandler({ engine, sessions: false, maxRequestBytes: declared });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["read"]);
  });

  it("refuses cap + 1 with 413 before the body is buffered", async () => {
    const { engine, calls } = countingEngine();
    const req = multipartRequest(`${BASE}/read`, { file: DOC });
    const declared = Number(req.headers.get("content-length"));
    const handler = createHwpEditorHandler({
      engine,
      sessions: false,
      maxRequestBytes: declared - 1,
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain(String(declared - 1));
    expect(calls).toEqual([]);
  });

  it("refuses a chunked body with no Content-Length", async () => {
    const { engine, calls } = countingEngine();
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const req = new Request(`${BASE}/read`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await handler(req);
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(parsed.error.code).toBe("bad_request");
    expect(parsed.error.message).toBe("content-length is required");
    expect(calls).toEqual([]);
  });

  it("refuses every Content-Length that is not a safe non-negative integer", async () => {
    const { engine, calls } = countingEngine();
    const handler = createHwpEditorHandler({ engine, sessions: false });
    for (const raw of ["1e9", " 10", "0x10", "-1", "Infinity", ""]) {
      const req = withRawContentLength(multipartRequest(`${BASE}/read`, { file: DOC }), raw);
      const res = await handler(req);
      expect(res.status, `content-length ${JSON.stringify(raw)}`).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("bad_request");
      expect(body.error.message).toBe("invalid content-length");
    }
    expect(calls).toEqual([]);
  });

  it("does not apply to GET /capabilities, which carries no Content-Length", async () => {
    const { engine, calls } = countingEngine();
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const req = new Request(`${BASE}/capabilities`);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["capabilities"]);
  });

  it("defaults to 50 MiB and refuses an ordinary upload at maxRequestBytes: 10", async () => {
    const { engine, calls } = countingEngine();
    const byDefault = createHwpEditorHandler({ engine, sessions: false });
    expect((await byDefault(multipartRequest(`${BASE}/read`, { file: DOC }))).status).toBe(200);

    const tiny = createHwpEditorHandler({ engine, sessions: false, maxRequestBytes: 10 });
    const res = await tiny(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.message).toContain("10 byte limit");

    const atDefault = createHwpEditorHandler({
      engine,
      sessions: false,
      maxRequestBytes: 52428800,
    });
    expect((await atDefault(multipartRequest(`${BASE}/read`, { file: DOC }))).status).toBe(200);
    expect(calls).toEqual(["read", "read"]);
  });

  it("forwards locale to the default engine (ERR-04)", () => {
    cliEngineCalls.length = 0;
    createHwpEditorHandler({ locale: "ko", bin: "/nonexistent/hwp", sessions: false });
    expect(cliEngineCalls).toEqual([{ bin: "/nonexistent/hwp", locale: "ko" }]);

    cliEngineCalls.length = 0;
    createHwpEditorHandler({ sessions: false });
    expect(cliEngineCalls).toEqual([{}]);
  });
});

/**
 * SEC-07. The sniff sits at the single buffering site, so a refusal is proven
 * the same way admission is: the counting engine was never entered.
 */
describe("sniff", () => {
  /** POST `bytes` to `action` and report the status plus the engine calls. */
  async function post(
    action: string,
    bytes: Uint8Array,
    fields: Record<string, string> = {},
  ): Promise<{ status: number; body: { error: { code: string; message: string } }; calls: string[] }> {
    const { engine, calls } = countingEngine();
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(
      multipartRequest(`${BASE}/${action}`, { file: { name: "x.hwpx", data: bytes }, ...fields }),
    );
    return { status: res.status, body: await res.json(), calls };
  }

  it("admits a CFBF buffer as an HWP5 document", async () => {
    const { status, calls } = await post("read", hwpBytes());
    expect(status).toBe(200);
    expect(calls).toEqual(["read"]);
  });

  it("admits a STORED first `mimetype` entry reading application/hwp+zip", async () => {
    const { status, calls } = await post("read", hwpxBytes());
    expect(status).toBe(200);
    expect(calls).toEqual(["read"]);
  });

  it("admits the same layout with a non-empty extra field", async () => {
    const { status, calls } = await post("read", hwpxBytes({ extraLen: 4 }));
    expect(status).toBe(200);
    expect(calls).toEqual(["read"]);
  });

  it("refuses a zip whose first entry is deflated rather than STORED", async () => {
    const { status, body, calls } = await post("read", hwpxBytes({ method: 8 }));
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe("file is not an HWP or HWPX document");
    expect(calls).toEqual([]);
  });

  it("refuses a zip whose first entry is not named mimetype", async () => {
    // Same eight-byte length, different name: the name check, not the length.
    const wrongName = await post("read", hwpxBytes({ name: "manifest" }));
    expect(wrongName.status).toBe(400);
    expect(wrongName.calls).toEqual([]);
    // A different length trips the nameLen check first.
    const shortName = await post("read", hwpxBytes({ name: "meta" }));
    expect(shortName.status).toBe(400);
    expect(shortName.calls).toEqual([]);
  });

  it("refuses a zip whose mimetype is not application/hwp+zip", async () => {
    const { status, body, calls } = await post(
      "read",
      hwpxBytes({ mimetype: "application/epub+zip" }),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(calls).toEqual([]);
  });

  it("refuses a PNG, a text buffer and a 3-byte buffer", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const text = new TextEncoder().encode("hello, this is definitely not a document at all");
    for (const [label, bytes] of [
      ["png", png],
      ["text", text],
      ["tiny", new Uint8Array([80, 75, 3])],
    ] as const) {
      const { status, body, calls } = await post("read", bytes);
      expect(status, label).toBe(400);
      expect(body.error.code, label).toBe("bad_request");
      expect(calls, label).toEqual([]);
    }
  });

  it("refuses a header truncated before the mimetype content, without reading past it", async () => {
    const full = hwpxBytes();
    // 38 is exactly the header + name; anything below the mimetype end is short.
    for (const end of [38, 45, full.length - 1]) {
      const { status, calls } = await post("read", full.subarray(0, end));
      expect(status, `truncated to ${end}`).toBe(400);
      expect(calls, `truncated to ${end}`).toEqual([]);
    }
  });

  it("refuses on read, render, edit and validate alike — one buffering site", async () => {
    const junk = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
    for (const action of ["read", "render", "validate"]) {
      const { status, calls } = await post(action, junk);
      expect(status, action).toBe(400);
      expect(calls, action).toEqual([]);
    }
    const edit = await post("edit", junk, { ops: JSON.stringify([{ kind: "replace", find: "a", replace: "b" }]) });
    expect(edit.status).toBe(400);
    expect(edit.calls).toEqual([]);
  });

  it("does not apply to compose, which carries no upload", async () => {
    const { engine, calls } = countingEngine();
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(
      jsonRequest(`${BASE}/compose`, { spec: { version: "2.0", document: {} }, name: "out.hwpx" }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});

/**
 * SEC-05. `opValue` in packages/core/src/ops.ts reaches `op.path` in exactly
 * two cases, and both are refused on the HTTP surface (D-10). The Tauri
 * transport is a local application and keeps them, which is why the guard
 * lives here and not in ops.ts.
 */
describe("op path", () => {
  async function edit(ops: unknown): Promise<{
    status: number;
    body: { error: { code: string; message: string } };
    calls: string[];
  }> {
    const { engine, calls } = countingEngine();
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(
      multipartRequest(`${BASE}/edit`, { file: DOC, ops: JSON.stringify(ops) }),
    );
    return { status: res.status, body: await res.json(), calls };
  }

  const INSERT_IMAGE = { kind: "insert-image", anchor: "here", path: "/etc/passwd" };
  const SEAL = { kind: "seal", anchor: "here", path: "/root/.ssh/id_rsa" };

  it("refuses insert-image with 400 path_traversal before the engine is called", async () => {
    const { status, body, calls } = await edit([INSERT_IMAGE]);
    expect(status).toBe(400);
    expect(body.error.code).toBe("path_traversal");
    expect(calls).toEqual([]);
  });

  it("refuses seal the same way", async () => {
    const { status, body, calls } = await edit([SEAL]);
    expect(status).toBe(400);
    expect(body.error.code).toBe("path_traversal");
    expect(calls).toEqual([]);
  });

  it("refuses an array mixing one of them with several harmless ops", async () => {
    const { status, body, calls } = await edit([
      { kind: "replace", find: "a", replace: "b" },
      { kind: "set-field", name: "n", value: "v" },
      SEAL,
      { kind: "add-row", table: 0 },
    ]);
    expect(status).toBe(400);
    expect(body.error.code).toBe("path_traversal");
    expect(calls).toEqual([]);
  });

  it("admits an array of only other kinds, which reach the engine as today", async () => {
    const { status, calls } = await edit([
      { kind: "replace", find: "a", replace: "b" },
      { kind: "set-cell", table: 0, row: 1, col: 1, value: "x" },
      { kind: "set-field", name: "n", value: "v" },
      { kind: "add-row", table: 0 },
    ]);
    expect(status).toBe(200);
    expect(calls).toEqual(["edit"]);
  });

  it("leaves the empty-ops case to the existing required-field check", async () => {
    const { status, body, calls } = await edit([]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "sample.hwpx" });
    expect(calls).toEqual(["edit"]);
  });
});

/**
 * SEC-06, route half. 04-03 scrubbed the engine's own messages; this is the
 * serialization boundary, where an UNclassified throw must not become a
 * client-visible string at all.
 */
describe("no leak: the unclassified catch branch answers a fixed message", () => {
  const LEAKY_PATH = "/tmp/hwp-editor-abc/in.hwpx";

  async function failingValidate(thrown: unknown): Promise<{
    status: number;
    body: { error: { code: string; message: string } };
  }> {
    const handler = createHwpEditorHandler({
      engine: stubEngine({
        async validate(): Promise<never> {
          throw thrown;
        },
      }),
      sessions: false,
    });
    const res = await handler(multipartRequest(`${BASE}/validate`, { file: DOC }));
    return { status: res.status, body: await res.json() };
  }

  it("answers a 500 whose message carries no path from the thrown Error", async () => {
    const { status, body } = await failingValidate(
      new Error(`hwp cat failed reading ${LEAKY_PATH}`),
    );
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal");
    expect(body.error.message).not.toContain(LEAKY_PATH);
    expect(body.error.message).not.toMatch(/(^|\s|")\/[\w.-]+\//);
  });

  it("answers identically for a thrown string, null and a plain object", async () => {
    const baseline = await failingValidate(new Error(LEAKY_PATH));
    for (const thrown of ["boom", null, { message: "/tmp/x" }, undefined, 42]) {
      const { status, body } = await failingValidate(thrown);
      expect(status, JSON.stringify(thrown)).toBe(500);
      expect(body, JSON.stringify(thrown)).toEqual(baseline.body);
    }
  });

  it("still round-trips an HwpCliError's own status, code and message", async () => {
    const { HwpCliError } = await import("../src/cli-engine.js");
    const { status, body } = await failingValidate(
      new HwpCliError("failed", "hwp validate exited 1"),
    );
    expect(status).toBe(422);
    expect(body.error).toEqual({ code: "failed", message: "hwp validate exited 1" });
  });
});

/**
 * The route half of SEC-04: the scope the single `authorize` call returns
 * reaches every spawning handler's per-call options and salts the session
 * key, so two tenants uploading identical bytes share nothing.
 *
 * The engine half — that `inspections` and `snapshots` key off that same
 * scope — is proven in `cli-engine.test.ts`'s describe of the same name,
 * because those two Maps live inside `createCliEngine` and a stub engine
 * has neither.
 *
 * Every case below drives ONE handler across both scopes. A second handler
 * would get its own `hashToSession` map and produce two session ids whether
 * the key is salted or not, which is a test that cannot fail.
 */
describe("scope isolation", () => {
  /** A CliEngine-shaped stub recording the `call` options each method saw. */
  function scopeSpy(): { engine: HwpEngine; seen: Array<{ action: string; scope?: string }> } {
    const seen: Array<{ action: string; scope?: string }> = [];
    const record = (action: string, call?: { scope?: string }) => {
      seen.push({ action, ...(call?.scope === undefined ? {} : { scope: call.scope }) });
    };
    const engine = {
      async describe(_doc: DocumentHandle, call?: { scope?: string }) {
        record("describe", call);
        return {
          envelope: { markdown: "# hi", segments: [] },
          fields: null,
          bookmarks: null,
          slots: null,
          info: null,
          capabilities: { editable: true },
        };
      },
      async read(_doc: DocumentHandle, call?: { scope?: string }) {
        record("read", call);
        return { markdown: "# hi", segments: [] };
      },
      async render(_doc: DocumentHandle, _o?: RenderOptions, call?: { scope?: string }) {
        record("render", call);
        return [
          { page: 1, width: 100, height: 200, dpi: 96, format: "svg", data: new Uint8Array([60]) },
        ] as PageImage[];
      },
      async edit(doc: DocumentHandle, _ops: EditOp[], _o?: unknown, call?: { scope?: string }) {
        record("edit", call);
        return { name: doc.name, data: new Uint8Array([9, 9, 9]) };
      },
      async compose(_spec: unknown, name: string, call?: { scope?: string }) {
        record("compose", call);
        return { document: { name, data: new Uint8Array([7, 7]) } };
      },
      async validate(_doc: DocumentHandle, call?: { scope?: string }) {
        record("validate", call);
        return { valid: true, errors: [] };
      },
      async capabilities() {
        return { version: "0.8.8", editable: true, formats: ["hwp", "hwpx"] };
      },
    };
    return { engine: engine as unknown as HwpEngine, seen };
  }

  it("passes the authorize scope to all five spawning handlers", async () => {
    const { engine, seen } = scopeSpy();
    const handler = createHwpEditorHandler({
      engine,
      sessions: false,
      authorize: async () => "tenant-a",
    });
    const ops = JSON.stringify([{ kind: "replace", find: "a", replace: "b" }]);
    for (const req of [
      multipartRequest(`${BASE}/read`, { file: DOC }),
      multipartRequest(`${BASE}/render`, { file: DOC }),
      multipartRequest(`${BASE}/edit`, { file: DOC, ops }),
      jsonRequest(`${BASE}/compose`, { spec: { version: "2.0" }, name: "x.hwpx" }),
      multipartRequest(`${BASE}/validate`, { file: DOC }),
    ]) {
      expect((await handler(req)).status).toBe(200);
    }
    // `handleEdit` is the one that matters most and the easiest to miss: the
    // engine's `inspections` pre-flight and its `snapshots` write both key off
    // this argument, so an unthreaded edit silently falls back to the default.
    expect(seen).toEqual([
      { action: "read", scope: "tenant-a" },
      { action: "render", scope: "tenant-a" },
      { action: "edit", scope: "tenant-a" },
      { action: "compose", scope: "tenant-a" },
      { action: "validate", scope: "tenant-a" },
    ]);
  });

  it("uses the fixed default scope when no authorize is supplied", async () => {
    const { engine, seen } = scopeSpy();
    const handler = createHwpEditorHandler({ engine, sessions: false });
    expect((await handler(multipartRequest(`${BASE}/render`, { file: DOC }))).status).toBe(200);
    expect(seen).toEqual([{ action: "render", scope: "default" }]);
  });

  it("gives two scopes uploading identical bytes different session ids", async () => {
    const { createSessionStore } = await import("../src/session.js");
    const sessions = createSessionStore();
    const { engine } = scopeSpy();
    let scope = "tenant-a";
    const handler = createHwpEditorHandler({ engine, sessions, authorize: async () => scope });
    expect((await handler(multipartRequest(`${BASE}/read`, { file: DOC }))).status).toBe(200);
    expect(sessions.size()).toBe(1);
    // Same handler, same bytes, same hashToSession map — only the scope moved.
    scope = "tenant-b";
    expect((await handler(multipartRequest(`${BASE}/read`, { file: DOC }))).status).toBe(200);
    expect(sessions.size()).toBe(2);
    const [a, b] = sessions.ids();
    expect(a).not.toBe(b);
  });

  it("reuses one session id for identical bytes under the same scope", async () => {
    const { createSessionStore } = await import("../src/session.js");
    const sessions = createSessionStore();
    const { engine } = scopeSpy();
    const handler = createHwpEditorHandler({
      engine,
      sessions,
      authorize: async () => "tenant-a",
    });
    await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    await handler(multipartRequest(`${BASE}/read`, { file: DOC }));
    expect(sessions.size()).toBe(1);
  });
});
