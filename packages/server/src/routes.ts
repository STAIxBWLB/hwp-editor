/**
 * Framework-agnostic HTTP handler implementing the wire contract of
 * packages/core/src/protocol.ts as Web Standards `(Request) => Response`.
 * Framework adapters (next.ts, or any Fetch-API runtime) delegate here.
 *
 * Binary payloads cross the wire as base64 inside JSON responses; uploads
 * are multipart/form-data parsed with Request.formData(). Every failure is
 * an ErrorResponse with a non-2xx status.
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
import { createSessionStore, SessionNotFoundError, PathTraversalError, type SessionStore } from "./session.js";

export interface RoutesOptions {
  /** Engine to serve; defaults to a CliEngine resolved from env/PATH. */
  engine?: HwpEngine;
  /** Convenience for the default engine: explicit hwp binary path. */
  bin?: string;
  /** Convenience for the default engine: per-invocation timeout in ms. */
  timeoutMs?: number;
  /**
   * Session store used to keep edit history (pre-edit snapshots) and cached
   * inspections server-side. Pass false to disable; defaults to an in-memory
   * store with a private temp root.
   */
  sessions?: SessionStore | false;
}

export type HwpEditorHandler = (req: Request) => Promise<Response>;

const ACTIONS = new Set(["read", "render", "edit", "compose", "validate", "capabilities"]);

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
  });
  const sessions: SessionStore | null =
    opts.sessions === false ? null : (opts.sessions ?? createSessionStore());

  /** Get-or-create the session tracking this exact document content. */
  async function sessionFor(document: DocumentHandle): Promise<DocumentSessionHandle | null> {
    if (sessions === null) return null;
    const hash = sha256(document.data);
    const existing = hashToSession.get(hash);
    if (existing !== undefined && sessions.has(existing)) {
      return { id: existing, fresh: false };
    }
    const session = await sessions.create(document.name, document.data);
    hashToSession.set(hash, session.id);
    return { id: session.id, fresh: true };
  }

  interface DocumentSessionHandle {
    id: string;
    fresh: boolean;
  }
  const hashToSession = new Map<string, string>();

  async function handleRead(req: Request): Promise<Response> {
    const { document } = await formDocument(req);
    // describe() runs cat + fields + bookmarks + slots + info; the extras are
    // cached on the session because the wire shape is pinned to CatEnvelope.
    if (sessions !== null && "describe" in engine) {
      const inspection = await (engine as CliEngine).describe(document);
      const session = await sessionFor(document);
      if (session !== null) sessions.attachInspection(session.id, inspection);
      return json(inspection.envelope);
    }
    return json(await engine.read(document));
  }

  async function handleRender(req: Request): Promise<Response> {
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
    const pages = await engine.render(document, options);
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

  async function handleEdit(req: Request): Promise<Response> {
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
    const options: EditOptions = {};
    const verify = formFlag(form, "verify");
    if (verify !== undefined) options.verify = verify;
    const allowPartial = formFlag(form, "allowPartial");
    if (allowPartial !== undefined) options.allowPartial = allowPartial;

    // Snapshot the pre-edit bytes so the edit can be undone server-side.
    const session = await sessionFor(document);
    if (sessions !== null && session !== null) {
      await sessions.snapshot(session.id);
    }
    const edited = await engine.edit(document, ops, options);
    if (sessions !== null && session !== null) {
      const stored = await sessions.put(session.id, edited.name, edited.data);
      hashToSession.set(sha256(edited.data), stored.id);
    }
    const body: EditResponse = { name: edited.name, dataBase64: toBase64(edited.data) };
    return json(body);
  }

  async function handleCompose(req: Request): Promise<Response> {
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
    const result = await engine.compose(body.spec, body.name);
    const responseBody: ComposeResponse = {
      name: result.document.name,
      dataBase64: toBase64(result.document.data),
    };
    if (result.report !== undefined) responseBody.report = result.report;
    return json(responseBody);
  }

  async function handleValidate(req: Request): Promise<Response> {
    const { document } = await formDocument(req);
    return json(await engine.validate(document));
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
        return await handleCapabilities();
      }
      if (req.method !== "POST") {
        return error(405, "method_not_allowed", `${action} requires POST`);
      }
      switch (action) {
        case "read":
          return await handleRead(req);
        case "render":
          return await handleRender(req);
        case "edit":
          return await handleEdit(req);
        case "compose":
          return await handleCompose(req);
        case "validate":
          return await handleValidate(req);
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
      if (err instanceof PathTraversalError) {
        return error(400, "path_traversal", err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      return error(500, "internal", message);
    }
  };
}
