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
 */

import type { HwpErrorCode } from "@hwp-editor/core";

export type EngineErrorKind = "timeout" | "unavailable" | "protected" | "generic";

/**
 * Badge per code. A total Record on purpose, not a switch with a default:
 * adding a thirteenth HwpErrorCode must fail `tsc --noEmit` here and force
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
  method_not_allowed: "generic",
  not_found: "generic",
  session_not_found: "generic",
  path_traversal: "generic",
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
  if (error.code !== undefined && error.code in KIND_BY_CODE) {
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

/** Korean badge label per kind; "generic" renders no badge. */
export const ENGINE_ERROR_LABELS: Record<EngineErrorKind, string> = {
  timeout: "엔진 시간 초과",
  unavailable: "hwp 실행 파일 없음",
  protected: "보호/배포 문서",
  generic: "",
};
