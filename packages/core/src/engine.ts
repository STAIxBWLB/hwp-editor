import type { TemplateDataV1, TemplateSpecV1 } from "./spec.js";
import type { EmbeddedTemplate, FillResult, LintProfile, LintReport, TemplateInputs, TemplateMethod } from "./templates.js";
import type { EditOp } from "./ops.js";
import type { EditReport } from "./edit-report.js";
import type { CatEnvelope } from "./segments.js";
import type { StyleTable, StyleTablePreset } from "./styles.js";
import type { DocumentSpecV2 } from "./generated/document-spec-v2.js";

export interface ImageAsset {
  name: string;
  data: Uint8Array;
}

/** A document passed to or returned from an engine, as raw bytes. */
export interface DocumentHandle {
  /** File name, including the .hwp/.hwpx extension. */
  name: string;
  data: Uint8Array;
}

export type PageImageFormat = "png" | "jpeg" | "webp" | "svg";

/** render-layout-v1 row. IDs join the segment envelope; source_chars are UTF-16
 * source-paragraph offsets, never markdown offsets. Duplicate IDs are retained. */
export interface LayoutRow {
  id: string;
  kind: "para" | "table" | "cell" | "bookmark";
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  source_chars: { start: number; end: number } | null;
}

/** Geometry in points (top-left origin), independent of render DPI/format. */
export interface PageLayout {
  width_pt: number;
  height_pt: number;
  rows: LayoutRow[];
  /** Missing rows are inconclusive when recording reached the engine span cap. */
  truncated: boolean;
}

export interface PageImage {
  /** 1-based page number. */
  page: number;
  width: number;
  height: number;
  dpi: number;
  format: PageImageFormat;
  data: Uint8Array;
  /** Absent on older hosts; an empty row list means measured empty geometry. */
  layout?: PageLayout;
}

export interface RenderOptions {
  /** Page range: "1", "1-3", "all" (default "all"). */
  pages?: string;
  /** Resolution, 36..=600 (default 96). */
  dpi?: number;
  format?: PageImageFormat;
}

export interface EditOptions {
  /** Verify by re-reading after writing (`hwp edit --verify`). */
  verify?: boolean;
  /** Publish matched edits even if some found no target (`--allow-partial`). */
  allowPartial?: boolean;
  /** Image bytes referenced by insert-image operations. */
  assets?: ImageAsset[];
  /**
   * Ask the engine for `edit-report-v1` (`hwp edit --report <FILE>`, hwp-cli
   * 1.4.0+). Only this report names the segment ids an insertion created, so a
   * caller that will reorder or remove what it inserted has to ask for it.
   */
  report?: boolean;
  /**
   * Style every eligible table under an official preset (`hwp edit
   * --style-tables <preset>`, hwp-cli 1.4.0+). The engine keeps this flag and
   * `--ops` mutually exclusive, so a call carrying `styleTables` must carry no
   * ops: the preset switch in this editor is two calls grouped into one undo
   * entry, not one call.
   */
  styleTables?: StyleTablePreset;
}

/**
 * An edited document, plus the report when one was asked for and returned. The
 * report stays optional because an older host answers without one; a consumer
 * must then treat the inserted ids as unknown rather than guess them.
 */
export interface EditResult extends DocumentHandle {
  report?: EditReport;
}

export interface Capabilities {
  /** Optional command advertisement; an empty list means this host lacks the commands. */
  templateMethods?: TemplateMethod[];
  /** JSON edit-ops-v1 supported by both this client and its host. Absent on argv-only hosts. */
  editOps?: "v1";
  /** Safe uploaded PNG/JPEG image asset staging is supported. */
  imageAssets?: "v1";
  /** `hwp styles` + style ops + `--style-tables` are supported (hwp-cli 1.4.0+). */
  styles?: "v1";
  /** hwp-cli version string, e.g. "0.16.0". */
  version: string;
  /** Whether the engine can apply edits right now. */
  editable: boolean;
  /** Why editing is unavailable (e.g. protected/distribution document). */
  reason?: string;
  /** Document formats the engine accepts, e.g. ["hwp", "hwpx"]. */
  formats: string[];
}

export interface ValidationError {
  code: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationError[];
}

export interface ComposeResult {
  document: DocumentHandle;
  /** Raw compile/validation report JSON, when the engine provides one. */
  report?: unknown;
}

/**
 * Engine abstraction over the hwp-cli binary. Implementations: a local
 * subprocess adapter, or the HTTP client in http-engine.ts. All document
 * logic lives behind this interface; the editor never parses HWP itself.
 */
export interface HwpEngine {
  /** Template commands require hwp-cli >= 1.4.0; optional for older hosts. */
  slots?(document: DocumentHandle): Promise<TemplateInputs>;
  fill?(document: DocumentHandle, values: Record<string, string>): Promise<FillResult>;
  template?(spec: TemplateSpecV1, data: TemplateDataV1, name: string): Promise<ComposeResult>;
  lint?(document: DocumentHandle, profile?: LintProfile): Promise<LintReport>;
  listTemplates?(): Promise<EmbeddedTemplate[]>;
  create?(templateId: string, name: string): Promise<DocumentHandle>;
  /**
   * Named styles with their resolved attributes and the segments using them
   * (`hwp styles <file> --format json`, hwp-cli 1.4.0+). Optional for the same
   * reason the template methods are: an older host has no such command.
   */
  styles?(document: DocumentHandle): Promise<StyleTable>;

  /** Extract markdown + source segments (`hwp cat --with-segments`). */
  read(document: DocumentHandle): Promise<CatEnvelope>;
  /** Rasterize pages (`hwp render`). */
  render(document: DocumentHandle, options?: RenderOptions): Promise<PageImage[]>;
  /** Apply edit ops (`hwp edit`), returning the edited document. */
  edit(
    document: DocumentHandle,
    ops: EditOp[],
    options?: EditOptions,
  ): Promise<EditResult>;
  /** Compose a document from DocumentSpec v2 (`hwp compose`). */
  compose(spec: DocumentSpecV2, name: string): Promise<ComposeResult>;
  /** Structural validation (`hwp validate`). */
  validate(document: DocumentHandle): Promise<ValidationReport>;
  /** Engine capabilities, including editability of protected documents. */
  capabilities(): Promise<Capabilities>;
}
