/**
 * The published error contract: a stable machine-readable code on every
 * engine failure, so hosts branch on `err.code` instead of parsing prose.
 *
 * The fifteen `HwpErrorCode` strings ARE the HTTP body contract — they are
 * the values `ErrorResponse.error.code` (protocol.ts) carries on the wire.
 * The server emits the first group from `HwpCliError.reason`
 * (packages/server/src/cli-engine.ts) and the second from its route layer
 * (packages/server/src/routes.ts). Renaming any of them, or dropping one,
 * is a breaking change for every host `catch`/`switch` and for any non-JS
 * client reading the JSON. `forbidden`, `output_too_large` and `cancelled`
 * were added in Phase 4 before the first publish — the only moment an
 * addition to this union is free, because no host is branching on it yet.
 *
 * Not to be confused with `ValidationError.code` (engine.ts), a
 * document-validation finding inside a 200 response — a different
 * vocabulary that must never be folded into this union.
 */

import type { InsertionRefusal } from "./insertion-refusals.js";
import type { EditRefusalKind } from "./refusals.js";

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
  | "output_too_large"
  | "cancelled"
  // Route-layer codes — emitted by the HTTP handler itself.
  | "method_not_allowed"
  | "not_found"
  | "session_not_found"
  | "path_traversal"
  | "forbidden"
  | "internal";

