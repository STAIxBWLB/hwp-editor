/**
 * HwpEngine client for Tauri hosts (e.g. maru). Calls Rust commands named
 * `hwped_read / hwped_render / hwped_edit / hwped_compose / hwped_validate /
 * hwped_capabilities`; payloads mirror the protocol.ts wire shapes, with two
 * Tauri-specific deltas:
 *
 *   - File transfer: a document that already lives in the workspace crosses
 *     the bridge as a path string (`pathOf`); only in-memory bytes are sent,
 *     as base64 (`dataBase64`). Rust resolves relative paths against
 *     `workspaceRoot`.
 *   - Edit: EditOp[] is serialized JS-side via opsToArgv and crosses as
 *     `opsArgv` argv fragments, so the Rust side stays a thin spawner with
 *     no op grammar of its own.
 *
 * Zero dependencies: `invoke` is injected (peer pattern) — pass the real
 * `@tauri-apps/api/core` invoke in the host. Response shapes are the same
 * JSON the HTTP routes return (protocol.ts), so host code can swap
 * createHttpEngine <-> createTauriEngine without touching the editor.
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
import type { EditOp } from "./ops.js";
import { opsToArgv } from "./ops.js";
import type { CatEnvelope } from "./segments.js";
import type { DocumentSpecV2 } from "./generated/document-spec-v2.js";
import type {
  ComposeResponse,
  EditResponse,
  RenderResponse,
} from "./protocol.js";
import { base64 } from "./http-engine.js";

/** Signature of `@tauri-apps/api/core`'s invoke, declared here so core stays
 *  dependency-free (peer pattern: the host injects the real one). */
export type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * How a document crosses the Tauri bridge: a workspace path when the bytes
 * are already on disk (preferred), base64 bytes otherwise.
 */
export interface TauriDocumentRef {
  /** File name, including the .hwp/.hwpx extension. */
  name: string;
  /** Workspace-relative (or absolute) path to the document on disk. */
  path?: string;
  /** Base64-encoded bytes — only when the document is not on disk. */
  dataBase64?: string;
}

export interface TauriEngineOptions {
  /**
   * Workspace root the Rust side resolves relative `path`s against. Passed
   * through on every call as `workspaceRoot`.
   */
  workspaceRoot?: string;
  /**
   * Return a workspace-relative (or absolute) path for a document that
   * already lives on disk. When it returns undefined the document bytes are
   * sent as base64 instead.
   */
  pathOf?: (document: DocumentHandle) => string | undefined;
}

export function createTauriEngine(
  invoke: TauriInvoke,
  opts: TauriEngineOptions = {},
): HwpEngine {
  function ref(document: DocumentHandle): TauriDocumentRef {
    const path = opts.pathOf?.(document);
    if (path !== undefined) return { name: document.name, path };
    return { name: document.name, dataBase64: base64.encode(document.data) };
  }

  function scope(): Record<string, unknown> {
    return opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {};
  }

  async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await invoke<T>(cmd, args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${cmd} failed: ${detail}`);
    }
  }

  return {
    read(document) {
      return call<CatEnvelope>("hwped_read", {
        document: ref(document),
        ...scope(),
      });
    },

    async render(document, options: RenderOptions = {}) {
      const res = await call<RenderResponse>("hwped_render", {
        document: ref(document),
        options,
        ...scope(),
      });
      return res.pages.map(
        (p): PageImage => ({
          page: p.page,
          width: p.width,
          height: p.height,
          dpi: p.dpi,
          format: p.format,
          data: base64.decode(p.dataBase64),
        }),
      );
    },

    async edit(document, ops: EditOp[], options: EditOptions = {}) {
      const res = await call<EditResponse>("hwped_edit", {
        document: ref(document),
        opsArgv: opsToArgv(ops),
        ...(options.verify !== undefined ? { verify: options.verify } : {}),
        ...(options.allowPartial !== undefined
          ? { allowPartial: options.allowPartial }
          : {}),
        ...scope(),
      });
      return { name: res.name, data: base64.decode(res.dataBase64) };
    },

    async compose(spec: DocumentSpecV2, name: string): Promise<ComposeResult> {
      const res = await call<ComposeResponse>("hwped_compose", { spec, name });
      return {
        document: { name: res.name, data: base64.decode(res.dataBase64) },
        ...(res.report !== undefined ? { report: res.report } : {}),
      };
    },

    validate(document) {
      return call<ValidationReport>("hwped_validate", {
        document: ref(document),
        ...scope(),
      });
    },

    capabilities() {
      return call<Capabilities>("hwped_capabilities", {});
    },
  };
}
