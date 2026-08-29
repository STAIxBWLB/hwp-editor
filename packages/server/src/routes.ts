/**
 * Framework-agnostic HTTP handler implementing the wire contract of
 * packages/core/src/protocol.ts as Web Standards `(Request) => Response`.
 * Framework adapters (next.ts, or any Fetch-API runtime) delegate here.
 *
 * Binary payloads cross the wire as base64 inside JSON responses; uploads
 * are multipart/form-data parsed with Request.formData(). Every failure is
 * an ErrorResponse with a non-2xx status.
 *
 * The admission gate runs in a fixed order before any body is buffered:
 * action (404) -> method (405) -> authorize (403) -> size (400/413). Only
 * after all four does a handler touch `req.formData()` or `req.json()`, so a
 * refusal costs zero uploaded bytes and zero engine calls (D-04).
 *
 * Two further checks run after the bytes are in hand, in this order: the
 * magic-byte sniff at the single buffering site (`sniffFormat`, refusing
 * anything that is not an HWP or HWPX document, SEC-07), and the op-path
 * filter in the edit path (refusing `insert-image` and `seal`, which name a
 * file on the server's own disk, SEC-05). Both still precede the engine call.
 *
 * Archive limits — declared entry sizes, decompressed byte ceilings and
 * compression-ratio caps — are NOT reimplemented here. They are hwp-cli's
 * default-on `hwp-cli-native-v1` profile (D-12); this handler relies on it,
 * so bumping the binary means re-checking that the profile still applies.
 */

import { createHash } from "node:crypto";

import type {
  DocumentHandle,
  EditOp,
  EditOptions,
  HwpEngine,
  HwpErrorCode,
  PageImageFormat,
  RenderOptions,
} from "@hwp-editor/core";
import type {
  ComposeRequest,
  ComposeResponse,
  EditResponse,
  ErrorResponse,
  RenderPageWire,
  RenderResponse,
} from "@hwp-editor/core";

import { createCliEngine, HwpCliError, type CliEngine } from "./cli-engine.js";
import { createSessionStore, SessionNotFoundError, type SessionStore } from "./session.js";

/** The six actions this handler serves; the runtime guard and `HwpAction` share it. */
const ACTION_LIST = ["read", "render", "edit", "compose", "validate", "capabilities"] as const;

/** One of the six action names the handler dispatches on. */
export type HwpAction = (typeof ACTION_LIST)[number];

/**
 * Host-supplied admission hook. Its return value answers two questions at
 * once, deliberately (D-01): a string ADMITS the request AND is the tenant
 * scope every server-side cache key is salted with; `null` REFUSES it with
 * HTTP 403 and code `forbidden`. One call decides both, so admission and
 * tenancy can never disagree.
 *
 * Called once per request, awaited, before any body is buffered — a refusal
 * therefore costs zero bytes of upload and zero engine calls (D-04).
 *
 * The refusal message is a fixed literal: a `{ allow, scope, reason }` shape
 * was rejected precisely so no host-authored reason string can ride out to
 * an unauthenticated client.
 */
export type AuthorizeFn = (req: Request, action: HwpAction) => Promise<string | null>;

/**
 * Scope used when no `authorize` is supplied. D-02: no hook means allow, with
 * one fixed scope — the documented `createHwpEditorRoutes({ bin })` one-liner
 * keeps working and single-tenant hosts need no configuration.
 */
const DEFAULT_SCOPE = "default";

/**
 * Default combined request cap, 50 MiB. It bounds multipart buffering, the
 * base64 response it produces and the bytes staged on disk. It is NOT a
 * memory bound: hwp-cli's own per-package ceiling is 2 GiB, and a measured
 * 9.0 MB HWPX drove `hwp cat` to 1.70 GB RSS. Size the container off that
 * amplification, not off this number.
 */
const DEFAULT_MAX_REQUEST_BYTES = 50 * 1024 * 1024;

