/**
 * Unit tests for the error-mapping helpers: `toEditorError` is the boundary
 * where arbitrary thrown values enter the typed `EditorError` carrier, so
 * the drop-vs-keep rule for foreign codes is pinned here directly rather
 * than through the DOM.
 */
import { describe, expect, it } from "vitest";
import { HwpEngineError } from "@hwp-editor/core";

import { engineErrorKind, toEditorError } from "../src/errors.js";

describe("toEditorError", () => {
  it("keeps the code of a real HwpEngineError", () => {
    expect(toEditorError(new HwpEngineError("protected", "거부됨"))).toEqual({
      code: "protected",
      message: "거부됨",
    });
  });

  it("keeps a duck-typed code only when it is a known HwpErrorCode", () => {
    const compatible = Object.assign(new Error("x"), { code: "timeout" });
    expect(toEditorError(compatible)).toEqual({ code: "timeout", message: "x" });
  });

  it("drops a foreign code instead of leaking it into the typed field", () => {
    // A host-supplied engine may throw any coded error (e.g. a Node
    // ErrnoException). isHwpEngineError's duck-typing accepts it, but
    // "ENOENT" is not an HwpErrorCode, so the carrier must have no code
    // at all rather than a non-union string — and `internal` must NOT be
    // synthesized (state.ts: indistinguishable from a real `internal`).
    const foreign = Object.assign(new Error("no such file or directory"), {
      code: "ENOENT",
    });
    const error = toEditorError(foreign);
    expect(error).toEqual({ message: "no such file or directory" });
    expect("code" in error).toBe(false);
  });

  it("carries only the message for a codeless Error and a non-Error", () => {
    expect(toEditorError(new Error("boom"))).toEqual({ message: "boom" });
    expect(toEditorError("boom")).toEqual({ message: "boom" });
  });
});

describe("engineErrorKind", () => {
  it("falls back to message classification for a prototype-chain key", () => {
    // `in` would find "constructor" on Object.prototype and return a
    // function; Object.hasOwn restricts membership to the twelve codes.
    expect(engineErrorKind({ code: "constructor", message: "boom" })).toBe("generic");
  });
});
