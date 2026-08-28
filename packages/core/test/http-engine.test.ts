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
