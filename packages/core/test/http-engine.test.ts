import { malformedLayouts } from "./fixtures/layout.js";
import { RENDER_LAYOUT_NEXT_STEP } from "../src/layout.js";
/**
 * createHttpEngine error-path tests with a stub fetch. Pin the published
 * error carrier: a wire `error.code` survives to `HwpEngineError.code`, the
 * HTTP status is carried, and the message format stays byte-for-byte the
 * one `classifyEngineError` reads as a fallback marker.
 */
import { describe, expect, it, vi } from "vitest";
import { base64, createHttpEngine } from "../src/http-engine.js";
import { isHwpEngineError } from "../src/errors.js";
import type { HwpEngineError } from "../src/errors.js";
import type { DocumentHandle } from "../src/engine.js";
import type { EditOp } from "../src/ops.js";

const doc: DocumentHandle = {
  name: "회의록.hwpx",
  data: new TextEncoder().encode("bytes"),
};

/** A fetch stub that always answers with one canned Response. */
function stubFetch(body: BodyInit | null, init: ResponseInit): typeof fetch {
  return (() => Promise.resolve(new Response(body, init))) as typeof fetch;
}

describe("parseError JSON branch", () => {
  it("carries the wire code, the status, and the pinned message", async () => {
    const engine = createHttpEngine("/api", {
      fetch: stubFetch(
        JSON.stringify({ error: { code: "timeout", message: "엔진 시간 초과" } }),
        { status: 504, statusText: "Gateway Timeout" },
      ),
    });

    const err = await engine.read(doc).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isHwpEngineError(err)).toBe(true);
    if (!isHwpEngineError(err)) return;
    expect(err.code).toBe("timeout");
    expect(err.status).toBe(504);
    expect(err.name).toBe("HwpEngineError");
    expect(err.message).toBe("hwp-engine HTTP 504: 엔진 시간 초과");
  });

  it("narrows an unknown wire code to internal instead of casting it in", async () => {
    const engine = createHttpEngine("/api", {
      fetch: stubFetch(
        JSON.stringify({ error: { code: "quantum_flux", message: "boom" } }),
        { status: 500, statusText: "Internal Server Error" },
      ),
    });

    const err = await engine.capabilities().then(
      () => null,
      (e: unknown) => e,
    );

    expect(isHwpEngineError(err)).toBe(true);
    if (!isHwpEngineError(err)) return;
    expect(err.code).toBe("internal");
  });
});

describe("parseError non-JSON branch", () => {
  async function codeForNonJson(
    status: number,
    statusText: string,
  ): Promise<unknown> {
    const engine = createHttpEngine("/api", {
      // A reverse proxy / gateway error page: never reaches the JSON handler.
      fetch: stubFetch("<html>Gateway Timeout</html>", {
        status,
        statusText,
        headers: { "content-type": "text/html" },
      }),
    });
    return engine.capabilities().then(
      () => null,
      (e: unknown) => e,
    );
  }

  it("derives the code from the HTTP status", async () => {
    const cases: [number, string, string][] = [
      [504, "Gateway Timeout", "timeout"],
      [503, "Service Unavailable", "unavailable"],
      [400, "Bad Request", "bad_request"],
      [404, "Not Found", "not_found"],
      [405, "Method Not Allowed", "method_not_allowed"],
      [422, "Unprocessable Entity", "failed"],
      // 403 is reserved for a later authorization phase; it must NOT claim
      // a code of its own here.
      [403, "Forbidden", "internal"],
      [500, "Internal Server Error", "internal"],
    ];
    for (const [status, statusText, code] of cases) {
      const err = await codeForNonJson(status, statusText);
      expect(isHwpEngineError(err)).toBe(true);
      if (!isHwpEngineError(err)) return;
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
  });

  it("keeps the statusText message format", async () => {
    const err = await codeForNonJson(504, "Gateway Timeout");
    if (!isHwpEngineError(err)) throw new Error("expected HwpEngineError");
    expect(err.message).toBe("hwp-engine HTTP 504: Gateway Timeout");
  });
});

/**
 * BUG-06 / TEST-01. The codec has two paths — the native `Uint8Array` base64
 * APIs (Node >= 25, Chrome 140, Safari 26, Firefox 133) and the chunked
 * fallback that every floor environment (Node 22/24, older webviews) actually
 * runs. The dev machine has the natives, so the fallback would ship untested
 * unless the tests force it (research Pitfall P1). Both paths must agree
 * byte-for-byte: the same `base64` object is the shared seam for `tauri.ts`
 * and `PageCanvas`.
 */
type Codec = typeof base64;

const HAS_NATIVE =
  typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 ===
  "function";

/**
 * Re-import the codec with the native methods deleted, so the module-scope
 * capture sees `undefined` and the chunked fallback is provably the code
 * under test. Assertions run inside the deleted window; the natives are
 * restored in `finally`. Test-only technique — shipped code never touches
 * the prototype (P1).
 */
async function withFallbackCodec(
  fn: (codec: Codec) => void,
): Promise<void> {
  const proto = Uint8Array.prototype as { toBase64?: unknown };
  const ctor = Uint8Array as unknown as { fromBase64?: unknown };
  const savedEncode = proto.toBase64;
  const savedDecode = ctor.fromBase64;
  delete proto.toBase64;
  delete ctor.fromBase64;
  try {
    vi.resetModules();
    const fresh = (await import("../src/http-engine.js")) as {
      base64: Codec;
    };
    fn(fresh.base64);
  } finally {
    if (savedEncode !== undefined) proto.toBase64 = savedEncode;
    if (savedDecode !== undefined) ctor.fromBase64 = savedDecode;
    vi.resetModules();
  }
}

/** Deterministic bytes covering all 256 values once n >= 256 (31 is odd). */
function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

const CHUNK = 0x8000;

const CASES: [string, Uint8Array][] = [
  ["0 bytes", bytes(0)],
  ["1 byte", bytes(1)],
  ["CHUNK - 1 (0x7FFF)", bytes(CHUNK - 1)],
  ["CHUNK (0x8000)", bytes(CHUNK)],
  ["CHUNK + 1 (0x8001)", bytes(CHUNK + 1)],
  ["5 MB", bytes(5 * 1024 * 1024)],
  ["0x00 / 0xFF extremes", new Uint8Array([0x00, 0xff, 0x00, 0xff])],
];

/**
 * Byte-exact comparison in O(n). `toEqual` on a multi-megabyte typed array
 * spends seconds building a structural diff, which times the test out for
 * reasons unrelated to the codec.
 */
function expectBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  expect(actual.length, `${label}: length`).toBe(expected.length);
  let firstDiff = -1;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      firstDiff = i;
      break;
    }
  }
  expect(firstDiff, `${label}: first differing byte index`).toBe(-1);
}

