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
import type { HwpErrorCode } from "./errors.js";
import type { EditOp } from "./ops.js";
import type { CatEnvelope } from "./segments.js";
import type { DocumentSpecV2 } from "./generated/document-spec-v2.js";
import type {
  ComposeRequest,
  ComposeResponse,
  EditResponse,
  ErrorResponse,
  RenderResponse,
} from "./protocol.js";

export interface HttpEngineOptions {
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
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
      { status: res.status, cause: body },
    );
  } catch {
    return new HwpEngineError(
      codeForStatus(res.status),
      `hwp-engine HTTP ${res.status}: ${res.statusText}`,
      { status: res.status },
    );
  }
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

  return {
    read(document) {
      return request<CatEnvelope>("/read", {
        method: "POST",
        body: fileForm(document),
      });
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
          data: fromBase64(p.dataBase64),
        }),
      );
    },

    async edit(document, ops: EditOp[], options: EditOptions = {}) {
      const form = fileForm(document);
      form.append("ops", JSON.stringify(ops));
      if (options.verify) form.append("verify", "true");
      if (options.allowPartial) form.append("allowPartial", "true");
      const res = await request<EditResponse>("/edit", {
        method: "POST",
        body: form,
      });
      return { name: res.name, data: fromBase64(res.dataBase64) };
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

    capabilities(): Promise<Capabilities> {
      return request<Capabilities>("/capabilities", { method: "GET" });
    },
  };
}

/** Exported for tests and for any non-HTTP adapter that needs the codec. */
export const base64 = { encode: toBase64, decode: fromBase64 };
