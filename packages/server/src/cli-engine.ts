/**
 * CliEngine — HwpEngine implementation that shells out to the hwp-cli binary.
 *
 * Hardening ported from the ax deployment wrapper (sites/ax/lib/hwp-cli.ts):
 * execFile only (never a shell), an owned 60s budget enforced by this
 * module's own AbortController with SIGTERM-to-SIGKILL escalation (execFile's
 * built-in `timeout` signals once and never escalates, so a signal-ignoring
 * child would hang the request past every budget), a 32MB maxBuffer on every
 * invocation, a scrubbed child environment, and per-call temp directories
 * that are removed on every path including failure. The runCli promise
 * settles ONLY from the execFile callback, which fires after the child has
 * exited; that is what keeps `withWorkDir`'s removal ordered strictly after
 * child exit, so a racing timer must never settle it. Generalizations: the
 * binary is resolved by option/env/PATH instead of a bundled artifact (this
 * package runs on developer machines and servers, not one fixed lambda), and
 * the per-process verification is a minimum-version check instead of a
 * pinned checksum (there is no single reviewed artifact here).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  OP_FLAGS,
  opsToArgv,
  parseCatEnvelope,
  protectedReasonFromDiagnostics,
  type Capabilities,
  type CatEnvelope,
  type ComposeResult,
  type DocumentHandle,
  type DocumentSpecV2,
  type EditOp,
  type EditOptions,
  type HwpEngine,
  type HwpErrorCode,
  type PageImage,
  type PageImageFormat,
  type RenderOptions,
  type ValidationError,
  type ValidationReport,
} from "@hwp-editor/core";

export const HWP_TIMEOUT_MS = 60_000;
const HWP_MAX_BUFFER = 32 * 1024 * 1024;
/**
 * Grace between SIGTERM and SIGKILL. A convention, not a measurement:
 * hwp-cli does no cleanup on signal, so any value is safe, and the engine's
 * 60s budget makes the exact figure uncritical.
 */
const KILL_GRACE_MS = 3_000;
const MIN_VERSION: readonly [number, number, number] = [0, 16, 0];

/**
 * Upper bound on the accepted binary, EXCLUSIVE.
 *
 * The floor is hard because a binary below it lacks flags this engine emits.
 * The ceiling is deliberately only a major-version gate, and stays one now
 * that the floor equals the tested tag. A major bump is the one signal
 * upstream gives that the contract may have broken; everything below it is
 * carried by the flag handshake, which checks what the binary actually
 * accepts rather than what it calls itself. A tighter numeric ceiling would
 * catch nothing the handshake misses, and would refuse a patch release on a
 * version string alone.
 */
const MAX_VERSION_EXCLUSIVE: readonly [number, number, number] = [1, 0, 0];

/**
 * A long flag as `--help` prints it, matched on both boundaries.
 *
 * The trailing lookahead is the whole point: a naive `help.includes(flag)`
 * passes for any flag that is a prefix of another, and the real `hwp edit
 * --help` contains both `--set-cell` and `--set-cell-by-label`. A binary that
 * dropped the first while keeping the second would sail through a substring
 * test and then fail at edit time.
 */
const FLAG_TOKEN = /(?:^|\s)(--[a-z][a-z0-9-]*)(?=[\s,=<]|$)/gm;

/**
 * The flag surface the resolved binary must accept before this engine will
 * use it. Derived from the grammar's own table, so adding an op kind widens
 * the check automatically and no second list can drift.
 *
 * Scope is `edit` only. `--verify` and `--allow-partial` are the two other
 * flags this engine puts on an `edit` argv and come out of the same 5.5 KB
 * help output for free. The flags hardcoded on the other eight subcommands
 * (cat, render, compose, validate, info, fields, bookmarks, slots) are a
 * known, accepted gap: `edit` is the whole 28-op surface and the highest-risk
 * one, and covering the rest would cost four or five more `--help` spawns on
 * every cold serverless start.
 */
const HANDSHAKE_FLAGS: readonly string[] = [
  ...Object.values(OP_FLAGS),
  "--verify",
  "--allow-partial",
];

/** Hancom binary .hwp is a CFBF (OLE2) container; .hwpx is a zip. */
const CFBF_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** The eight-byte PNG file signature (PNG spec 5.2). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The engine half of the published `HwpErrorCode` vocabulary. Derived with
 * `Extract<>` rather than aliased to the full union on purpose: an alias
 * would make `statusFor`'s switch (routes.ts) non-exhaustive by five at
 * once, and the natural fix for that is a `default:` clause, which
 * permanently destroys the exhaustiveness check that must catch the next
 * code addition.
 *
 * `cancelled` and `output_too_large` were added in Phase 4. Both are engine
 * reasons rather than route-layer codes because both are decided inside
 * `runCli`, from a cause this module owns: only the code that started the
 * child knows whether it ended because the caller went away or because it
 * outran the stdout ceiling. A route-layer code would have to re-infer that
 * from an error shape, which is exactly the guessing this rewrite removed.
 */
export type HwpCliErrorReason = Extract<
  HwpErrorCode,
  | "unavailable"
  | "version"
  | "timeout"
  | "failed"
  | "bad_request"
  | "unsupported_format"
  | "protected"
  | "cancelled"
  | "output_too_large"
>;

