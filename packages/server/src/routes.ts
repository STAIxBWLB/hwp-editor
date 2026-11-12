import { TEMPLATE_METHODS, templateVersionSupported, parseStyleTableResponse, STYLE_TABLE_PRESETS, parseTemplateInputs, parseFillReport, parseLintReport, parseEmbeddedTemplates, parseTemplateReport, stylesVersionSupported, type EditRefusalKind, type InsertionRefusal, type TemplateMethod, type LintProfile, type TemplateSpecV1, type TemplateDataV1 } from "@hwp-editor/core";
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
 * filter in the edit path (refusing `seal` and allowing `insert-image` only
 * with matching uploaded PNG/JPEG assets, never server-local paths, SEC-05).
 * Both still precede the engine call.
 *
 * Archive limits — declared entry sizes, decompressed byte ceilings and
 * compression-ratio caps — are NOT reimplemented here. They are hwp-cli's
 * default-on `hwp-cli-native-v1` profile (D-12); this handler relies on it,
 * so bumping the binary means re-checking that the profile still applies.
 */

import { createHash } from "node:crypto";
import {
  MAX_IMAGE_ASSET_BYTES,
  MAX_IMAGE_ASSETS,
  MAX_IMAGE_ASSETS_TOTAL_BYTES,
  sniffDocumentFormat,
  validateImageAssets,
  imageAssetsMismatch,
  withCallerName,
  type ImageAsset,
} from "@hwp-editor/core";

