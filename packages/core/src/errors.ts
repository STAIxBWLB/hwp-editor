/**
 * The published error contract: a stable machine-readable code on every
 * engine failure, so hosts branch on `err.code` instead of parsing prose.
 *
 * The twelve `HwpErrorCode` strings ARE the HTTP body contract — they are
 * the values `ErrorResponse.error.code` (protocol.ts) carries on the wire.
 * The server emits the first group from `HwpCliError.reason`
 * (packages/server/src/cli-engine.ts) and the second from its route layer
 * (packages/server/src/routes.ts). Renaming any of them, or dropping one,
 * is a breaking change for every host `catch`/`switch` and for any non-JS
 * client reading the JSON.
 *
 * Not to be confused with `ValidationError.code` (engine.ts), a
 * document-validation finding inside a 200 response — a different
 * vocabulary that must never be folded into this union.
 */

/** Machine-readable failure code carried by every engine error. */
export type HwpErrorCode =
  // Engine reasons — mirrored from HwpCliError.reason.
  | "unavailable"
  | "version"
  | "timeout"
  | "failed"
  | "bad_request"
  | "unsupported_format"
  | "protected"
  // Route-layer codes — emitted by the HTTP handler itself.
  | "method_not_allowed"
  | "not_found"
  | "session_not_found"
  | "path_traversal"
  | "internal";

/**
 * Exact membership set for the twelve literals above. Matching is plain
 * JavaScript string equality: no case folding, no trimming, no Unicode
 * normalization. "Timeout" and " timeout" are NOT members.
 */
const CODES: ReadonlySet<string> = new Set<HwpErrorCode>([
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
]);

/**
 * Membership test for the twelve literals above. Use this at boundaries
 * where an unrecognized code must be DROPPED (e.g. a duck-typed foreign
 * error entering `EditorError.code`) rather than remapped — the remapping
 * variant is `toHwpErrorCode`.
 */
export function isHwpErrorCode(value: unknown): value is HwpErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/**
 * Narrow an untrusted value (a wire body field, a host-thrown error) to a
 * known code. Anything unrecognized — including `undefined`, `null` and
 * non-strings — becomes `internal` rather than entering the union by cast.
 */
export function toHwpErrorCode(value: unknown): HwpErrorCode {
  return isHwpErrorCode(value) ? value : "internal";
}

export interface HwpEngineErrorOptions {
  /** HTTP status, when the failure crossed an HTTP boundary. */
  status?: number;
  /** Underlying value that produced this error (parsed body, inner error). */
  cause?: unknown;
}

/** Engine failure carrying a stable `code` alongside its human message. */
export class HwpEngineError extends Error {
  /**
   * Present only when the failure crossed an HTTP boundary. `declare` is
   * load-bearing: with useDefineForClassFields (implied by target ESNext) a
   * plain declaration would emit `status = undefined`, so an error built
   * without a status would still answer true to `"status" in err`.
   */
  declare readonly status?: number;

  constructor(
    public readonly code: HwpErrorCode,
    message: string,
    options: HwpEngineErrorOptions = {},
  ) {
    super(message);
    this.name = "HwpEngineError";
    // Both assigned conditionally: exactOptionalPropertyTypes rejects
    // handing an explicit `undefined` to an optional property, so an error
    // built without a status has no own `status` key at all.
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Duck-typed guard. Deliberately NOT `instanceof HwpEngineError`: hosts
 * bundling a second copy of this module break `instanceof`, and branching
 * on `err.code` across that boundary is the whole point of the carrier.
 * Any `Error` carrying a string `code` therefore passes; the value is
 * still narrowed by `toHwpErrorCode` before it can drive UI.
 */
export function isHwpEngineError(value: unknown): value is HwpEngineError {
  return (
    value instanceof Error &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/**
 * Korean markers in hwp-cli's runtime diagnostics, each paired with the
 * fixed, transport-authored message the client sees.
 *
 * Lives in core, not in one transport, because it is hwp-cli's vocabulary
 * rather than any single transport's: the CLI server reads it out of
 * `HwpCliError.stderr` and the Tauri bridge reads it out of maru's rejection
 * string. A second copy would drift the moment hwp-cli rewords a message.
 *
 * THESE MARKERS STAY KOREAN PERMANENTLY. Do not delete them after seeing
 * `scrubbedEnv()` pin HWP_LANG in packages/server. HWP_LANG and --lang feed
 * exactly one consumer, `localize()`
 * (hwp-cli/crates/hwp-cli/src/i18n.rs:71-77), which rewrites clap
 * about/help strings; runtime diagnostics are hardcoded Korean thiserror
 * attributes with no locale branch (crates/hwp5/src/error.rs:1-92), verified
 * by running the binary under HWP_LANG=en, HWP_LANG=ko, and no locale env at
 * all and getting byte-identical Korean output all three times. Deleting
 * these degrades protected detection to the hwp5-booleans-only pre-flight,
 * which misses every HWPX protection and four of six hwp5 kinds.
 *
 * Four entries cover all seven refusal messages: `암호화된 문서` also matches
 * `공인 인증서로 암호화된 문서는...` and the HWPX Encrypted variant, and `DRM`
 * matches both Drm and CertDrm. `지원하지 않습니다` is deliberately NOT a
 * marker: Hwp5Error::UnsupportedVersion ("지원하지 않는 HWP 버전입니다")
 * shares that phrasing, and a false `protected` on a version problem sends
 * the user to the wrong remedy.
 *
 * Matching is a UTF-16 substring test with the markers written precomposed
 * (NFC) to mirror the Rust source literals. Decomposed (NFD) input would not
 * match and the failure would stay `failed`, a safe degradation.
 */
const PROTECTED_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["암호화된 문서", "encrypted document; hwp-cli refuses edit/compose"],
  ["DRM", "DRM-protected document; hwp-cli refuses edit/compose"],
  ["서명된 문서", "signed document; hwp-cli refuses edit/compose"],
  ["배포용 문서", "distribution (배포용) document; hwp-cli refuses edit/compose"],
];

/**
 * The protection backstop, shared by every transport that sees raw hwp-cli
 * diagnostics. Returns one of the four fixed constants above, or null.
 *
 * The argument is never interpolated into the result: raw CLI output stays
 * on whatever non-serialized field its transport keeps it on, so this path
 * adds no new CLI-output-to-client leak (Phase 4 SEC-06 owns the
 * pre-existing one in the server's `runCliOk`).
 */
export function protectedReasonFromDiagnostics(text: string): string | null {
  for (const [marker, message] of PROTECTED_MARKERS) {
    if (text.includes(marker)) return message;
  }
  return null;
}