/**
 * Exact membership set for the fifteen literals above. Matching is plain
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
  "output_too_large",
  "cancelled",
  "method_not_allowed",
  "not_found",
  "session_not_found",
  "path_traversal",
  "forbidden",
  "internal",
]);

/**
 * Membership test for the fifteen literals above. Use this at boundaries
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
  /**
   * The classified edit refusal (#82), set by the transport from
   * `classifyEditRefusal`. The client reads this field, never the message:
   * a message can carry text the user typed.
   */
  refusal?: EditRefusalKind;
  /** The `insert_blocks` refusal class (#88), read the same way as `refusal`. */
  insertion?: InsertionRefusal;
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
  /** The classified edit refusal, when a transport recognised one (#82). */
  declare readonly refusal?: EditRefusalKind;
  /** The `insert_blocks` refusal class, when a transport recognised one (#88). */
  declare readonly insertion?: InsertionRefusal;

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
    if (options.refusal !== undefined) this.refusal = options.refusal;
    if (options.insertion !== undefined) this.insertion = options.insertion;
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
 * The next step a protected refusal carries, for the kinds whose protection a
 * word processor can lift (#105 item 2).
 *
 * Shared rather than written per transport: it is the same remedy whatever
 * command the engine refused, and one sentence that names no step sends the
 * caller back to the same document. hwp-cli's own messages for these four
 * kinds say the same thing - `한글에서 ... 해제한 뒤/제거한 뒤 다시 저장하세요`
 * (crates/hwp5/src/error.rs) - so the step restates the engine's remedy in
 * English rather than inventing one.
 *
 * Not used for a 배포용 document: see `DISTRIBUTION_NEXT_STEP`.
 */
export const PROTECTED_NEXT_STEP =
  "remove the protection in a word processor that can open it, save a copy, then reopen that copy here";

/**
 * The next step for a 배포용 (distribution) document, which the shared step
 * does not fit: hwp-cli's DistributionDoc message ("배포용 문서(ViewText)의 원본
 * 구조는 지원하지 않습니다") offers no word-processor remedy at all, because a
 * word processor opens such a file without being able to edit it, so "remove
 * the protection and save a copy" names nothing its reader can perform.
 *
 * The two steps here are the ones the engine documents. It reads these
 * documents where it will not edit them (`hwp cat/convert/render는 배포용
 * 문서를 읽을 수 있습니다`, same message), and
 * crates/hwp-cli/src/commands/cat.rs:200-219 records the measurement behind
 * the second step: the hwp5 writer builds every IR output with a fixed
 * attribute word, so a cross-format write does not carry the distribution bit
 * over, while the source-preserving edit path fails closed. hwp-cli's load
 * notice states the same limit to its own users
 * ("다른 형식으로 변환해 저장하면 배포용 보호는 유지되지 않습니다"), which is why
 * this step says what the conversion costs instead of promising a copy that
 * keeps it.
 */
export const DISTRIBUTION_NEXT_STEP =
  "open the original this copy was published from, or convert this copy with hwp convert --to hwpx and open the converted file here; saving in another format does not keep the distribution protection";

/**
 * The five hwp-cli refusals that mean "this document is protected", each with
 * the fixed kind the client is told about and the next step that kind carries.
 * `protectedReasonFromDiagnostics` writes no step of its own, so a sentence
 * cannot be added without saying what its reader can do.
 *
 * These are WHOLE SENTENCES matched as whole lines, not markers. A marker
 * substring was the defect #112 fixed: hwp-cli's stderr also carries the
 * caller's own text (an anchor, a field name, a pattern) and one informational
 * line every distribution load prints, so a marker found anywhere reported an
 * ordinary refusal as a protection refusal and threw away its real cause.
 *
 * Where the sentence comes from. All five are `thiserror` attributes in
 * `crates/hwp5/src/error.rs` (CertEncrypted, CertDrm, Drm, Signed,
 * DistributionDoc; the distribution one has no trailing period), and they are
 * byte-identical at tags v0.20.0, v1.0.0, v1.4.0 and v1.6.1 - no commit in
 * `v0.20.0..v1.6.1` touches that file - which is what lets a fixed string be
 * the contract. A reworded message in some other build degrades to `failed`,
 * which is the safe direction.
 *
 * How it is printed, measured on ahwp 1.6.1. `main` returns
 * `anyhow::Result<()>` (crates/hwp-cli/src/main.rs:11), so Rust's
 * `Termination` prints `Error: {err:?}`; `map_hwp5_read_error`
 * (crates/hwp-cli/src/commands/cat.rs:122-127) wraps the hwp5 error with no
 * context, so that line is the sentence and nothing else, and
 * `LoadDocumentError::source` (cat.rs:107-114) returns the root cause, so
 * anyhow's Debug follows it with a blank line, `Caused by:`, and the same
 * sentence indented four spaces. Two copies of the sentence, both authored by
 * the engine, but only the first one is read, and only when the second ends
 * the report (see `firstEngineErrorLine` and `terminationChain`):
 *
 *     Error: DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 DRM 보안을 ...
 *
 *     Caused by:
 *         DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 DRM 보안을 ...
 *
 * THESE SENTENCES STAY KOREAN PERMANENTLY. Do not delete them after seeing
 * `scrubbedEnv()` pin HWP_LANG in packages/server. HWP_LANG and --lang feed
 * exactly one consumer, `localize()`
 * (hwp-cli/crates/hwp-cli/src/i18n.rs:71-77), which rewrites clap
 * about/help strings; runtime diagnostics are hardcoded Korean thiserror
 * attributes with no locale branch, verified by running the binary under
 * HWP_LANG=en, HWP_LANG=ko and no locale env at all and getting byte-identical
 * Korean output all three times.
 *
 * Deliberately absent:
 * - `경고:` lines. `edit.rs:1297` prints `경고: 앵커 {anchor:?}를 찾지 못했습니다`
 *   and `:1374` the same for a field name, `fill.rs:239-243` interpolates the
 *   unmatched field names, so these carry whatever the caller asked for.
 * - `정보: 배포용 문서를 해제했습니다 ...`, which the shared loader prints on
 *   every distribution load (cat.rs:208-224) and then continues; it is a
 *   successful read, not a refusal.
 * - Password refusals. `Hwp5Error::Encrypted` and `hwpx::HwpxError::Encrypted`
 *   both map to `LoadDocumentError::Password`, whose Display is
 *   `PasswordRefusal`'s, and the CLI takes `--password-stdin`: that document
 *   needs a credential, not its protection lifted, so it stays `failed`.
 * - `지원하지 않습니다` on its own: `Hwp5Error::UnsupportedVersion` is a version
 *   problem, and sending its reader to "remove the protection" is wrong.
 */
const PROTECTED_REFUSALS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "공인 인증서로 암호화된 문서는 지원하지 않습니다. 한글에서 인증서 암호화를 해제한 뒤 다시 저장하세요.",
    "encrypted document",
    PROTECTED_NEXT_STEP,
  ],
  [
    "공인 인증서 DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 인증서 DRM 보안을 해제한 뒤 다시 저장하세요.",
    "DRM-protected document",
    PROTECTED_NEXT_STEP,
  ],
  [
    "DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 DRM 보안을 해제한 뒤 다시 저장하세요.",
    "DRM-protected document",
    PROTECTED_NEXT_STEP,
  ],
  [
    "서명된 문서는 지원하지 않습니다. 한글에서 서명을 제거한 뒤 다시 저장하세요.",
    "signed document",
    PROTECTED_NEXT_STEP,
  ],
  [
    "배포용 문서(ViewText)의 원본 구조는 지원하지 않습니다. hwp cat/convert/render는 배포용 문서를 읽을 수 있습니다",
    "distribution (배포용) document",
    DISTRIBUTION_NEXT_STEP,
  ],
];