/** Every assertion both codec paths must satisfy identically. */
function checkCodec(codec: Codec): void {
  for (const [label, input] of CASES) {
    expectBytesEqual(codec.decode(codec.encode(input)), input, label);
  }
  // Remainder padding: 1 byte -> "==", 2 bytes -> "=", 3 bytes -> none.
  expect(codec.encode(new Uint8Array([0x61]))).toBe("YQ==");
  expect(codec.encode(new Uint8Array([0x61, 0x62]))).toBe("YWI=");
  expect(codec.encode(new Uint8Array([0x61, 0x62, 0x63]))).toBe("YWJj");
  expect(codec.decode("YQ==")).toEqual(new Uint8Array([0x61]));
  expect(codec.decode("YWI=")).toEqual(new Uint8Array([0x61, 0x62]));
  expect(codec.decode("YWJj")).toEqual(new Uint8Array([0x61, 0x62, 0x63]));
}

describe("base64 codec", () => {
  it("round-trips byte-exact on the ambient path", () => {
    checkCodec(base64);
  });

  it("round-trips byte-exact on the chunked fallback path", async () => {
    await withFallbackCodec(checkCodec);
  });

  it("produces identical output on both paths", async () => {
    if (!HAS_NATIVE) return; // Floor runtime: the fallback IS the only path.
    await withFallbackCodec((fallback) => {
      for (const [label, input] of CASES) {
        expect(fallback.encode(input), label).toBe(base64.encode(input));
      }
    });
  });

  it("keeps the published synchronous { encode, decode } shape", () => {
    expect(typeof base64.encode).toBe("function");
    expect(typeof base64.decode).toBe("function");
    // Sync, not thenable: PageCanvas useMemo and tauri.ts ref() depend on it.
    expect(base64.encode(bytes(4))).toEqual(expect.any(String));
    expect(base64.decode("YQ==")).toBeInstanceOf(Uint8Array);
  });
});

/**
 * TEST-01 multipart leg. The reference client's request body is wire
 * contract: the server reads `file`, `ops`, `verify` and `allowPartial` by
 * those exact names, and a Korean document name has to survive the multipart
 * encoding intact.
 */