/**
 * Two channels, and which one you use decides who sees it.
 *
 * `message` is serialized into the `ErrorResponse` body and crosses the wire
 * to an untrusted client, so it carries the operation and the outcome and
 * nothing else — never the resolved binary path, never a staged temp path,
 * never raw CLI stdout or stderr. `stderr` and `detail` are NOT serialized by
 * `routes.ts`; they are where that context is retained.
 *
 * The scrub is a property of construction rather than a filter applied on the
 * way out: a filter has to be remembered at every new throw site, and the one
 * that is forgotten is the one that leaks.
 *
 * There is no logger in this package, per the no-`console` convention that
 * holds across every package source tree. The host catches the error and
 * decides what to do with `stderr` and `detail` — log them, surface them to
 * an operator, discard them. This module does not make that choice for it.
 */
export class HwpCliError extends Error {
  constructor(
    public readonly reason: HwpCliErrorReason,
    message: string,
    /** Raw child stderr, verbatim. Read by `protectedReasonFromStderr`. */
    public readonly stderr?: string,
    /** Operator-facing context: the resolved binary path, CLI output. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "HwpCliError";
  }
}

/** `bin` alone, or `bin: output` — the standard shape of a `detail`. */
function detailFor(bin: string, output?: string): string {
  const trimmed = output?.trim() ?? "";
  return trimmed === "" ? bin : `${bin}: ${trimmed}`;
}

export interface CliEngineOptions {
  /**
   * Explicit path to the hwp binary. Resolution order: this option ->
   * HWP_EDITOR_BIN env -> HWP_CLI env -> `hwp` on PATH.
   */
  bin?: string;
  /**
   * Per-invocation timeout in ms, default HWP_TIMEOUT_MS. Hosts with a hard
   * request budget (e.g. a 60s serverless function) should set this a few
   * seconds below it so the engine's 504 beats the platform's kill.
   */
  timeoutMs?: number;
  /**
   * Language passed to the child as HWP_LANG, default `en`. Accepts
   * `en`/`eng`/`english`/`c`/`posix` and `ko`/`kor`/`korean`. This sets
   * HWP_LANG only: LANG, LC_ALL and LC_MESSAGES stay pinned to `C.UTF-8`
   * regardless, so a host cannot accidentally change the child's encoding
   * while changing its language.
   */
  locale?: string;
}

/** Everything `read` gathers beyond the pinned CatEnvelope wire shape. */
export interface DocumentInspection {
  envelope: CatEnvelope;
  /** Raw `hwp fields --json` payload (array), null on failure. */
  fields: unknown;
  /** Raw `hwp bookmarks --json` payload (array), null on failure. */
  bookmarks: unknown;
  /** Raw `hwp slots --json` payload (object), null on failure. */
  slots: unknown;
  /** Raw `hwp info --json` payload, null on failure. */
  info: unknown;
  /** Per-document editability derived from `info` (see below). */
  capabilities: { editable: boolean; reason?: string };
}

/**
 * Per-call options this transport accepts beyond the `HwpEngine` contract.
 *
 * Carried as an extra OPTIONAL trailing parameter on every spawning method,
 * which keeps each method assignable to its `HwpEngine` counterpart: the
 * shared interface in `packages/core` is not widened, so the three
 * transports stay interchangeable.
 */
export interface CliCallOptions {
  /**
   * Aborting this terminates the child (SIGTERM, then SIGKILL after the
   * grace) and rejects with reason `cancelled`. Route handlers pass
   * `req.signal` so a client that disconnects does not leave an orphan.
   */
  signal?: AbortSignal;
  /**
   * Tenant scope from the server's `authorize` hook, salted into every cache
   * key this engine owns (SEC-04, D-07). One engine instance serves every
   * request a handler sees, so `inspections` and `snapshots` are otherwise a
   * cross-tenant channel: two callers uploading identical bytes would share
   * both entries.
   *
   * The engine RECEIVES a scope and never derives one — the single
   * `authorize` call in routes.ts is the only place it is decided. Omitting
   * it uses `DEFAULT_CALL_SCOPE`, so a direct `CliEngine` consumer with no
   * tenancy of its own keeps working unchanged.
   */
  scope?: string;
}

export interface CliEngine extends HwpEngine {
  /**
   * Full read pipeline: cat --with-segments plus fields/bookmarks/slots/info.
   * `read()` is this with the extras dropped, per the pinned wire contract.
   */
  describe(document: DocumentHandle, call?: CliCallOptions): Promise<DocumentInspection>;
  read(document: DocumentHandle, call?: CliCallOptions): Promise<CatEnvelope>;
  render(
    document: DocumentHandle,
    options?: RenderOptions,
    call?: CliCallOptions,
  ): Promise<PageImage[]>;
  edit(
    document: DocumentHandle,
    ops: EditOp[],
    options?: EditOptions,
    call?: CliCallOptions,
  ): Promise<DocumentHandle>;
  compose(
    spec: DocumentSpecV2,
    name: string,
    call?: CliCallOptions,
  ): Promise<ComposeResult>;
  validate(document: DocumentHandle, call?: CliCallOptions): Promise<ValidationReport>;
  /**
   * Return the pre-edit snapshot of a document this engine edited, or null.
   * Keyed by the edited document's content hash SALTED WITH THE CALL SCOPE;
   * consumed on use. Takes the same trailing options as the spawning methods
   * (it spawns nothing, but its read must salt exactly as `edit`'s write did,
   * or a scoped write is findable by nobody).
   */
  undo(document: DocumentHandle, call?: CliCallOptions): DocumentHandle | null;
  /** Resolved binary path and verified version. */
  binaryInfo(): Promise<{ bin: string; version: string }>;
}

/**
 * The only `HWP_*` variables copied from the operator's environment.
 *
 * An explicit list of one rather than the `HWP_` prefix it replaces: hwp-cli
 * 0.14.0 reads roughly two dozen `HWP_*` variables, the prefix is upstream's
 * namespace, and upstream adds to it freely — so a prefix match silently
 * admits whatever the next release invents. `HWP_CERTIFY_ORACLE_RUNTIME` is
 * the illustration: hwp-cli reads it as a path to an executable
 * (crates/hwp-cli/src/certification.rs), reachable only through `hwp
 * certify`, which this engine never invokes.
 *
 * Of the whole set exactly two matter here, and one of them (`HWP_LANG`) is
 * pinned unconditionally below, so the pass-through gave it nothing. A host
 * that needs another variable should get a new option for it rather than a
 * wider window onto the ambient environment.
 */
const HWP_ENV_ALLOWLIST = ["HWP_FONT_DIR"] as const;

export function scrubbedEnv(locale?: string): Record<string, string> {
  // An inherited env is the usual way a subprocess reaches credentials it has
  // no business with. The CLI needs PATH (for helpers) and little else;
  // HWP_* is the CLI's own configuration surface (HWP_LANG, HWP_FONT_DIR...).
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of HWP_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The four locale variables are pinned AFTER the allow-list, which is the
  // only thing that could copy an inherited HWP_LANG in. hwp-cli's precedence
  // chain is --lang -> HWP_LANG -> LC_ALL -> LC_MESSAGES -> LANG
  // (i18n.rs:36-68); LC_MESSAGES is pinned alongside the other two so no link
  // is left open for whoever adds an entry to HWP_ENV_ALLOWLIST later. C.UTF-8 over
  // en_US.UTF-8 because it exists in slim container images, where an
  // ungenerated en_US.UTF-8 silently degrades to C and breaks UTF-8 handling.
  // hwp-cli's Lang::parse splits on `.`, `_`, `-`, `@` and lowercases the
  // head, so `c` and `posix` also resolve to English; `en` is just canonical.
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  env.LC_MESSAGES = "C.UTF-8";
  env.HWP_LANG = locale?.trim() || "en";
  return env;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Every terminal cause below is a value this module chose. Nothing is
 * inferred from `error.signal`: measured, a built-in timeout and a foreign
 * SIGTERM are byte-identical there, while a maxBuffer overflow and an abort
 * set no signal at all.
 */
function runCli(
  bin: string,
  args: string[],
  timeoutMs: number = HWP_TIMEOUT_MS,
  // Required (not optional) on purpose: tsc then enumerates every call site
  // rather than letting one silently keep the default locale.
  locale: string | undefined,
  // Required for the same reason: a once-per-process path (ensureVersion)
  // must pass `undefined` explicitly, because one cancelled request must
  // never poison binary verification for every later request.
  requestSignal: AbortSignal | undefined,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Already gone before the child exists: an aborted signal never
    // re-dispatches, so a listener added now would never fire and the child
    // would run to completion for a caller that stopped listening.
    if (requestSignal?.aborted === true) {
      reject(new HwpCliError("cancelled", `hwp ${args[0] ?? ""} was cancelled by the caller`));
      return;
    }
    let cause: "timeout" | "cancelled" | null = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    /**
     * SIGTERM once, then SIGKILL after the grace, because execFile escalates
     * never and `child.killed` means only that a signal was delivered.
     *
     * The kill is done here rather than by handing execFile a `signal`
     * option: measured, Node's abort path destroys the child's stdio and
     * fires the callback the instant it delivers SIGTERM, which would settle
     * this promise — and so run withWorkDir's `finally` — while a
     * signal-ignoring child still held the staged input. Killing the child
     * directly leaves the callback on the real exit, which is what SEC-09's
     * ordering clause needs. `escalation` doubles as the already-signalled
     * guard, so a cancellation after a timeout does not re-send.
     */
    const signalChild = () => {
      if (escalation !== undefined) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      escalation.unref();
    };

    const timer = setTimeout(() => {
      cause = "timeout";
      signalChild();
    }, timeoutMs);
    // `??=`: a cancellation arriving after the timeout fired must not
    // relabel it, so two racing causes settle deterministically as whichever
    // was recorded first.
    const onCancel = () => {
      cause ??= "cancelled";
      signalChild();
    };
    requestSignal?.addEventListener("abort", onCancel, { once: true });

    // The only settle site. It fires after the child has exited, which is
    // what keeps withWorkDir's removal ordered after exit (SEC-09): never
    // race this against a timer.
    const child = execFile(
      bin,
      args,
      {
        maxBuffer: HWP_MAX_BUFFER,
        env: scrubbedEnv(locale),
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (escalation !== undefined) clearTimeout(escalation);
        requestSignal?.removeEventListener("abort", onCancel);
        // The recorded cause outranks the exit status, and is therefore read
        // FIRST. `cause` is set only by the timer or the abort listener, and
        // each of those also signalled the child - so a zero exit after one
        // of them means the child chose to exit zero on SIGTERM (a wrapper
        // that traps and cleans up), not that the run succeeded. Reading
        // `error === null` first reported a blown deadline, or a request the
        // caller had abandoned, as a normal 200 with a complete body.
        if (cause === "timeout") {
          reject(new HwpCliError("timeout", `hwp ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
          return;
        }
        if (cause === "cancelled") {
          reject(new HwpCliError("cancelled", `hwp ${args[0] ?? ""} was cancelled by the caller`));
          return;
        }
        if (error === null) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const raw = (error as { code?: unknown }).code;
        if (raw === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new HwpCliError(
            "output_too_large",
            `hwp ${args[0] ?? ""} produced more than ${HWP_MAX_BUFFER} bytes on stdout`,
          ));
          return;
        }
        if (raw === "ENOENT") {
          // `binary not found` is pinned: packages/react/src/errors.ts
          // substring-matches it for the pre-1.0 fallback classifier. The
          // scrub moves the path off the message, it does not reword this.
          reject(new HwpCliError(
            "unavailable",
            "hwp binary not found (install hwp-cli >= 0.16.0, or set HWP_EDITOR_BIN / the bin option)",
            undefined,
            detailFor(bin),
          ));
          return;
        }
        // Non-zero exit still carries stdout/stderr; let callers that expect
        // failure output (validate) inspect it instead of always throwing.
        resolve({ stdout, stderr, code: typeof raw === "number" ? raw : 1 });
      },
    );
  });
}

/** Run a command that must succeed; throw a rich error otherwise. */
async function runCliOk(
  bin: string,
  args: string[],
  timeoutMs: number | undefined,
  locale: string | undefined,
  requestSignal: AbortSignal | undefined,
): Promise<RunResult> {
  const result = await runCli(bin, args, timeoutMs, locale, requestSignal);
  if (result.code !== 0) {
    // The subcommand and the exit code, and nothing else: the CLI's own text
    // routinely names the staged input file, so interpolating it here would
    // hand a temp path to whoever made the request.
    throw new HwpCliError(
      "failed",
      `hwp ${args[0] ?? ""} failed (exit ${result.code})`,
      result.stderr,
      detailFor(bin, result.stderr.trim() || result.stdout.trim()),
    );
  }
  return result;
}

function parseVersion(stdout: string): [number, number, number] | null {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(v: [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! > min[i]!) return true;
    if (v[i]! < min[i]!) return false;
  }
  return true;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Scope used when a caller supplies none; see `CliCallOptions.scope`. */
const DEFAULT_CALL_SCOPE = "default";

/**
 * The key for every entry in this engine's two caches: the content hash
 * salted with the tenant scope (SEC-04, D-07).
 *
 * Written once so `inspections` and `snapshots` cannot disagree about the
 * separator, and so `edit`'s snapshot write and `undo`'s read are the same
 * expression. The `\0` separator is what makes the pair unambiguous: without
 * it a scope ending in hex digits could produce the key some other scope
 * produces for different content.
 */
function cacheKey(scope: string | undefined, data: Uint8Array): string {
  return createHash("sha256")
    .update(`${scope ?? DEFAULT_CALL_SCOPE}\0${sha256(data)}`)
    .digest("hex");
}

function sniffExtension(document: DocumentHandle): ".hwp" | ".hwpx" {
  const ext = path.extname(document.name).toLowerCase();
  if (ext === ".hwp" || ext === ".hwpx") return ext;
  const isCfbf =
    document.data.length >= CFBF_SIGNATURE.length &&
    CFBF_SIGNATURE.every((byte, i) => document.data[i] === byte);
  return isCfbf ? ".hwp" : ".hwpx";
}

/** Basename + validated extension, so a hostile name can never escape tmp. */
function safeOutputName(name: string, fallbackExt: ".hwp" | ".hwpx"): string {
  const base = path.basename(name).replace(/[^\w.가-힣-]/g, "_") || `document${fallbackExt}`;
  const ext = path.extname(base).toLowerCase();
  if (ext === ".hwp" || ext === ".hwpx") return base;
  return `${base}${fallbackExt}`;
}

async function tryJson(
  bin: string,
  args: string[],
  timeoutMs: number | undefined,
  locale: string | undefined,
  requestSignal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    const result = await runCliOk(bin, args, timeoutMs, locale, requestSignal);
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    // Best-effort covers this probe failing, not the whole request ending. A
    // cancellation belongs to the request: swallowing it let describe()
    // resolve - and then CACHE - an all-null inspection for a caller that was
    // already gone, and answer 200 where the contract says 499. The cache
    // never re-probes a hit, so that entry degraded every later request for
    // the same document under the same scope. Rethrowing here is what keeps
    // describe()'s cache write unreachable on a cancelled call.
    if (error instanceof HwpCliError && error.reason === "cancelled") throw error;
    return null;
  }
}

/**
 * hwp5 protection labels exactly as `hwp info --json` emits them in
 * `attributes[]` (hwp-cli/crates/hwp5/src/file_header.rs:220-236).
 * `check_body_readable()` refuses five conditions (Encrypted, CertEncrypted,
 * CertDrm, Drm, Signed) but `info --json` exposes only two of them as
 * booleans, so without this table four protection kinds pass the pre-flight
 * silently. Best-effort only: the 0.8.7 changelog, which introduced these
 * refusals, states the certificate/DRM/signature branches are unverified
 * against a genuine protected file, and no release through 0.16.1 has since
 * verified them - 0.11.0 added password-protected read and left those three
 * on "their existing typed refusals". So the marker table behind
 * `protectedReasonFromStderr` (the stderr backstop, shared from core) is what
 * actually carries the requirement.
 */
const PROTECTED_ATTRIBUTES: Readonly<Record<string, string>> = {
  "DRM 보안": "DRM-protected document (DRM 보안)",
  "공인 인증서 암호화": "certificate-encrypted document (공인 인증서 암호화)",
  "공인 인증서 DRM 보안": "certificate DRM-protected document (공인 인증서 DRM 보안)",
  "전자 서명 정보": "signed document (전자 서명 정보)",
};

/**
 * Distribution/encrypted documents: hwp-cli reads them but refuses edit/fill.
 *
 * The origin is the 0.8.7 changelog, not a later one. 0.8.7 added reading of
 * Hancom distribution documents to `cat`/`convert`/`render` and stated that
 * the source-preserving edit path (`hwp edit`, `hwp fill`) still refuses
 * them, because their content lives in ViewText streams rather than BodyText,
 * so there is no source structure to rewrite against. Every section through
 * 0.16.1 was checked and none reverses it; 0.11.0 corrects its own READMEs
 * for having described these documents as refused "although they have been
 * read since v0.8.7", which is about the read path, not the edit path.
 *
 * The evidence is upstream's, not ours. Besides the changelog, hwp-cli's
 * own `crates/hwp-cli/src/commands/cat.rs` at tag v0.16.0 records that
 * "the source-preserving edit path fails closed on a /ViewText-only
 * document instead of writing anything", attributed to a 2026-08-20
 * measurement against a genuine distribution document. This repository
 * has no distribution-document fixture and hwp-cli cannot synthesize one,
 * so the refusal has not been observed here. The reason strings below name no
 * version on purpose: they reach the host as `capabilities.reason`, where a
 * version number is a maintenance liability with no reader benefit.
 */
export function documentEditability(info: unknown): { editable: boolean; reason?: string } {
  if (typeof info !== "object" || info === null) return { editable: true };
  const record = info as Record<string, unknown>;
  if (record["encrypted"] === true) {
    return { editable: false, reason: "encrypted document; hwp-cli refuses edit/fill" };
  }
  if (record["distribution"] === true) {
    return {
      editable: false,
      reason: "distribution (배포용) document; hwp-cli refuses edit/fill",
    };
  }
  const attributes = record["attributes"];
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      const label = typeof attribute === "string" ? PROTECTED_ATTRIBUTES[attribute] : undefined;
      if (label !== undefined) {
        return { editable: false, reason: `${label}; hwp-cli refuses edit/fill` };
      }
    }
  }
  return { editable: true };
}

/**
 * The stderr backstop for this transport, kept under its stderr-specific
 * name because that is what this transport actually reads. The marker table
 * itself lives in `@hwp-editor/core`: hwp-cli's Korean diagnostics are its
 * vocabulary, not the CLI server's, and the Tauri bridge needs the same
 * table for the same reason (a second copy would drift the moment hwp-cli
 * rewords a message).
 *
 * The stderr argument is never interpolated into the result: raw CLI output
 * stays on the non-serialized `HwpCliError.stderr` field, so this path adds
 * no new CLI-output-to-client leak (Phase 4 SEC-06 owns the pre-existing one
 * in `runCliOk`).
 */
export function protectedReasonFromStderr(stderr: string): string | null {
  return protectedReasonFromDiagnostics(stderr);
}

/**
 * Rethrow a generic CLI failure as `protected` when its stderr carries a
 * protection marker. Applied at the `edit` and `compose` call sites only,
 * never inside `runCliOk`: that is what keeps `read` and `render` succeeding
 * on protected documents hwp-cli can still read (D-11).
 */
function rethrowProtected(error: unknown): never {
  if (error instanceof HwpCliError && error.reason === "failed") {
    const message = protectedReasonFromStderr(error.stderr ?? "");
    if (message !== null) throw new HwpCliError("protected", message, error.stderr);
  }
  throw error;
}

/**
 * A page dimension is only trustworthy when it is finite and strictly
 * positive. `PageCanvas`'s `aspectRatio` collapses on a zero, and
 * `page.width_pt` upstream is an `f32`, so a degenerate value means the
 * producer emitted corruption rather than that this parser mis-read it.
 */
function positiveSize(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Dimensions from a PNG IHDR. Exported for `render-size.test.ts`; deliberately
 * NOT re-exported from `src/index.ts` — this is engine-internal parsing.
 *
 * The signature AND the `IHDR` chunk type are both validated before any
 * integer is read: a length check alone lets any payload of 24 bytes or more
 * yield two arbitrary uint32s presented to the client as real dimensions,
 * which fails invisibly and so is worse than the 0x0 BUG-04 names.
 */
export function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, i) => data[i] !== byte)) return null;
  // ASCII "IHDR" must be the first chunk type, at offsets 12-15.
  if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return positiveSize(view.getUint32(16), view.getUint32(20));
}

const SVG_UNITS = "pt|px|mm|in|cm|em|%";

/**
 * Dimensions from an SVG root tag. Exported for `render-size.test.ts` only.
 *
 * The numeric pattern stays `[\d.]+` on purpose: `NaN`, `inf` and a leading
 * minus are exactly the degenerate `f32` spellings this must reject, not
 * gaps to widen away.
 */
export function svgSize(source: string): { width: number; height: number } | null {
  const tag = source.match(/<svg\b[^>]*>/i);
  if (tag === null) return null;
  const width = tag[0].match(new RegExp(`\\bwidth="([\\d.]+)(${SVG_UNITS})?"`, "i"));
  const height = tag[0].match(new RegExp(`\\bheight="([\\d.]+)(${SVG_UNITS})?"`, "i"));
  if (width !== null && height !== null) {
    // The numbers feed PageCanvas's aspectRatio, meaningful only when both
    // dimensions share a unit. A mixed-unit tag (210mm x 841.86pt) must
    // fail loudly here rather than silently render a wrong ratio; no unit
    // conversion — hwp-cli emits pt only.
    if ((width[2] ?? "") !== (height[2] ?? "")) return null;
    return positiveSize(Number(width[1]), Number(height[1]));
  }
  // An attribute that is present but unparseable (`NaN`, `inf`, `-5.00`) is a
  // degenerate producer value, not an absent attribute: reject rather than
  // silently substituting the viewBox, which would resurrect the guess D-16
  // exists to remove.
  if (/\b(?:width|height)="/i.test(tag[0])) return null;
  // Defensive padding against a future upstream change: hwp-cli's only SVG
  // root emission always writes both attributes (hwp-render/src/svg.rs:17-26).
  const viewBox = tag[0].match(/\bviewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/i);
  if (viewBox === null) return null;
  return positiveSize(Number(viewBox[1]), Number(viewBox[2]));
}

function parseSinglePage(pages: string | undefined): number | null {
  if (pages !== undefined && /^\d+$/.test(pages)) return Number(pages);
  return null;
}

export function createCliEngine(opts: CliEngineOptions = {}): CliEngine {
  const timeoutMs = opts.timeoutMs ?? HWP_TIMEOUT_MS;

  function resolveBin(): string {
    const fromOpts = opts.bin?.trim();
    if (fromOpts) return fromOpts;
    const fromEditorEnv = process.env.HWP_EDITOR_BIN?.trim();
    if (fromEditorEnv) return fromEditorEnv;
    const fromCliEnv = process.env.HWP_CLI?.trim();
    if (fromCliEnv) return fromCliEnv;
    return "hwp";
  }

  // One version verification per resolved binary per process.
  let verifiedVersion: Promise<string> | null = null;
  function ensureVersion(): Promise<string> {
    verifiedVersion ??= (async () => {
      const bin = resolveBin();
      let result: RunResult;
      try {
        // No request signal, deliberately: this memo is shared by every
        // later request in the process, so one cancellation must not poison
        // binary verification for all of them.
        result = await runCli(bin, ["--version"], timeoutMs, opts.locale, undefined);
      } catch (error) {
        if (error instanceof HwpCliError) throw error;
        // `not executable` is pinned: packages/react/src/errors.ts
        // substring-matches it for the pre-1.0 fallback classifier. The path
        // and the underlying error text move to `detail`; the phrase stays.
        throw new HwpCliError(
          "unavailable",
          "hwp binary is not executable (set HWP_EDITOR_BIN or the bin option)",
          undefined,
          detailFor(bin, error instanceof Error ? error.message : String(error)),
        );
      }
      if (result.code !== 0) {
        throw new HwpCliError(
          "unavailable",
          `hwp --version failed (exit ${result.code})`,
          result.stderr,
          detailFor(bin, result.stderr),
        );
      }
      const version = parseVersion(result.stdout);
      if (version === null) {
        throw new HwpCliError(
          "version",
          "cannot parse a semver from the hwp --version output",
          undefined,
          detailFor(bin, result.stdout),
        );
      }
      // The parsed numbers are this engine's own reading, not CLI output, so
      // stating them is what makes a version message actionable.
      if (!versionAtLeast(version, MIN_VERSION)) {
        throw new HwpCliError(
          "version",
          `hwp ${version.join(".")} is too old; >= ${MIN_VERSION.join(".")} required`,
          undefined,
          detailFor(bin),
        );
      }
      if (versionAtLeast(version, MAX_VERSION_EXCLUSIVE)) {
        throw new HwpCliError(
          "version",
          `hwp ${version.join(".")} is newer than this engine supports; ` +
            `< ${MAX_VERSION_EXCLUSIVE.join(".")} required`,
          undefined,
          detailFor(bin),
        );
      }
      // Flag handshake, inside this same memo rather than a second one: it
      // runs once per process for the same reason the version check does, and
      // with the same explicitly `undefined` request signal, so one cancelled
      // request can never poison binary verification for every later one.
      const help = await runCli(bin, ["edit", "--help"], timeoutMs, opts.locale, undefined);
      if (help.code !== 0) {
        throw new HwpCliError(
          "version",
          `hwp edit --help failed (exit ${help.code}); the edit flag surface cannot be verified`,
          help.stderr,
          detailFor(bin, help.stderr),
        );
      }
      const present = new Set([...help.stdout.matchAll(FLAG_TOKEN)].map((match) => match[1]!));
      const missing = HANDSHAKE_FLAGS.filter((flag) => !present.has(flag));
      if (missing.length > 0) {
        throw new HwpCliError(
          "version",
          `hwp ${version.join(".")} does not accept ${missing.join(", ")} on edit; ` +
            "the binary does not match this engine's edit grammar",
          undefined,
          detailFor(bin),
        );
      }
      return version.join(".");
    })();
    return verifiedVersion;
  }

  /**
   * Per-call private workspace; removed on every path including failure.
   *
   * The removal is ordered strictly after child exit, and stays so only
   * because `runCli` settles from the execFile callback alone (SEC-09). A
   * racing timer that settled the promise early would run this `finally`
   * while the child still held the directory.
   */
  async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "hwp-editor-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function stage(dir: string, document: DocumentHandle): Promise<string> {
    const file = path.join(dir, `in${sniffExtension(document)}`);
    await writeFile(file, document.data, { mode: 0o600 });
    return file;
  }

  const inspections = new Map<string, DocumentInspection>();
  const snapshots = new Map<string, DocumentHandle>();

  async function describe(
    document: DocumentHandle,
    call?: CliCallOptions,
  ): Promise<DocumentInspection> {
    await ensureVersion();
    const bin = resolveBin();
    const key = cacheKey(call?.scope, document.data);
    const cached = inspections.get(key);
    if (cached !== undefined) return cached;
    const signal = call?.signal;
    const inspection = await withWorkDir(async (dir) => {
      const file = await stage(dir, document);
      const cat = await runCliOk(bin, ["cat", file, "--format", "markdown", "--with-segments"], timeoutMs, opts.locale, signal);
      const envelope = parseCatEnvelope(cat.stdout);
      // Best-effort extras: a document that cats fine but fails fields should
      // still read; the extras inform editing UI, not the wire contract.
      const [fields, bookmarks, slots, info] = await Promise.all([
        tryJson(bin, ["fields", file, "--json"], timeoutMs, opts.locale, signal),
        tryJson(bin, ["bookmarks", file, "--json"], timeoutMs, opts.locale, signal),
        tryJson(bin, ["slots", file, "--json"], timeoutMs, opts.locale, signal),
        tryJson(bin, ["info", file, "--json"], timeoutMs, opts.locale, signal),
      ]);
      return {
        envelope,
        fields,
        bookmarks,
        slots,
        info,
        capabilities: documentEditability(info),
      } satisfies DocumentInspection;
    });
    if (inspections.size >= 64) {
      const oldest = inspections.keys().next().value;
      if (oldest !== undefined) inspections.delete(oldest);
    }
    inspections.set(key, inspection);
    return inspection;
  }

  const engine: CliEngine = {
    async read(document, call) {
      return (await describe(document, call)).envelope;
    },

    describe,

    async render(document, options = {}, call) {
      await ensureVersion();
      const bin = resolveBin();
      const requested = options.format ?? "svg";
      if (requested === "jpeg" || requested === "webp") {
        throw new HwpCliError(
          "unsupported_format",
          `hwp-cli render supports png and svg only; got "${requested}"`,
        );
      }
      const dpi = options.dpi ?? 96;
      if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600) {
        throw new HwpCliError("bad_request", `dpi must be within 36..=600; got ${options.dpi}`);
      }
      const pages = options.pages ?? "all";
      if (pages !== "all" && !/^\d+(-\d+)?$/.test(pages)) {
        throw new HwpCliError("bad_request", `invalid page range: ${pages}`);
      }
      return withWorkDir(async (dir) => {
        const input = await stage(dir, document);
        const attempt = async (format: "svg" | "png"): Promise<PageImage[]> => {
          const outBase = path.join(dir, `page.${format}`);
          const reportPath = path.join(dir, "render-report.json");
          await runCliOk(bin, [
            "render", input, "-o", outBase,
            "--format", format, "--pages", pages, "--dpi", String(dpi),
            "--report", reportPath,
          ], timeoutMs, opts.locale, call?.signal);
          // Multi-page renders land as page-<n>.<ext>; a single selected page
          // keeps the exact -o name. The report's selected_pages pins numbers.
          const filePattern = new RegExp(`^page-(\\d+)\\.${format}$`);
          const files = (await readdir(dir))
            .filter((f) => f === `page.${format}` || filePattern.test(f))
            .sort((a, b) => {
              const na = Number(filePattern.exec(a)?.[1] ?? 0);
              const nb = Number(filePattern.exec(b)?.[1] ?? 0);
              return na - nb;
            });
          let selected: number[] | null = null;
          try {
            const report = JSON.parse(await readFile(reportPath, "utf8")) as {
              selected_pages?: unknown;
            };
            if (Array.isArray(report.selected_pages)) {
              selected = report.selected_pages.filter((n): n is number => typeof n === "number");
            }
          } catch {
            selected = null;
          }
          const images: PageImage[] = [];
          for (let i = 0; i < files.length; i++) {
            const file = files[i]!;
            const data = new Uint8Array(await readFile(path.join(dir, file)));
            const suffix = file.match(/^page-(\d+)\./);
            const page =
              suffix !== null
                ? Number(suffix[1])
                : (selected?.[i] ?? parseSinglePage(options.pages) ?? i + 1);
            const size =
              format === "png"
                ? pngSize(data)
                : svgSize(Buffer.from(data).toString("utf8"));
            // Output whose dimensions cannot be read cannot be trusted, so it
            // is discarded rather than handed to PageCanvas, whose aspectRatio
            // collapses on the zero the old fallback substituted (D-16).
            //
            // This composes with the SVG->PNG retry immediately below: that
            // retry fires on `requested === "svg" && reason === "failed"`, so
            // an SVG dimension failure is retried as PNG before it surfaces
            // while a PNG one surfaces directly. That is D-16 meeting the
            // retry D-15 deliberately kept, not a bug to "fix".
            if (size === null) {
              // The page number identifies it for the client; the staged file
              // name would only tell them where this server keeps its temps.
              throw new HwpCliError(
                "failed",
                `unreadable ${format} page dimensions on page ${page}`,
                undefined,
                detailFor(bin, file),
              );
            }
            images.push({
              page,
              width: size.width,
              height: size.height,
              dpi,
              format,
              data,
            });
          }
          return images;
        };
        try {
          return await attempt(requested);
        } catch (error) {
          // SVG is the default; fall back to PNG when the renderer refuses.
          if (requested === "svg" && error instanceof HwpCliError && error.reason === "failed") {
            return attempt("png");
          }
          throw error;
        }
      });
    },

    async edit(document, ops: EditOp[], options: EditOptions = {}, call?: CliCallOptions) {
      await ensureVersion();
      const bin = resolveBin();
      if (!Array.isArray(ops)) {
        throw new HwpCliError("bad_request", "ops must be an array of edit operations");
      }
      const ext = sniffExtension(document);
      const edited = await withWorkDir(async (dir) => {
        const input = await stage(dir, document);
        // Pre-flight: refuse a protected document before spawning `hwp edit`.
        // Reuse the cached inspection when the normal read-then-edit path has
        // already warmed it (routes.ts describes the same pre-edit bytes); on
        // a miss spawn `info` alone, never describe() — that costs five
        // parallel spawns and `info` is the only one this check reads.
        // compose() has no input DocumentHandle to inspect (its signature is
        // (spec, name)), so the pre-flight has no subject there; the stderr
        // backstop below covers it.
        const cached = inspections.get(cacheKey(call?.scope, document.data))?.capabilities;
        const capabilities =
          cached ?? documentEditability(await tryJson(bin, ["info", input, "--json"], timeoutMs, opts.locale, call?.signal));
        if (!capabilities.editable) {
          throw new HwpCliError(
            "protected",
            capabilities.reason ?? "protected document; hwp-cli refuses edit/compose",
          );
        }
        const output = path.join(dir, `out${ext}`);
        const args = ["edit", input, "-o", output, ...opsToArgv(ops)];
        if (options.verify !== false) args.push("--verify");
        if (options.allowPartial === true) args.push("--allow-partial");
        await runCliOk(bin, args, timeoutMs, opts.locale, call?.signal).catch(rethrowProtected);
        return new Uint8Array(await readFile(output));
      });
      // Pre-edit snapshot keyed by the edited hash SALTED WITH THIS CALL'S
      // SCOPE: undo(edited, same scope) -> original, and no other scope.
      snapshots.set(cacheKey(call?.scope, edited), { name: document.name, data: document.data });
      if (snapshots.size > 256) {
        const oldest = snapshots.keys().next().value;
        if (oldest !== undefined) snapshots.delete(oldest);
      }
      return { name: document.name, data: edited };
    },

    undo(document, call) {
      // Salts identically to the `edit` write above; any divergence here makes
      // every scoped snapshot unreachable rather than merely mis-scoped.
      const key = cacheKey(call?.scope, document.data);
      const snapshot = snapshots.get(key) ?? null;
      if (snapshot !== null) snapshots.delete(key);
      return snapshot;
    },

    async compose(spec: DocumentSpecV2, name: string, call?: CliCallOptions) {
      await ensureVersion();
      const bin = resolveBin();
      const outName = safeOutputName(name, ".hwpx");
      return withWorkDir(async (dir) => {
        const specPath = path.join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
        const outPath = path.join(dir, outName);
        const result = await runCliOk(
          bin,
          ["compose", specPath, "-o", outPath, "--report"],
          timeoutMs,
          opts.locale,
          call?.signal,
        ).catch(rethrowProtected);
        let report: unknown;
        try {
          report = JSON.parse(result.stdout) as unknown;
        } catch {
          report = undefined;
        }
        const data = new Uint8Array(await readFile(outPath));
        const composeResult: ComposeResult = { document: { name: outName, data } };
        if (report !== undefined) composeResult.report = report;
        return composeResult;
      });
    },

    async validate(document, call) {
      await ensureVersion();
      const bin = resolveBin();
      return withWorkDir(async (dir) => {
        const file = await stage(dir, document);
        // Exit 1 means "invalid" and still prints the JSON report.
        const result = await runCli(bin, ["validate", file, "--json"], timeoutMs, opts.locale, call?.signal);
        let parsed: { valid?: unknown; errors?: unknown };
        try {
          parsed = JSON.parse(result.stdout) as { valid?: unknown; errors?: unknown };
        } catch {
          // "no JSON report" is what distinguishes this from a plain non-zero
          // validate exit, which is a legitimate "invalid document" result.
          throw new HwpCliError(
            "failed",
            `hwp validate failed (exit ${result.code}): no JSON report`,
            result.stderr,
            detailFor(bin, result.stderr.trim() || result.stdout.trim()),
          );
        }
        const rawErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
        const errors: ValidationError[] = rawErrors.map((entry) =>
          typeof entry === "string"
            ? { code: "invalid", message: entry }
            : { code: "invalid", message: JSON.stringify(entry) },
        );
        const report: ValidationReport = { valid: parsed.valid === true, errors };
        return report;
      });
    },

    async capabilities(): Promise<Capabilities> {
      const version = await ensureVersion();
      return { version, editable: true, formats: ["hwp", "hwpx"] };
    },

    async binaryInfo() {
      return { bin: resolveBin(), version: await ensureVersion() };
    },
  };

  return engine;
}
