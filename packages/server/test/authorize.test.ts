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
import { multipartRequest } from "./helpers.js";

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

const DOC: DocumentHandle = {
  name: "sample.hwpx",
  data: new Uint8Array([80, 75, 3, 4, 1, 2, 3]),
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

/** Stub whose read/capabilities record every entry, so 0 proves non-entry. */
function countingEngine(): { engine: HwpEngine; calls: string[] } {
  const calls: string[] = [];
  const engine = stubEngine({
    async read() {
      calls.push("read");
      return { markdown: "# hi", segments: [] };
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