describe("FormData construction", () => {
  /** An engine whose fetch records the body instead of sending it. */
  function capturingEngine(responseBody: unknown): {
    engine: ReturnType<typeof createHttpEngine>;
    body: () => FormData;
  } {
    let captured: FormData | null = null;
    const engine = createHttpEngine("/api", {
      fetch: ((_url: string, init: RequestInit) => {
        captured = init.body as FormData;
        return Promise.resolve(new Response(JSON.stringify(responseBody)));
      }) as unknown as typeof fetch,
    });
    return {
      engine,
      body: () => {
        if (captured === null) throw new Error("fetch was never called");
        return captured;
      },
    };
  }

  async function fileEntry(form: FormData): Promise<File> {
    const entry = form.get("file");
    expect(entry).toBeInstanceOf(File);
    return entry as File;
  }

  it("sends the document as a File carrying its non-ASCII name verbatim", async () => {
    const { engine, body } = capturingEngine({ valid: true, errors: [] });
    await engine.validate(doc);

    const file = await fileEntry(body());
    expect(file.name).toBe("회의록.hwpx");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(doc.data);
  });

  it("serializes edit ops as JSON under `ops` with the verify flag", async () => {
    const { engine, body } = capturingEngine({
      name: "회의록.hwpx",
      dataBase64: base64.encode(new TextEncoder().encode("edited")),
    });
    const ops: EditOp[] = [
      { kind: "replace", find: "a", replace: "b" },
      { kind: "delete-para", text: "x" },
    ];
    await engine.edit(doc, ops, { verify: true });

    const form = body();
    expect(await fileEntry(form)).toBeInstanceOf(File);
    expect(form.get("ops")).toBe(JSON.stringify(ops));
    // The flags are string "true", and absent rather than "false" when off.
    expect(form.get("verify")).toBe("true");
    expect(form.get("allowPartial")).toBeNull();
  });

  it("omits both flags when neither option is set, and sends allowPartial when it is", async () => {
    const response = {
      name: "회의록.hwpx",
      dataBase64: base64.encode(new TextEncoder().encode("edited")),
    };

    const bare = capturingEngine(response);
    await bare.engine.edit(doc, []);
    expect(bare.body().get("ops")).toBe("[]");
    expect(bare.body().get("verify")).toBeNull();
    expect(bare.body().get("allowPartial")).toBeNull();

    const partial = capturingEngine(response);
    await partial.engine.edit(doc, [], { allowPartial: true });
    expect(partial.body().get("allowPartial")).toBe("true");
    expect(partial.body().get("verify")).toBeNull();
  });

  it("sends uploaded image assets as repeated asset File parts", async () => {
    const { engine, body } = capturingEngine({
      name: "회의록.hwpx",
      dataBase64: base64.encode(new TextEncoder().encode("edited")),
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await engine.edit(doc, [{ kind: "insert-image", anchor: "figure", path: "figure.png" }], {
      assets: [{ name: "figure.png", data: bytes }],
    });
    const file = body().get("asset");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("figure.png");
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(bytes);
  });
});


describe("render layout transport", () => {
  it.each([undefined, { width_pt: 600, height_pt: 800, truncated: true, rows: [
    { id: "para-1", kind: "para", box: { x0: 10, y0: 20, x1: 200, y1: 40 }, source_chars: { start: 0, end: 5 } },
    { id: "para-1", kind: "para", box: null, source_chars: null },
  ] }])("preserves optional layout while decoding image bytes", async (layout) => {
    const engine = createHttpEngine("/api", { fetch: stubFetch(JSON.stringify({ pages: [{
      page: 3, width: 1200, height: 1600, dpi: 144, format: "png",
      dataBase64: base64.encode(new Uint8Array([1, 2])), ...(layout === undefined ? {} : { layout }),
    }] }), { status: 200 }) });
    const [page] = await engine.render(doc);
    expect(page?.page).toBe(3);
    expect(page?.data).toEqual(new Uint8Array([1, 2]));
    expect(page?.layout).toEqual(layout);
  });
});

describe("HTTP present layout validation", () => {
  it.each(malformedLayouts)("rejects malformed $field before exposing page geometry", async ({value,field}) => {
    const engine=createHttpEngine("/api",{fetch:stubFetch(JSON.stringify({pages:[{page:1,width:600,height:800,dpi:96,format:"png",dataBase64:base64.encode(new Uint8Array([1])),layout:value}]}),{status:200})});
    const failure=await engine.render(doc).catch((error:unknown)=>error);
    expect(failure).toMatchObject({code:"failed",message:expect.stringContaining(field)});
    expect((failure as Error).message).toContain(RENDER_LAYOUT_NEXT_STEP);
  });
});


describe("combined HTTP capabilities", () => {
  it.each(["v1", "v2", undefined])("normalizes template methods and image assets %s together", async imageAssets => {
    const engine = createHttpEngine("/api", { fetch: stubFetch(JSON.stringify({
      version: "1.4.0", editable: true, editOps: "v1", formats: ["hwpx"],
      templateMethods: ["slots", "template"], imageAssets,
    }), { status: 200 }) });
    const caps = await engine.capabilities();
    expect(caps).toMatchObject({ editOps: "v1", templateMethods: ["slots", "template"] });
    if (imageAssets === "v1") expect(caps.imageAssets).toBe("v1");
    else expect(caps).not.toHaveProperty("imageAssets");
  });
});

/**
 * `report` is requested per call and parsed only then. The Tauri engine drops
 * an unreadable report instead of failing an edit whose document was already
 * published; both transports answer one shape for one request, so a host that
 * upgrades ahead of the client cannot turn a successful edit into an error.
 */
describe("edit report transport", () => {
  const edited = {
    name: "회의록.hwpx",
    dataBase64: base64.encode(new TextEncoder().encode("edited")),
  };
  /** edit-report-v1 with one applied insertion of no addressable paragraph. */
  const report = {
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "out.hwpx",
    dry_run: false,
    ops: [{ index: 0, op: "insert_blocks", status: "applied", pieces_touched: 0, changed: [], reason: null }],
    applied_count: 1,
    failed_count: 0,
  };
  /** A report this client's parser refuses, which is what a newer host sends. */
  const unreadable = { schema_version: "1.0", contract: "hwp-edit-report-v2", ops: [] };

  const ops: EditOp[] = [{ kind: "delete-para", address: { at: { section: 0, paragraph: 1 } } }];

  it("parses a report the caller asked for", async () => {
    const engine = createHttpEngine("/api", { fetch: stubFetch(JSON.stringify({ ...edited, report }), { status: 200 }) });
    const result = await engine.edit(doc, ops, { report: true });
    expect(result.report).toEqual(report);
    expect(result.data).toEqual(new TextEncoder().encode("edited"));
  });

  it("does not parse a report the caller did not ask for", async () => {
    const engine = createHttpEngine("/api", { fetch: stubFetch(JSON.stringify({ ...edited, report: unreadable }), { status: 200 }) });
    const result = await engine.edit(doc, ops);
    expect(result).not.toHaveProperty("report");
  });

  it("drops an unreadable report while the edit itself still succeeds", async () => {
    const engine = createHttpEngine("/api", { fetch: stubFetch(JSON.stringify({ ...edited, report: unreadable }), { status: 200 }) });
    const result = await engine.edit(doc, ops, { report: true });
    expect(result.name).toBe("회의록.hwpx");
    expect(result.data).toEqual(new TextEncoder().encode("edited"));
    expect(result).not.toHaveProperty("report");
  });
});

describe("structured refusal on the HTTP transport (#82)", () => {
  function failing(body: unknown): ReturnType<typeof createHttpEngine> {
    return createHttpEngine("/api", {
      fetch: (() => Promise.resolve(new Response(JSON.stringify(body), { status: 422 }))) as unknown as typeof fetch,
    });
  }
  const doc = { name: "a.hwpx", data: new Uint8Array([1]) };

  it("carries the server's error.refusal onto the error", async () => {
    const err = await failing({ error: { code: "failed", message: "hwp edit failed (exit 3): edit refused: range_tag", refusal: "range_tag" } })
      .edit(doc, []).catch((e: unknown) => e) as HwpEngineError;
    expect(err.refusal).toBe("range_tag");
  });

  it("sets no refusal from message text, nor from an unknown field value", async () => {
    for (const error of [
      { code: "failed", message: "Error: 앵커를 찾을 수 없습니다: x edit refused: range_tag" },
      { code: "failed", message: "x", refusal: "bogus" },
    ]) {
      const err = await failing({ error }).edit(doc, []).catch((e: unknown) => e) as HwpEngineError;
      expect(err.refusal).toBeUndefined();
    }
  });
});

/**
 * #97 item 1: the engine's table count crosses the read wire with the envelope,
 * and core's projection is what keeps it a non-negative integer or makes it
 * absent, so one normalization covers both transports.
 */
describe("projected read envelope (#97)", () => {
  const ok = (body: unknown): typeof fetch =>
    stubFetch(JSON.stringify(body), { status: 200, statusText: "OK" });

  it("carries the engine's table count to the caller", async () => {
    const envelope = { markdown: "x", segments: [], bodyTables: 3 };
    const engine = createHttpEngine("/api", { fetch: ok(envelope) });
    await expect(engine.read(doc)).resolves.toEqual(envelope);
  });

  it("drops a count that is not a non-negative integer", async () => {
    const engine = createHttpEngine("/api", {
      fetch: ok({ markdown: "x", segments: [], bodyTables: "3" }),
    });
    expect(await engine.read(doc)).not.toHaveProperty("bodyTables");
  });
});
