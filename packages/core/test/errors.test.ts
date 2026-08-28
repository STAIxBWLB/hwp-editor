/**
 * Pins the published narrowing contract: exact membership for the twelve
 * codes, the duck-typed guard, and HwpEngineError's field shape. Pure unit
 * tests — no server, no binary.
 */
import { describe, expect, it } from "vitest";
import {
  HwpEngineError,
  isHwpEngineError,
  isHwpErrorCode,
  toHwpErrorCode,
  type HwpErrorCode,
} from "../src/errors.js";

const ALL_CODES: HwpErrorCode[] = [
  "unavailable",
  "version",
  "timeout",
  "failed",
  "bad_request",
  "unsupported_format",
  "protected",
  "method_not_allowed",
  "not_found",
  "session_not_found",
  "path_traversal",
  "internal",
];

describe("toHwpErrorCode", () => {
  it("round-trips each of the twelve literals", () => {
    for (const code of ALL_CODES) expect(toHwpErrorCode(code)).toBe(code);
  });

  it("has exactly twelve members", () => {
    expect(ALL_CODES.length).toBe(12);
    expect(new Set(ALL_CODES).size).toBe(12);
  });

  it("narrows anything unrecognized to internal", () => {
    expect(toHwpErrorCode("nope")).toBe("internal");
    expect(toHwpErrorCode(undefined)).toBe("internal");
    expect(toHwpErrorCode(null)).toBe("internal");
    expect(toHwpErrorCode(42)).toBe("internal");
    expect(toHwpErrorCode("")).toBe("internal");
    expect(toHwpErrorCode({ code: "timeout" })).toBe("internal");
  });

  it("matches exactly: no case folding and no trimming", () => {
    expect(toHwpErrorCode("Timeout")).toBe("internal");
    expect(toHwpErrorCode("TIMEOUT")).toBe("internal");
    expect(toHwpErrorCode(" timeout")).toBe("internal");
    expect(toHwpErrorCode("timeout ")).toBe("internal");
  });
});

describe("isHwpErrorCode", () => {
  it("accepts each of the twelve literals", () => {
    for (const code of ALL_CODES) expect(isHwpErrorCode(code)).toBe(true);
  });

  it("rejects anything unrecognized instead of remapping it", () => {
    expect(isHwpErrorCode("ENOENT")).toBe(false);
    expect(isHwpErrorCode("Timeout")).toBe(false);
    expect(isHwpErrorCode("")).toBe(false);
    expect(isHwpErrorCode(undefined)).toBe(false);
    expect(isHwpErrorCode(null)).toBe(false);
    expect(isHwpErrorCode(42)).toBe(false);
  });
});

describe("isHwpEngineError", () => {
  it("accepts an HwpEngineError", () => {
    expect(isHwpEngineError(new HwpEngineError("timeout", "x"))).toBe(true);
  });

  it("rejects a bare Error and a non-Error", () => {
    expect(isHwpEngineError(new Error("x"))).toBe(false);
    expect(isHwpEngineError("timeout")).toBe(false);
    expect(isHwpEngineError(null)).toBe(false);
    expect(isHwpEngineError({ code: "timeout", message: "x" })).toBe(false);
  });

  it("accepts any Error carrying a string code — the deliberate duck-typing", () => {
    // instanceof is what breaks across a bundle boundary; that case is
    // exactly why the guard exists. The value is narrowed downstream.
    const foreign = Object.assign(new Error("x"), { code: "timeout" });
    expect(isHwpEngineError(foreign)).toBe(true);
  });
});

describe("HwpEngineError shape", () => {
  it("sets name and code and omits status entirely when not given", () => {
    const err = new HwpEngineError("failed", "x");
    expect(err.name).toBe("HwpEngineError");
    expect(err.code).toBe("failed");
    expect(err.message).toBe("x");
    expect("status" in err).toBe(false);
  });

  it("carries status and cause when given", () => {
    const raw = { error: { code: "timeout", message: "x" } };
    const err = new HwpEngineError("timeout", "x", { status: 504, cause: raw });
    expect(err.status).toBe(504);
    expect(err.cause).toBe(raw);
  });

  it("is an Error, so existing host catch blocks still work", () => {
    expect(new HwpEngineError("internal", "x")).toBeInstanceOf(Error);
  });
});
