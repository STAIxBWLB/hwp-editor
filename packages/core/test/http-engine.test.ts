/**
 * createHttpEngine error-path tests with a stub fetch. Pin the published
 * error carrier: a wire `error.code` survives to `HwpEngineError.code`, the
 * HTTP status is carried, and the message format stays byte-for-byte the
 * one `classifyEngineError` reads as a fallback marker.
 */
import { describe, expect, it } from "vitest";
import { createHttpEngine } from "../src/http-engine.js";
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
