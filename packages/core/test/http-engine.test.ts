/**
 * createHttpEngine error-path tests with a stub fetch. Pin the published
 * error carrier: a wire `error.code` survives to `HwpEngineError.code`, the
 * HTTP status is carried, and the message format stays byte-for-byte the
 * one `classifyEngineError` reads as a fallback marker.
 */
import { describe, expect, it, vi } from "vitest";
import { base64, createHttpEngine } from "../src/http-engine.js";
import { isHwpEngineError } from "../src/errors.js";
import type { DocumentHandle } from "../src/engine.js";

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