export interface RoutesOptions {
  /** Engine to serve; defaults to a CliEngine resolved from env/PATH. */
  engine?: HwpEngine;
  /** Convenience for the default engine: explicit hwp binary path. */
  bin?: string;
  /** Convenience for the default engine: per-invocation timeout in ms. */
  timeoutMs?: number;
  /**
   * Convenience for the default engine: language passed to the child as
   * HWP_LANG, default `en`. Accepts `en`/`eng`/`english`/`c`/`posix` and
   * `ko`/`kor`/`korean`. Applies to the default engine only — an explicit
   * `engine` carries its own locale.
   */
  locale?: string;
  /**
   * Largest request admitted, in bytes; defaults to 52428800 (50 MiB).
   * The figure is the WHOLE request envelope — multipart boundaries, field
   * names and part headers included — not the document alone, because it is
   * compared against `Content-Length`. Checked before any buffering; a
   * request over it is refused with 413 and a request with no measurable
   * `Content-Length` with 400.
   */
  maxRequestBytes?: number;
  /**
   * Cache of read-pipeline inspections, keyed by an opaque session id. Pass
   * false to disable; defaults to a per-handler in-memory store. It retains no
   * document bytes and touches no filesystem — the wire is stateless and undo
   * lives in the client store (D-05/D-06).
   */
  sessions?: SessionStore | false;
  /**
   * Admission hook run before any body is read. Defaults to allow-all with a
   * fixed scope: this package owns no auth, the host owns the trust boundary
   * (see the trust-boundary section of packages/server/README.md).
   */
  authorize?: AuthorizeFn;
}

export type HwpEditorHandler = (req: Request) => Promise<Response>;

const ACTIONS: ReadonlySet<string> = new Set<string>(ACTION_LIST);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: HwpErrorCode, message: string): Response {
  const body: ErrorResponse = { error: { code, message } };
  return json(body, status);
}

function statusFor(err: HwpCliError): number {
  switch (err.reason) {
    case "bad_request":
    case "unsupported_format":
      return 400;
    case "unavailable":
      return 503;
    case "timeout":
      return 504;
    case "version":
      return 500;
    // The client went away; nothing was produced and nobody is listening.
    case "cancelled":
      return 499;
    // The document's CLI output exceeded the 32 MiB stdout ceiling.
    case "output_too_large":
      return 413;
    case "failed":
    // 403 is deliberately left unclaimed for Phase 4's `authorize`
    // rejections, so a host can tell an auth refusal from a document
    // refusal by status alone.
    case "protected":
      return 422;
  }
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * CFBF/OLE2 container signature — the first eight bytes of every HWP5 file.
 *
 * Deliberately a second copy of `cli-engine.ts`'s constant rather than a
 * shared export: the two answer different questions and must be free to
 * diverge (see the note on `sniffFormat`).
 */
const CFBF_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * The OPC media type an HWPX package declares in its first zip entry.
 *
 * hwp-cli's own writer emits that entry first and STORED
 * (hwp-cli/crates/hwpx/src/write/mod.rs:331-332), and `hwp validate` warns
 * when the layout is violated (commands/validate.rs:100-103). The layout was
 * checked against 19 real HWPX files — 14 hwp-cli-produced and 5
 * Hancom-authored — and 19 of 19 passed.
 */
const HWPX_MIMETYPE = "application/hwp+zip";

/**
 * Decide whether these bytes are admissible as an HWP or HWPX document, from
 * the leading bytes alone. `null` means refuse.
 *
 * Reads at most about ninety bytes and decompresses nothing, so it does not
 * itself widen the archive surface. Every archive-structure defence — entry
 * count, per-entry and total decompressed size, compression ratio, XML size,
 * duplicate and traversing entry names — is enforced by hwp-cli's default-on
 * `hwp-cli-native-v1` profile, twice (declared central-directory sizes before
 * the archive is opened, and actual decompressed bytes), and was verified
 * effective. No second limit is written here (D-12).
 *
 * A `PK\x03\x04` signature alone is NOT accepted: it admits any zip (D-11).
 * The cost of the strict layout is a possible false rejection from an exotic
 * producer, whose failure mode is a clear 400 rather than a silent one.
 */
function sniffFormat(d: Uint8Array): ".hwp" | ".hwpx" | null {
  if (d.length >= CFBF_SIGNATURE.length && CFBF_SIGNATURE.every((b, i) => d[i] === b)) {
    return ".hwp";
  }
  // 30-byte local file header + an 8-byte `mimetype` name is the floor below
  // which none of the reads below are in range.
  if (d.length < 38) return null;
  if (!(d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04)) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (view.getUint16(8, true) !== 0) return null; // compression method must be STORED
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  if (nameLen !== 8) return null;
  if (new TextDecoder().decode(d.subarray(30, 38)) !== "mimetype") return null;
  const start = 30 + nameLen + extraLen;
  const end = start + HWPX_MIMETYPE.length;
  if (d.length < end) return null;
  return new TextDecoder().decode(d.subarray(start, end)) === HWPX_MIMETYPE ? ".hwpx" : null;
}

/** Extract the uploaded document from a multipart form. */
async function formDocument(req: Request): Promise<{ form: FormData; document: DocumentHandle }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HwpCliError("bad_request", "expected multipart/form-data with a file field");
  }
  const file = form.get("file");
  if (file === null || typeof file === "string") {
    throw new HwpCliError("bad_request", 'multipart field "file" is required');
  }
  const blob = file as Blob;
  const name =
    "name" in blob && typeof (blob as { name?: unknown }).name === "string" && (blob as File).name !== ""
      ? (blob as File).name
      : "document.hwpx";
  const data = new Uint8Array(await blob.arrayBuffer());
  if (data.length === 0) {
    throw new HwpCliError("bad_request", 'multipart field "file" is empty');
  }
  // The single buffering site D-04 pins, so this one call covers read,
  // render, edit and validate alike. The sniffed extension is deliberately
  // discarded: `sniffExtension` in cli-engine.ts keeps answering its own
  // question ("what extension do I stage this under?"), and once the route
  // has rejected non-HWP input that guess is only ever choosing between two
  // valid answers. Do not merge the two.
  if (sniffFormat(data) === null) {
    throw new HwpCliError("bad_request", "file is not an HWP or HWPX document");
  }
  return { form, document: { name, data } };
}

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function formFlag(form: FormData, key: string): boolean | undefined {
  const value = form.get(key);
  if (value === null) return undefined;
  return value === "true" || value === "1";
}