/** The label `Termination` puts in front of a failed command's message. */
const ENGINE_ERROR_LABEL = "Error: ";

/**
 * The head the desktop bridge puts in front of hwp-cli's stderr
 * (dev/maru/src-tauri/src/hwped.rs run_hwp_ok): `hwp_failed: hwp <cmd> failed
 * (exit N): ` and then that stderr verbatim, on the same line.
 */
const TRANSPORT_HEAD = /^hwp_failed: hwp \S+ failed \(exit -?\d+\): /u;

/**
 * The engine's own diagnostics: `text` with the bridge's head taken off its
 * first line, which is where maru pastes hwp-cli's stderr.
 */
function engineDiagnostics(text: string): string {
  const lines = text.split(/\r?\n/u);
  const head = TRANSPORT_HEAD.exec(lines[0] ?? "");
  if (head === null) return lines.join("\n");
  lines[0] = (lines[0] ?? "").slice(head[0].length);
  return lines.join("\n");
}

/**
 * The message of the FIRST line-start `Error:` line in the engine's report, or
 * null when there is none.
 *
 * Only the first one can be the engine's. `Termination` writes the failure
 * line once, before the process exits, and everything hwp-cli prints before it
 * is fixed text (`cat.rs`'s `정보: 배포용 문서를 해제했습니다 ...`) or a value it
 * escapes with `{:?}` (`edit.rs`'s anchors and field names). The raw
 * interpolations - `fill`'s unmatched key list, and `edit.rs:1394`'s
 * `메타데이터 설정: {spec}` for a `set-meta` key or value - sit INSIDE a message
 * the engine wrote, after a fixed prefix, so they add lines instead of
 * replacing the engine's own. That line alone is not proof, though: the one
 * that lands before Termination's is kept out by `terminationChain`, which
 * every caller must also require.
 *
 * The message is compared whole, so nothing may follow the sentence either:
 * `fill`'s ` (--allow-partial로 ...)` hint and `edit`'s `{anchor:?}` quoting
 * both leave a value that holds a sentence with text after it on its line.
 */
function firstEngineErrorLine(report: string): string | null {
  for (const line of report.split(/\r?\n/u)) {
    if (line.startsWith(ENGINE_ERROR_LABEL)) {
      return line.slice(ENGINE_ERROR_LABEL.length);
    }
  }
  return null;
}

/**
 * The lines Termination puts between its `Error:` line and the copy of the
 * message: a blank line, the `Caused by:` label, and four spaces of indent.
 */
const CAUSE_BLOCK = "\n\nCaused by:\n    ";

/**
 * Termination's whole chain for one message: the `Error:` line, the blank
 * line, `Caused by:` and the root cause indented four spaces. Measured on
 * ahwp 1.6.1 through both `hwp cat` and `hwp edit` against a file that is not
 * a document, and spot-checked at v0.20.0.
 *
 * Only an error carrying a root cause prints the block: `map_hwp5_read_error`
 * (cat.rs:122-127) wraps the hwp5 error with no context and
 * `LoadDocumentError::source` (cat.rs:107-114) returns it, which is why a
 * protection refusal has one, while a plain `anyhow::bail!` prints the
 * `Error:` line alone. A contexted error puts `<input path>: ` in front of the
 * indented copy, so a copy the engine printed twice verbatim is the only shape
 * that matches.
 */
