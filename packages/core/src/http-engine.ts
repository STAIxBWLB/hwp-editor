import { parsePageLayout } from "./layout.js";
import { parseEditReport } from "./edit-report.js";
import type { EditReport } from "./edit-report.js";
import { imageAssetMediaType, validateImageAssets } from "./assets.js";
/**
 * HwpEngine client for the HTTP route contract defined in protocol.ts.
 * Works in browsers, Node >= 22, and Tauri (all have fetch + FormData).
 */

import type {
  Capabilities,
  ComposeResult,
  DocumentHandle,
  EditOptions,
  HwpEngine,
  PageImage,
  RenderOptions,
  ValidationReport,
} from "./engine.js";
import { HwpEngineError, toHwpErrorCode } from "./errors.js";
import { isEditRefusalKind } from "./refusals.js";
import { isInsertionRefusal } from "./insertion-refusals.js";
import type { HwpErrorCode } from "./errors.js";
import type { EditOp } from "./ops.js";
import type { CatEnvelope } from "./segments.js";
import { validateProjectedMetadata } from "./segments.js";
import { parseStyleTableResponse } from "./styles.js";
import { carriesPresetSwitch, presetBatchOptions, readPresetBatch } from "./style-batch.js";
import type { DocumentSpecV2 } from "./generated/document-spec-v2.js";
import type { TemplateDataV1, TemplateSpecV1 } from "./spec.js";
import type { LintProfile } from "./templates.js";
import { parseEmbeddedTemplates, parseFillReport, parseLintReport, parseTemplateInputs, parseTemplateMethods, parseTemplateReport, reportObject, reportString } from "./templates.js";
import type {
  ComposeRequest,
  ComposeResponse,
  EditResponse,
  ErrorResponse,
  RenderResponse,
  TemplateRequest,
} from "./protocol.js";

export interface HttpEngineOptions {
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
}

/**
 * Native TC39 base64 (proposal-arraybuffer-base64), captured once. Baseline
 * 2025-09: Node >= 25, Chrome/Edge >= 140, Safari >= 26, Firefox >= 133.
 * ABSENT on the declared Node >= 22 floor and in older Tauri webviews, so
 * this is a fast path only, never an assumption — the access is defensive so
 * an environment without it cannot throw at import time. TS 5.9's
 * ESNext/DOM lib does not declare these methods yet; the local structural
 * types below are deliberate and cheaper than bumping `lib`.
 */
const nativeEncode = (
  Uint8Array.prototype as { toBase64?: (this: Uint8Array) => string }
).toBase64;
const nativeDecode = (
  Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
).fromBase64;

/**
 * 32768 bytes — the largest subarray that can be spread into
 * `String.fromCharCode` before engines reject the argument count
 * (RangeError: Maximum call stack size exceeded).
 */
const CHUNK = 0x8000;

/**
 * Encode bytes to base64. Synchronous by contract: this is published API
 * (`base64`, re-exported from the barrel) consumed synchronously by
 * `PageCanvas`'s useMemo and `tauri.ts`'s `ref()`.
 *
 * The fallback builds one 32KB binary-string piece per chunk instead of
 * concatenating per byte, which is what stalled the UI on multi-megabyte
 * documents (BUG-06).
 */