export function createHwpEditorHandler(opts: RoutesOptions = {}): HwpEditorHandler {
  const engine: HwpEngine = opts.engine ?? createCliEngine({
    ...(opts.bin === undefined ? {} : { bin: opts.bin }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.locale === undefined ? {} : { locale: opts.locale }),
  });
  // Resolved once, here, and nowhere else: every handler that spawns needs
  // the same narrowing to pass per-call options, and a second `"describe" in
  // engine` check inside one handler is how the other four end up without
  // one. A host-supplied plain HwpEngine keeps working; it simply receives no
  // per-call options, so its children are not cancellable from here.
  const cli: CliEngine | null = "describe" in engine ? (engine as CliEngine) : null;
  const maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const sessions: SessionStore | null =
    opts.sessions === false ? null : (opts.sessions ?? createSessionStore());

  /**
   * Get-or-create the session tracking this exact document content, within
   * this scope. The scope is a PARAMETER, never a closure field: one handler
   * serves concurrent requests, so a field would be a cross-request channel
   * of exactly the shape SEC-04 forbids.
   */
  function sessionFor(document: DocumentHandle, scope: string): string | null {
    if (sessions === null) return null;
    // Same salted shape as cli-engine.ts's `cacheKey`, written separately
    // because the two files share no module; the SHAPE is the contract, not
    // the function (SEC-04, D-07).
    const key = sha256Text(`${scope}\0${sha256(document.data)}`);
    const existing = hashToSession.get(key);
    if (existing !== undefined && sessions.has(existing)) return existing;
    const session = sessions.create(document.name);
    hashToSession.set(key, session.id);
    return session.id;
  }

  const hashToSession = new Map<string, string>();

  async function handleRead(req: Request, scope: string): Promise<Response> {
    const { document } = await formDocument(req);
    // describe() runs cat + fields + bookmarks + slots + info; the extras are
    // cached on the session because the wire shape is pinned to CatEnvelope.
    if (sessions !== null && cli !== null) {
      const inspection = await cli.describe(document, { signal: req.signal, scope });
      const id = sessionFor(document, scope);
      if (id !== null) sessions.attachInspection(id, inspection);
      return json(inspection.envelope);
    }
    return json(
      cli !== null
        ? await cli.read(document, { signal: req.signal, scope })
        : await engine.read(document),
    );
  }

  async function handleRender(req: Request, scope: string): Promise<Response> {
    const { form, document } = await formDocument(req);
    const dpiField = formString(form, "dpi");
    const dpi = dpiField === undefined ? undefined : Number(dpiField);
    if (dpi !== undefined && !Number.isFinite(dpi)) {
      throw new HwpCliError("bad_request", `dpi must be a number; got "${dpiField}"`);
    }
    const format = formString(form, "format") as PageImageFormat | undefined;
    const options: RenderOptions = {};
    const pagesField = formString(form, "pages");
    if (pagesField !== undefined) options.pages = pagesField;
    if (dpi !== undefined) options.dpi = dpi;
    if (format !== undefined) options.format = format;
    const pages =
      cli !== null
        ? await cli.render(document, options, { signal: req.signal, scope })
        : await engine.render(document, options);
    const body: RenderResponse = {
      pages: pages.map(
        (p): RenderPageWire => ({
          page: p.page,
          width: p.width,
          height: p.height,
          dpi: p.dpi,
          format: p.format,
          dataBase64: toBase64(p.data),
        }),
      ),
    };
    return json(body);
  }

  async function handleEdit(req: Request, scope: string): Promise<Response> {
    const { form, document } = await formDocument(req);
    const opsField = form.get("ops");
    if (typeof opsField !== "string" || opsField === "") {
      throw new HwpCliError("bad_request", 'multipart field "ops" (EditOp[] JSON) is required');
    }
    let ops: EditOp[];
    try {
      const parsed: unknown = JSON.parse(opsField);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      ops = parsed as EditOp[];
    } catch {
      throw new HwpCliError("bad_request", 'multipart field "ops" is not a JSON array');
    }
    // `opValue` in packages/core/src/ops.ts hands `op.path` straight to argv
    // for exactly these two kinds and no others. `execFile` runs without a
    // shell, which stops command injection but NOT path resolution, so over
    // HTTP a client could otherwise name any file the server process can read
    // and have it embedded in the output — which is why refusing, rather than
    // sanitizing, is the scope-correct fix. Both ops keep working on the
    // Tauri transport, because that is a local application (D-10). Phase 7
    // EXT-01 owns the staged-asset upload flow that makes them usable here.
    // `path_traversal` rather than `bad_request`: D-08 keeps that code in the
    // union specifically as this reuse site, and both answer 400.
    if (ops.some((op) => op?.kind === "insert-image" || op?.kind === "seal")) {
      return error(
        400,
        "path_traversal",
        'ops "insert-image" and "seal" name a server-local path and are not accepted over HTTP; upload the asset with the request instead',
      );
    }
    const options: EditOptions = {};
    const verify = formFlag(form, "verify");
    if (verify !== undefined) options.verify = verify;
    const allowPartial = formFlag(form, "allowPartial");
    if (allowPartial !== undefined) options.allowPartial = allowPartial;

    // No session is created or written here. The pre-edit copy this path used
    // to snapshot was unreadable by anything in the repository (BUG-07, D-05);
    // undo is the client store's job (packages/core/src/state.ts).
    //
    // The scope matters most on this call and is the easiest to leave off:
    // the engine's `inspections` protected pre-flight AND its `snapshots`
    // write both key off this argument, so an unthreaded edit falls back to
    // the default scope and two tenants editing identical bytes share both.
    const edited =
      cli !== null
        ? await cli.edit(document, ops, options, { signal: req.signal, scope })
        : await engine.edit(document, ops, options);
    const body: EditResponse = { name: edited.name, dataBase64: toBase64(edited.data) };
    return json(body);
  }

  async function handleCompose(req: Request, scope: string): Promise<Response> {
    let body: ComposeRequest;
    try {
      body = (await req.json()) as ComposeRequest;
    } catch {
      throw new HwpCliError("bad_request", "expected a JSON ComposeRequest body");
    }
    if (typeof body !== "object" || body === null || typeof body.spec !== "object" || body.spec === null) {
      throw new HwpCliError("bad_request", 'ComposeRequest requires a "spec" object');
    }
    if (typeof body.name !== "string" || body.name === "") {
      throw new HwpCliError("bad_request", 'ComposeRequest requires a non-empty "name"');
    }
    const result =
      cli !== null
        ? await cli.compose(body.spec, body.name, { signal: req.signal, scope })
        : await engine.compose(body.spec, body.name);
    const responseBody: ComposeResponse = {
      name: result.document.name,
      dataBase64: toBase64(result.document.data),
    };
    if (result.report !== undefined) responseBody.report = result.report;
    return json(responseBody);
  }

  async function handleValidate(req: Request, scope: string): Promise<Response> {
    const { document } = await formDocument(req);
    return json(
      cli !== null
        ? await cli.validate(document, { signal: req.signal, scope })
        : await engine.validate(document),
    );
  }

  async function handleCapabilities(): Promise<Response> {
    return json(await engine.capabilities());
  }

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const action = segments[segments.length - 1] ?? "";
    try {
      if (!ACTIONS.has(action)) {
        return error(404, "not_found", `unknown action: ${action || "(empty)"}`);
      }
      if (action === "capabilities") {
        if (req.method !== "GET") return error(405, "method_not_allowed", "capabilities requires GET");
      } else if (req.method !== "POST") {
        return error(405, "method_not_allowed", `${action} requires POST`);
      }
      // Admission, above every buffering site and above the capabilities
      // early return — /capabilities discloses the binary version (SEC-12),
      // so it is gated too. The scope is bound here and nowhere else: later
      // plans salt cache keys with this local, never re-derive it.
      const scope =
        opts.authorize === undefined ? DEFAULT_SCOPE : await opts.authorize(req, action as HwpAction);
      if (scope === null) return error(403, "forbidden", "forbidden");
      if (action === "capabilities") {
        return await handleCapabilities();
      }
      // Size gate: POST actions only, so /capabilities never needs a body
      // header. Refusing an absent Content-Length rather than falling through
      // to a post-buffer check is what keeps D-04's promise provable — a
      // counting guard over req.body would have to read the body first.
      // Every request the reference client sends carries the header (measured:
      // FormData and JSON bodies both), so this costs no legitimate caller;
      // only a deliberately chunked upload is refused (Pitfall 3).
      const declared = req.headers.get("content-length");
      if (declared === null) {
        return error(400, "bad_request", "content-length is required");
      }
      // /^\d+$/ before Number(): `Number(" 10")` is 10 and `Number("")` is 0,
      // so isSafeInteger alone admits both (Pitfall 4).
      const bytes = /^\d+$/.test(declared) ? Number(declared) : NaN;
      if (!Number.isSafeInteger(bytes)) {
        return error(400, "bad_request", "invalid content-length");
      }
      if (bytes > maxRequestBytes) {
        return error(413, "bad_request", `request exceeds the ${maxRequestBytes} byte limit`);
      }
      switch (action) {
        case "read":
          return await handleRead(req, scope);
        case "render":
          return await handleRender(req, scope);
        case "edit":
          return await handleEdit(req, scope);
        case "compose":
          return await handleCompose(req, scope);
        case "validate":
          return await handleValidate(req, scope);
        default:
          return error(404, "not_found", `unknown action: ${action}`);
      }
    } catch (err) {
      if (err instanceof HwpCliError) {
        return error(statusFor(err), err.reason, err.message);
      }
      if (err instanceof SessionNotFoundError) {
        return error(404, "session_not_found", err.message);
      }
      // Unclassified: this is the single serialization boundary where an
      // internal value could become a client-visible string, and an
      // unclassified throw can carry a temp path, the binary path or CLI
      // stderr. The message is therefore a fixed literal BY CONSTRUCTION —
      // nothing derived from `err` is interpolated, so there is no filter to
      // get wrong and no encoding question. The branches above keep their own
      // messages, which 04-03 already scrubbed at the engine. A host that
      // needs the detail catches the error itself; this package has no logger
      // and adds none (SEC-06, route half).
      return error(500, "internal", "internal error");
    }
  };
}
