/**
 * Wire contract for the HTTP engine. packages/server (Phase 2) implements
 * these routes on top of the hwp-cli binary; packages/core's http-engine.ts
 * is the reference client.
 *
 * Routes (base = server prefix):
 *   POST {base}/read         multipart: file=<document>            -> ReadResponse
 *   POST {base}/render       multipart: file=<document>,
 *                            fields: pages?, dpi?, format?         -> RenderResponse
 *   POST {base}/edit         multipart: file=<document>,
 *                            field: ops=<EditOp[] JSON>,
 *                            fields: verify?, allowPartial?        -> EditResponse
 *   POST {base}/compose      JSON: ComposeRequest                  -> ComposeResponse
 *   POST {base}/slots        multipart: file=<document>            -> SlotsResponse
 *   POST {base}/fill         multipart: file=<document>, values=<JSON> -> FillResponse
 *   POST {base}/lint         multipart: file=<document>, profile?  -> LintResponse
 *   POST {base}/template     JSON: TemplateRequest                 -> TemplateResponse
 *   POST {base}/create       JSON: CreateRequest                   -> EditResponse
 *   GET  {base}/templates                                       -> TemplatesResponse
 *   POST {base}/validate     multipart: file=<document>            -> ValidateResponse
 *   GET  {base}/capabilities                                       -> CapabilitiesResponse
 *
 * Binary payloads cross the wire as base64 inside JSON responses; uploads
 * use multipart/form-data. Every error is an ErrorResponse with a non-2xx
 * status.
 */

import type {
  Capabilities,
  PageImageFormat,
  PageLayout,
  ValidationReport,
} from "./engine.js";
import type { EditOp } from "./ops.js";
import type { CatEnvelope } from "./segments.js";
import type { DocumentSpecV2 } from "./generated/document-spec-v2.js";
import type { TemplateDataV1, TemplateSpecV1 } from "./spec.js";
import type { EmbeddedTemplate, FillReport, LintReport, TemplateInputs, TemplateReport } from "./templates.js";

/** POST /read response — the `hwp cat --with-segments` envelope verbatim. */
export type ReadResponse = CatEnvelope;

export interface RenderPageWire {
  page: number;
  width: number;
  height: number;
  dpi: number;
  format: PageImageFormat;
  /** Base64-encoded image bytes. */
  dataBase64: string;
  layout?: PageLayout;
}

/** POST /render response. */
export interface RenderResponse {
  pages: RenderPageWire[];
}

/** POST /edit response — the edited document. */
export interface EditResponse {
  name: string;
  /** Base64-encoded document bytes. */
  dataBase64: string;
}

/** POST /compose request (JSON body). */
export interface ComposeRequest {
  spec: DocumentSpecV2;
  /** Output file name, e.g. "report.hwpx". */
  name: string;
}

/** POST /compose response. */
export interface ComposeResponse {
  name: string;
  dataBase64: string;
  /** Raw compile/validation report JSON, when produced. */
  report?: unknown;
}

/** New template command wires, introduced by hwp-cli 1.4.0. */
export interface FillResponse extends EditResponse {
  report: FillReport;
}
export interface TemplateResponse extends EditResponse {
  report?: TemplateReport;
}
export interface TemplateRequest {
  spec: TemplateSpecV1;
  data: TemplateDataV1;
  name: string;
}
export interface CreateRequest {
  templateId: string;
  name: string;
}
export type SlotsResponse = TemplateInputs;
export type LintResponse = LintReport;
export type TemplatesResponse = EmbeddedTemplate[];

/** POST /validate response. */
export type ValidateResponse = ValidationReport;

/** GET /capabilities response. */
export type CapabilitiesResponse = Capabilities;

/** Error shape returned with any non-2xx status. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
