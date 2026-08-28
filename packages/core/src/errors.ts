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
 * Narrow an untrusted value (a wire body field, a host-thrown error) to a
 * known code. Anything unrecognized — including `undefined`, `null` and
 * non-strings — becomes `internal` rather than entering the union by cast.
 */
export function toHwpErrorCode(value: unknown): HwpErrorCode {
  return typeof value === "string" && CODES.has(value)
    ? (value as HwpErrorCode)
    : "internal";
}

export interface HwpEngineErrorOptions {
  /** HTTP status, when the failure crossed an HTTP boundary. */
  status?: number;
  /** Underlying value that produced this error (parsed body, inner error). */
  cause?: unknown;
}

/** Engine failure carrying a stable `code` alongside its human message. */
export class HwpEngineError extends Error {
  /** Present only when the failure crossed an HTTP boundary. */
  readonly status?: number;

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