import type {
  Capabilities,
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

/** Supported actions; the runtime guard and `HwpAction` share this list. */
const ACTION_LIST = ["read", "render", "edit", "compose", "validate", "capabilities", "styles", "slots", "fill", "lint", "template", "templates", "create"] as const;

/** One supported action name the handler dispatches on. */
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

function error(
  status: number,
  code: HwpErrorCode,
  message: string,
  refusal?: EditRefusalKind,
  insertion?: InsertionRefusal,
  stopped?: true,
): Response {
  // The refusal kind is its own field (#82): a client must not select a
  // sentence from message text, which can carry the user's own values. The
  // stopped marker (#91) is carried the same way, and the message keeps its
  // English sentence for a client that reads text only.
  const body: ErrorResponse = {
    error: {
      code,
      message,
      ...(refusal === undefined ? {} : { refusal }),
      ...(insertion === undefined ? {} : { insertion }),
      ...(stopped === undefined ? {} : { stopped }),
    },
  };
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
 * Decide whether these bytes are admissible as an HWP or HWPX document, from
 * the leading bytes alone. `null` means refuse.
 *
 * The byte rule itself is `sniffDocumentFormat` in `@hwp-editor/core`, the same
 * reader the editor uses to tell the two formats apart, so an upload this gate
 * admits and a document the editor classifies cannot disagree. What is decided
 * here is the verdict: this call site refuses a header the reader does not
 * recognize, where the editor falls back to the file name.
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
  const sniffed = sniffDocumentFormat(d);
  return sniffed === "hwp" ? ".hwp" : sniffed === "hwpx" ? ".hwpx" : null;
}

/** Extract the uploaded document from a multipart form. */
async function formDocument(req: Request): Promise<{ form: FormData; document: DocumentHandle }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HwpCliError("bad_request", "expected multipart/form-data with a file field");
  }
  const files = form.getAll("file");
  if (files.length !== 1) throw new HwpCliError("bad_request", 'multipart field "file" must appear exactly once; attach one document');
  const file = files[0]!;
  if (typeof file === "string") {
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
          ...(p.layout === undefined ? {} : { layout: p.layout }),
        }),
      ),
    };
    return json(body);
  }

  async function handleEdit(req: Request, scope: string): Promise<Response> {
    const { form, document } = await formDocument(req);
    // The ops array is the whole edit. A preset is a `style-tables` op inside
    // it, so a preset switch and the style update it belongs with arrive as one
    // atomic batch — the engine's `--style-tables` flag is mutually exclusive
    // with `--ops` and aborts a document that has no table to style, which is
    // why this route has no preset field of its own.
    const opsField = form.get("ops");
    let ops: EditOp[] = [];
    if (typeof opsField === "string" && opsField !== "") {
      try {
        const parsed: unknown = JSON.parse(opsField);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        ops = parsed as EditOp[];
      } catch {
        throw new HwpCliError("bad_request", 'multipart field "ops" is not a JSON array');
      }
    } else {
      throw new HwpCliError("bad_request", 'multipart field "ops" (EditOp[] JSON) is required');
    }
    if (ops.some((op) => op?.kind === "style-tables" && !STYLE_TABLE_PRESETS.includes(op.preset))) {
      throw new HwpCliError("bad_request", `unknown style table preset; choose ${STYLE_TABLE_PRESETS.join(", ")}`);
    }
    if (ops.some((op) => op?.kind === "seal")) {
      return error(400, "path_traversal", 'the "seal" operation names a server-local path and is not accepted over HTTP; run it through a desktop/local host');
    }
    const uploadFiles = form.getAll("asset");
    if (uploadFiles.length > MAX_IMAGE_ASSETS) throw new HwpCliError("bad_request", `at most ${MAX_IMAGE_ASSETS} image assets are allowed; remove extra uploads and retry`);
    const assets: ImageAsset[] = [];
    let totalAssetBytes = 0;
    for (const value of uploadFiles) {
      if (typeof value === "string") throw new HwpCliError("bad_request", 'multipart field "asset" must be a file; attach a PNG/JPEG image');
      const file = value as File;
      if (file.size > MAX_IMAGE_ASSET_BYTES) throw new HwpCliError("bad_request", `image asset exceeds ${MAX_IMAGE_ASSET_BYTES} bytes; upload a smaller PNG/JPEG image`);
      totalAssetBytes += file.size;
      if (totalAssetBytes > MAX_IMAGE_ASSETS_TOTAL_BYTES) throw new HwpCliError("bad_request", `image assets exceed ${MAX_IMAGE_ASSETS_TOTAL_BYTES} bytes total; reduce upload sizes and retry`);
      assets.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    }
    try {
      validateImageAssets(assets);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "invalid image assets";
      throw new HwpCliError("bad_request", reason);
    }
    const mismatch = imageAssetsMismatch(ops, assets);
    switch (mismatch) {
      case null:
        break;
      // An insert-image op naming something no upload supplied asks the
      // server to read a local path: that stays path_traversal. An upload no
      // op names involves no path at all: bad_request (#58 item 7). Which one
      // it is decided once, in core (#105 item 3).
      case "op_without_upload":
        return error(400, "path_traversal", "insert-image paths must name exactly the uploaded assets; attach matching PNG/JPEG files instead of server-local paths");
      case "upload_without_op":
        return error(400, "bad_request", "an uploaded image is not referenced by any insert-image op; remove the unreferenced upload, or add the insert-image op that uses it, then retry");
      default: {
        // Exhaustive on purpose: a new mismatch direction has to say which
        // wire code it becomes, because falling through here would let it past
        // the check with no refusal at all.
        const unhandled: never = mismatch;
        throw new HwpCliError("bad_request", `imageAssetsMismatch: unhandled mismatch ${JSON.stringify(unhandled)}`);
      }
    }
    form.forEach((value, key) => {
      if (value instanceof Blob && key !== "file" && key !== "asset") {
        throw new HwpCliError("bad_request", "unexpected file-valued multipart field; send only file and asset parts");
      }
    });
    if (assets.length > 0 && (await engine.capabilities()).imageAssets !== "v1") {
      // Two causes reach this line, and the sentence names both: the CLI engine
      // withholds `imageAssets` below 1.4.0 because that is the version this
      // editor's upload path was verified against (#58 item 9), not because the
      // binary lacks image insertion, and a supplied engine may advertise no
      // uploads at all. Naming only "configure a host that advertises it" sent
      // the caller hunting for another adapter (#58 item 31).
      throw new HwpCliError("bad_request", "the configured engine does not support image assets v1; upgrade hwp-cli to 1.4.0 or newer, or configure a host that advertises imageAssets v1, then retry");
    }
    const options: EditOptions = {};
    const verify = formFlag(form, "verify");
    if (verify !== undefined) options.verify = verify;
    const allowPartial = formFlag(form, "allowPartial");
    if (allowPartial !== undefined) options.allowPartial = allowPartial;
    // Opt-in: the report costs an extra file per edit, and only a caller that
    // reorders what it inserted needs the ids. A host that cannot produce one
    // answers without the field rather than with fabricated ids. A batch that
    // carries a `style-tables` op asks for one regardless, inside the engine.
    const reportFlag = formFlag(form, "report");
    if (reportFlag !== undefined) options.report = reportFlag;
    if (assets.length > 0) options.assets = assets;

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
    const body: EditResponse = {
      name: edited.name,
      dataBase64: toBase64(edited.data),
      // The report names the path the engine wrote to. Whatever produced it —
      // the CLI engine here or a host's own engine — the field is rewritten at
      // this boundary, because this is the response a caller can read.
      ...(edited.report === undefined ? {} : { report: withCallerName(edited.report, edited.name) }),
    };
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

  async function handleStyles(req: Request, scope: string): Promise<Response> {
    await requireStyles();
    const { document } = await formDocument(req);
    // `validated` re-checks whatever engine answered, so a host engine that
    // projects a wrong table is caught here rather than in the panel.
    return json(validated(
      cli !== null ? await cli.styles(document, { signal: req.signal, scope }) : await engine.styles!(document),
      parseStyleTableResponse,
    ));
  }

  async function handleCapabilities(): Promise<Response> {
    const caps = await engine.capabilities();
    const body: Capabilities = {
      ...caps,
      templateMethods: templateVersionSupported(caps.version)
        ? (caps.templateMethods ?? TEMPLATE_METHODS.filter(method => typeof engine[method] === "function")) : [],
    };
    // Both halves must hold: a binary at the floor AND an engine that answers
    // the method. A host claiming `styles` without the method would leave the
    // Styles tab enabled and every click refused.
    if (!stylesVersionSupported(caps.version) || typeof engine.styles !== "function") delete body.styles;
    return json(body);
  }

  async function requireStyles(): Promise<void> {
    if (typeof engine.styles !== "function") throw new HwpCliError("unavailable", "styles is unsupported by this host; upgrade the host adapter to the hwp-cli 1.4.0 styles command.");
    const caps = await engine.capabilities();
    if (!stylesVersionSupported(caps.version) || caps.styles !== "v1") {
      throw new HwpCliError("unavailable", "styles requires hwp-cli 1.4.0 and host support; upgrade the binary and host adapter.");
    }
  }

  async function requireTemplateMethod(method: TemplateMethod): Promise<void> {
    if (typeof engine[method] !== "function") throw new HwpCliError("unavailable", `${method} is unsupported by this host; upgrade the host adapter to the hwp-cli 1.4.0 template API.`);
    const caps = await engine.capabilities();
    if (!templateVersionSupported(caps.version) || (caps.templateMethods !== undefined && !caps.templateMethods.includes(method))) throw new HwpCliError("unavailable", `${method} requires hwp-cli 1.4.0 and host command support; upgrade the binary and host adapter.`);
  }
  function validated<T>(value: unknown, parser: (raw: unknown) => T): T {
    try { return parser(value); }
    catch (err) { throw new HwpCliError("failed", err instanceof Error ? err.message : "Invalid template report; upgrade the host adapter and retry."); }
  }
  async function requestObject(req: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try { body = await req.json(); } catch { throw new HwpCliError("bad_request", "Invalid JSON body; send a template request object and retry."); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HwpCliError("bad_request", "Expected a template request object; send a JSON object and retry.");
    return body as Record<string, unknown>;
  }
  function stringField(body: Record<string, unknown>, field: string): string {
    if (typeof body[field] !== "string" || body[field] === "") throw new HwpCliError("bad_request", `Missing or invalid ${field}; supply a non-empty string and retry.`);
    return body[field] as string;
  }
  async function handleTemplateAction(req: Request, action: string, scope: string): Promise<Response> {
    const call = { signal: req.signal, scope };
    if (action === "templates") {
      await requireTemplateMethod("listTemplates");
      return json(validated(cli !== null ? await cli.listTemplates(call) : await engine.listTemplates!(), parseEmbeddedTemplates));
    }
    if (action === "template" || action === "create") {
      await requireTemplateMethod(action);
      const body = await requestObject(req);
      const name = stringField(body, "name");
      if (action === "create") {
        const id = stringField(body, "templateId");
        const document = cli !== null ? await cli.create(id, name, call) : await engine.create!(id, name);
        return json({ name: document.name, dataBase64: toBase64(document.data) });
      }
      if (typeof body.spec !== "object" || body.spec === null || typeof body.data !== "object" || body.data === null) throw new HwpCliError("bad_request", "Template request needs spec and data objects; supply TemplateSpec/Data v1 and retry.");
      const result = cli !== null
        ? await cli.template(body.spec as TemplateSpecV1, body.data as TemplateDataV1, name, call)
        : await engine.template!(body.spec as TemplateSpecV1, body.data as TemplateDataV1, name);
      return json({ name: result.document.name, dataBase64: toBase64(result.document.data), ...(result.report === undefined ? {} : { report: validated(result.report, parseTemplateReport) }) });
    }
    if (action !== "slots" && action !== "fill" && action !== "lint") throw new HwpCliError("bad_request", "Unknown template action; choose slots, fill, lint, template, templates or create.");
    await requireTemplateMethod(action);
    const { document, form } = await formDocument(req);
    if (action === "slots") return json(validated(cli !== null ? await cli.slots(document, call) : await engine.slots!(document), parseTemplateInputs));
    if (action === "lint") {
      const profile = formString(form, "profile");
      if (profile !== undefined && profile !== "gongmun" && profile !== "report") throw new HwpCliError("bad_request", "Invalid lint profile; select gongmun or report and retry.");
      return json(validated(cli !== null ? await cli.lint(document, profile as LintProfile | undefined, call) : await engine.lint!(document, profile as LintProfile | undefined), parseLintReport));
    }
    let values: unknown;
    try { values = JSON.parse(formString(form, "values") ?? ""); } catch { throw new HwpCliError("bad_request", "Fill values must be valid JSON; send an object of strings and retry."); }
    if (typeof values !== "object" || values === null || Array.isArray(values) || Object.values(values).some(value => typeof value !== "string")) throw new HwpCliError("bad_request", "Fill values must be an object of strings; correct the template form and retry.");
    const result = cli !== null ? await cli.fill(document, values as Record<string, string>, call) : await engine.fill!(document, values as Record<string, string>);
    return json({ name: result.document.name, dataBase64: toBase64(result.document.data), report: validated(result.report, parseFillReport) });
  }

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const action = segments[segments.length - 1] ?? "";
    try {
      if (!ACTIONS.has(action)) {
        return error(404, "not_found", `unknown action: ${action || "(empty)"}`);
      }
      if (action === "capabilities" || action === "templates") {
        if (req.method !== "GET") return error(405, "method_not_allowed", `${action} requires GET`);
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
      if (action === "capabilities") return await handleCapabilities();
      if (action === "templates") return await handleTemplateAction(req, action, scope);
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
        return error(413, "bad_request", `request exceeds the ${maxRequestBytes} byte limit; use a smaller document or fewer image uploads`);
      }
      switch (action) {
        case "slots": case "fill": case "lint": case "template": case "create":
          return await handleTemplateAction(req, action, scope);
        case "read":
          return await handleRead(req, scope);
        case "styles":
          return await handleStyles(req, scope);
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
        return error(statusFor(err), err.reason, err.message, err.refusal, err.insertion, err.stopped);
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