function toBase64(data: Uint8Array): string {
  if (nativeEncode !== undefined) return nativeEncode.call(data);
  let binary = "";
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode base64 to bytes. The fallback is already linear: `atob` is native. */
function fromBase64(base64: string): Uint8Array {
  if (nativeDecode !== undefined) return nativeDecode(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Code for a response whose body is not the JSON contract — a reverse proxy
 * page, a serverless platform kill. This is the most common real timeout, so
 * without the mapping the badge would silently regress to "generic".
 *
 * 403 is deliberately left in the default: it is reserved for a later
 * authorization phase and must not claim a code of its own here.
 */
function codeForStatus(status: number): HwpErrorCode {
  switch (status) {
    case 400:
      return "bad_request";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 422:
      return "failed";
    case 503:
      return "unavailable";
    case 504:
      return "timeout";
    default:
      return "internal";
  }
}

async function parseError(res: Response): Promise<HwpEngineError> {
  try {
    const body = (await res.json()) as ErrorResponse;
    // Narrow, never cast: the code comes from a server this client does
    // not control (a pre-1.0 build, a newer one, a proxy's own body).
    return new HwpEngineError(
      toHwpErrorCode(body.error.code),
      // Pinned format: the "http 504"/"http 503" substrings are the
      // fallback markers classifyEngineError reads in @hwp-editor/react.
      `hwp-engine HTTP ${res.status}: ${body.error.message}`,
      {
        status: res.status,
        cause: body,
        // Narrowed, never cast; an older server sends no field (#82).
        ...(isEditRefusalKind(body.error.refusal) ? { refusal: body.error.refusal } : {}),
        ...(isInsertionRefusal(body.error.insertion) ? { insertion: body.error.insertion } : {}),
        // A marker read for what it says, not for what it is: only `true`
        // counts, so a server that sends `false` or a string sends nothing
        // (#91). The sentence in the message stays as the fallback.
        ...(body.error.stopped === true ? { stopped: true as const } : {}),
      },
    );
  } catch {
    return new HwpEngineError(
      codeForStatus(res.status),
      `hwp-engine HTTP ${res.status}: ${res.statusText}`,
      { status: res.status },
    );
  }
}


export function decodeTemplateDocument(raw: unknown, field: string): DocumentHandle {
  const value = reportObject(raw, field);
  const name = reportString(value.name, `${field}.name`);
  if (name === "") throw new Error(`Invalid template report: ${field}.name; upgrade the host/client to the hwp-cli 1.4.0 template contract and retry.`);
  const encoded = reportString(value.dataBase64, `${field}.dataBase64`);
  if (encoded === "" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`Invalid template report: ${field}.dataBase64; upgrade the host/client to the hwp-cli 1.4.0 template contract and retry.`);
  }
  return {
    name,
    data: fromBase64(encoded),
  };
}

export function createHttpEngine(
  baseUrl: string,
  opts: HttpEngineOptions = {},
): HwpEngine {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await doFetch(`${base}${path}`, init);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  function fileForm(document: DocumentHandle): FormData {
    const form = new FormData();
    form.append(
      "file",
      new Blob([document.data as BlobPart]),
      document.name,
    );
    return form;
  }

  async function templateRequest<T>(route: string, init: RequestInit): Promise<T> {
    try { return await request<T>(route, init); }
    catch (error) {
      if (error instanceof HwpEngineError && error.status === 404) throw new HwpEngineError("unavailable", `Template command ${route} is unsupported by this host; upgrade the host adapter to the template API and retry.`, { cause: error });
      if (error instanceof SyntaxError) throw new HwpEngineError("failed", `Template command ${route} returned invalid JSON; upgrade the host adapter to the hwp-cli 1.4.0 contract and retry.`, { cause: error });
      if (error instanceof TypeError) throw new HwpEngineError("unavailable", `Template request ${route} could not reach the host; check the engine base URL and connection, then retry.`, { cause: error });
      throw error;
    }
  }

  function jsonRequest<T>(path: string, body: unknown): Promise<T> {
    return templateRequest<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }


  return {
    async slots(document) {
      const raw = await templateRequest<unknown>("/slots", { method: "POST", body: fileForm(document) });
      return parseTemplateInputs(raw);
    },

    async fill(document, values) {
      const form = fileForm(document);
      form.append("values", JSON.stringify(values));
      const raw = await templateRequest<unknown>("/fill", { method: "POST", body: form });
      const response = reportObject(raw, "fill.response");
      const report = parseFillReport(response.report);
      return { document: decodeTemplateDocument(response, "fill.document"), report };
    },

    async template(spec: TemplateSpecV1, data: TemplateDataV1, name: string) {
      const body: TemplateRequest = { spec, data, name };
      const raw = await jsonRequest<unknown>("/template", body);
      const response = reportObject(raw, "template.response");
      const document = decodeTemplateDocument(response, "template.document");
      return { document, ...(response.report !== undefined ? { report: parseTemplateReport(response.report) } : {}) };
    },

    async lint(document, profile?: LintProfile) {
      const form = fileForm(document);
      if (profile !== undefined) form.append("profile", profile);
      return parseLintReport(await templateRequest<unknown>("/lint", { method: "POST", body: form }));
    },

    async listTemplates() {
      return parseEmbeddedTemplates(await templateRequest<unknown>("/templates", { method: "GET" }));
    },

    async create(templateId, name) {
      const raw = await jsonRequest<unknown>("/create", { templateId, name });
      return decodeTemplateDocument(raw, "create.document");
    },

    read(document) {
      return request<CatEnvelope>("/read", {
        method: "POST",
        body: fileForm(document),
      }).then(validateProjectedMetadata);
    },

    async styles(document) {
      let raw: unknown;
      try {
        raw = await request<unknown>("/styles", {
          method: "POST",
          body: fileForm(document),
        });
      } catch (error) {
        // The route exists only on a host that advertises `styles`, so a 404
        // here means an older host answered — the same lesson the template
        // routes teach, in this command family's words.
        if (error instanceof HwpEngineError && error.status === 404) {
          throw new HwpEngineError("unavailable", "Styles are unsupported by this host; upgrade it to the hwp-cli 1.4.0 styles command and retry.", { cause: error });
        }
        throw error;
      }
      return parseStyleTableResponse(raw);
    },

    async render(document, options = {}) {
      const form = fileForm(document);
      if (options.pages !== undefined) form.append("pages", options.pages);
      if (options.dpi !== undefined) form.append("dpi", String(options.dpi));
      if (options.format !== undefined) form.append("format", options.format);
      const res = await request<RenderResponse>("/render", {
        method: "POST",
        body: form,
      });
      return res.pages.map(
        (p): PageImage => ({
          page: p.page,
          width: p.width,
          height: p.height,
          dpi: p.dpi,
          format: p.format,
          ...(p.layout === undefined ? {} : { layout: parsePageLayout(p.layout) }),
          data: fromBase64(p.dataBase64),
        }),
      );
    },

    async edit(document, ops: EditOp[], options: EditOptions = {}) {
      const assets = options.assets;
      if (assets !== undefined) validateImageAssets(assets);
      const form = fileForm(document);
      // The ops field is the whole edit, presets included: a `style-tables` op
      // is an op like any other and rides this one JSON array. A separate form
      // field for the preset would be a second channel this client would have
      // to keep in step with the server's, which is how a switch that works on
      // a desktop host silently stops working here.
      form.append("ops", JSON.stringify(ops));
      if (options.verify) form.append("verify", "true");
      // A preset batch needs both fields, and neither is the caller's to
      // forget: without `allowPartial` the engine aborts the whole edit on a
      // table-less document, and without `report` its outcome is unknowable.
      const effective = presetBatchOptions(ops, options);
      if (effective.allowPartial) form.append("allowPartial", "true");
      // A `style-tables` op's outcome is only visible in the report: whether
      // the document had an eligible table, and whether anything else in the
      // batch failed. That makes the report part of this request, not an extra
      // the caller can forget to ask for.
      const wantsReport = effective.report === true;
      if (wantsReport) form.append("report", "true");
      if (assets !== undefined) {
        for (const asset of assets) form.append("asset", new Blob([asset.data as BlobPart], { type: imageAssetMediaType(asset.data)! }), asset.name);
      }
      const res = await request<EditResponse>("/edit", {
        method: "POST",
        body: form,
      });
      // Parsed only when this call needs it, and an unreadable answer is
      // dropped rather than failing an edit whose document was published: the
      // same rule the Tauri engine applies, so both transports answer one
      // shape for one request. A preset batch is different - its report IS the
      // outcome - so `readPresetBatch` refuses an unreadable one below.
      let report: EditReport | undefined;
      if (wantsReport && res.report !== undefined) {
        try {
          report = parseEditReport(res.report);
        } catch {
          report = undefined;
        }
      }
      if (carriesPresetSwitch(ops)) {
        const reading = readPresetBatch(report);
        if (reading.refusal !== null) {
          throw new HwpEngineError(reading.refusal.code, reading.refusal.message);
        }
      }
      return {
        name: res.name,
        data: fromBase64(res.dataBase64),
        ...(report === undefined ? {} : { report }),
      };
    },

    async compose(spec: DocumentSpecV2, name: string): Promise<ComposeResult> {
      const body: ComposeRequest = { spec, name };
      const res = await request<ComposeResponse>("/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        document: { name: res.name, data: fromBase64(res.dataBase64) },
        ...(res.report !== undefined ? { report: res.report } : {}),
      };
    },

    validate(document) {
      return request<ValidationReport>("/validate", {
        method: "POST",
        body: fileForm(document),
      });
    },

    async capabilities(): Promise<Capabilities> {
      const raw = reportObject(await request<unknown>("/capabilities", { method: "GET" }), "capabilities");
      const methods = raw.templateMethods === undefined ? [] : parseTemplateMethods(raw.templateMethods);
      const { imageAssets, styles, ...rest } = raw as unknown as Capabilities;
      return {
        ...rest,
        templateMethods: methods,
        ...(imageAssets === "v1" ? { imageAssets: "v1" as const } : {}),
        // Narrowed rather than passed through: a host that answers anything
        // else has not advertised the family, and the tab reads this field.
        ...(styles === "v1" ? { styles: "v1" as const } : {}),
      };
    },
  };
}

/** Exported for tests and for any non-HTTP adapter that needs the codec. */
export const base64 = { encode: toBase64, decode: fromBase64 };
