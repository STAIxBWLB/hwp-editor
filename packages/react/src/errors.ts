/**
 * Engine error classification for distinct UI states, mapping a failure
 * onto the four states the editor renders distinctly.
 *
 * The stable `HwpErrorCode` carried by `HwpEngineError` (@hwp-editor/core)
 * is the preferred input: `engineErrorKind` consults it first and never
 * reads the prose when it is present. Substring matching over the message
 * is the documented FALLBACK for failures that carry no code — a pre-1.0
 * server, or a maru/Tauri rejection that surfaces only a prefixed string
 * ("hwped_read failed: cli_missing: ..."). The markers below are pinned by
 * those engines; `classifyEngineError` stays exported for that path.
 *
 * This module classifies only. The human-readable badge LABELS live in the
 * string table (`error.kind.*` in messages.ts) and are resolved by
 * ErrorLine; nothing here renders text.
 */

import type { EditorError, EditRefusalKind, HwpErrorCode } from "@hwp-editor/core";
import { isEditRefusalKind, isHwpEngineError, isHwpErrorCode } from "@hwp-editor/core";

export type EngineErrorKind = "timeout" | "unavailable" | "protected" | "generic";

/**
 * Build the store/load carrier from an arbitrary thrown value: the code
 * only when the thrower supplied one AND it is a known HwpErrorCode. A
 * duck-typed foreign error (e.g. a Node ErrnoException with code "ENOENT")
 * must not leak a non-union string into a field typed as the union; its
 * code is dropped, not remapped — synthesizing `internal` here would be
 * indistinguishable from a real `internal` (see state.ts in core).
 */
export function toEditorError(e: unknown): EditorError {
  const refusal = engineRefusalKind(e);
  const base: EditorError = isHwpEngineError(e) && isHwpErrorCode(e.code)
    ? { code: e.code, message: e.message }
    : { message: e instanceof Error ? e.message : String(e) };
  return refusal === undefined ? base : { ...base, refusal };
}

/** The classified edit refusals a transport marks with `edit refused: <kind>` (core `classifyEditRefusal`). */
export type EngineRefusalKind = EditRefusalKind;

/**
 * Which classified refusal a failure carries, if any, so nothing was applied.
 * Each transport classifies with core's `classifyEditRefusal` and sets the
 * error's structured `refusal` field; this reads that field only (#82). The
 * message is never parsed: on an unclassified failure it can end with text
 * the user typed, and that must not select a sentence. Duck-typed like
 * `isHwpEngineError`, and narrowed, so a foreign value cannot pass.
 */
export function engineRefusalKind(e: unknown): EngineRefusalKind | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const refusal = (e as { refusal?: unknown }).refusal;
  return isEditRefusalKind(refusal) ? refusal : undefined;
}

/**
 * Whether a failure is an edit that wrote no diagnostic at all (#91), so the
 * engine was stopped from outside and nothing was applied.
 *
 * Read from the structured `stopped` field both transports set, never from the
 * message: the sentence the core message already carries is English, and a
 * host that predates the field still has only that text, which is the fallback
 * rather than something this guesses at. Duck-typed and narrowed, so a foreign
 * error carrying any other value cannot select the sentence.
 */
export function engineStoppedWithoutDiagnostic(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { stopped?: unknown }).stopped === true;
}

/**
 * Badge per code. A total Record on purpose, not a switch with a default:
 * adding a sixteenth HwpErrorCode must fail `tsc --noEmit` here and force
 * an explicit badge decision rather than silently rendering "generic".
 *
 * `version` maps to `unavailable`: a binary too old and a binary missing
 * are the same problem with the same remedy from the user's seat.
 */
const KIND_BY_CODE: Record<HwpErrorCode, EngineErrorKind> = {
  timeout: "timeout",
  unavailable: "unavailable",
  version: "unavailable",
  protected: "protected",
  failed: "generic",
  bad_request: "generic",
  unsupported_format: "generic",
  output_too_large: "generic",
  cancelled: "generic",
  method_not_allowed: "generic",
  not_found: "generic",
  session_not_found: "generic",
  path_traversal: "generic",
  forbidden: "generic",
  internal: "generic",
};

/**
 * Single entry point: the code wins whenever it is present and known;
 * otherwise fall back to reading the message.
 */
export function engineErrorKind(error: {
  code?: string;
  message: string;
}): EngineErrorKind {
  if (error.code !== undefined && Object.hasOwn(KIND_BY_CODE, error.code)) {
    return KIND_BY_CODE[error.code as HwpErrorCode];
  }
  return classifyEngineError(error.message);
}

export function classifyEngineError(message: string): EngineErrorKind {
  const m = message.toLowerCase();
  // CliEngine "timed out after", maru "hwp_timeout:", HTTP 504.
  if (m.includes("timed out") || m.includes("hwp_timeout") || m.includes("http 504")) {
    return "timeout";
  }
  // CliEngine "binary not found"/"is not executable", maru "cli_missing:", HTTP 503.
  if (
    m.includes("binary not found") ||
    m.includes("cli_missing") ||
    m.includes("not executable") ||
    m.includes("http 503")
  ) {
    return "unavailable";
  }
  // Protected/distribution documents: the read-only banner covers the
  // capabilities path; this catches edit-time refusals from the CLI.
  if (
    m.includes("distribution") ||
    m.includes("encrypted") ||
    m.includes("protected") ||
    m.includes("배포용")
  ) {
    return "protected";
  }
  return "generic";
}