function terminationChain(message: string): string {
  return `${ENGINE_ERROR_LABEL}${message}${CAUSE_BLOCK}${message}`;
}

/**
 * The head anyhow's Debug appends when a backtrace is captured: a blank line
 * and `Stack backtrace:`, then one frame per line. Read from anyhow 1.0.104
 * (`fmt.rs:46-61`, the version in hwp-cli v1.6.1's Cargo.lock) and measured on
 * ahwp 1.6.1 with `RUST_BACKTRACE=1 hwp cat` on a file that is not a document:
 * the block follows the `Caused by:` copy, so the diagnostics no longer END
 * with the chain while a protection refusal still printed it.
 *
 * `RUST_BACKTRACE` reaches the engine through maru, whose `run_hwp` passes the
 * environment through unchanged (`dev/maru/src-tauri/src/hwped.rs`, it sets
 * only `PATH`), so this is a shape the desktop transport really produces and
 * not a hypothetical.
 */
const BACKTRACE_HEAD = "\n\nStack backtrace:";

/**
 * The engine's report with any backtrace block cut off, so the chain check
 * reads the same with and without `RUST_BACKTRACE`.
 *
 * Cut at the LAST occurrence: the engine appends its block once, after
 * Termination's, so anything earlier is caller text an op value planted, and
 * dropping the tail there only ever rejects a reading.
 */
function withoutBacktrace(diagnostics: string): string {
  const traced = diagnostics.lastIndexOf(BACKTRACE_HEAD);
  return traced < 0 ? diagnostics : diagnostics.slice(0, traced);
}

/**
 * The protection backstop, shared by every transport that sees raw hwp-cli
 * diagnostics. Returns the kind of protection with the next step that kind
 * carries, or null.
 *
 * Lives in core, not in one transport, because the sentences are hwp-cli's
 * vocabulary rather than any single transport's: the CLI server reads them out
 * of `HwpCliError.stderr` and the Tauri bridge out of maru's rejection string,
 * which carries the engine's stderr verbatim after its own `hwp_failed:` head.
 * A second copy would drift the moment hwp-cli rewords a message.
 *
 * The result names no command: the sentence is shared by `edit`, `compose`,
 * `lint`, `slots`, `fields` and `fill`, so a transport that ran one of them
 * puts its own `hwp <command>` line in front rather than this function
 * claiming `edit/compose` every time (#105 item 2).
 *
 * The line read is the engine's first `Error:` line, the comparison is exact,
 * and the report must END with Termination's chain for that line (see
 * `firstEngineErrorLine` and `terminationChain`), so no echoed value, warning,
 * informational line or pattern can select a kind. A `Stack backtrace:` block
 * anyhow appends below the chain is cut first (`withoutBacktrace`), because a
 * host that captures backtraces would otherwise lose a reading this transport
 * makes today.
 *
 * The argument is never interpolated into the result: raw CLI output stays on
 * whatever non-serialized field its transport keeps it on, so this path adds
 * no new CLI-output-to-client leak (Phase 4 SEC-06 owns the pre-existing one
 * in the server's `runCliOk`).
 */
export function protectedReasonFromDiagnostics(text: string): string | null {
  const report = withoutBacktrace(engineDiagnostics(text));
  const message = firstEngineErrorLine(report);
  if (message === null) return null;
  // The tail is what proves the line above is Termination's and not a line an
  // op value planted: the engine writes the block once, last, and only when
  // the failure carries the root cause a protection refusal has.
  if (!report.trimEnd().endsWith(terminationChain(message))) return null;
  for (const [sentence, kind, step] of PROTECTED_REFUSALS) {
    if (message === sentence) return `${kind}; ${step}`;
  }
  return null;
}
