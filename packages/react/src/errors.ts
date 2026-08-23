/**
 * Engine error classification for distinct UI states. Engines surface
 * failures as plain message strings (HTTP: "hwp-engine HTTP 504: ...",
 * Tauri: "hwped_read failed: cli_missing: ...", CLI: "hwp binary not
 * found: ..."); this maps them onto the four states the editor renders
 * distinctly. Substring matching is deliberate — the wire contract carries
 * no error-kind field, and the markers below are pinned by the engines.
 */

export type EngineErrorKind = "timeout" | "unavailable" | "protected" | "generic";

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
