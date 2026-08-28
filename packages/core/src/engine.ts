import type { EditOp } from "./ops.js";
import type { CatEnvelope } from "./segments.js";
import type { DocumentSpecV2 } from "./generated/document-spec-v2.js";

/** A document passed to or returned from an engine, as raw bytes. */
export interface DocumentHandle {
  /** File name, including the .hwp/.hwpx extension. */
  name: string;
  data: Uint8Array;
}

export type PageImageFormat = "png" | "jpeg" | "webp" | "svg";

export interface PageImage {
  /** 1-based page number. */
  page: number;
  width: number;
  height: number;
  dpi: number;
  format: PageImageFormat;
  data: Uint8Array;
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
}

export interface Capabilities {
  /** hwp-cli version string, e.g. "0.8.8". */
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
  /** Extract markdown + source segments (`hwp cat --with-segments`). */
  read(document: DocumentHandle): Promise<CatEnvelope>;
  /** Rasterize pages (`hwp render`). */
  render(document: DocumentHandle, options?: RenderOptions): Promise<PageImage[]>;
  /** Apply edit ops (`hwp edit`), returning the edited document. */
  edit(
    document: DocumentHandle,
    ops: EditOp[],
    options?: EditOptions,
  ): Promise<DocumentHandle>;
  /** Compose a document from DocumentSpec v2 (`hwp compose`). */
  compose(spec: DocumentSpecV2, name: string): Promise<ComposeResult>;
  /** Structural validation (`hwp validate`). */
  validate(document: DocumentHandle): Promise<ValidationReport>;
  /** Engine capabilities, including editability of protected documents. */
  capabilities(): Promise<Capabilities>;
}
