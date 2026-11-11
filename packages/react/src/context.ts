/**
 * Internal React context shared by HwpEditor's panels.
 */

import { createContext, useContext } from "react";
import type {
  Capabilities,
  CatEnvelope,
  DocumentHandle,
  EditorState,
  EditorStore,
  HwpEngine,
  EditOp,
  ImageAsset,
  StyleTable,
  ValidationReport,
} from "@hwp-editor/core";
import type { TFunction } from "./messages.js";

/**
 * The state of the document's styles read, so a consumer telling the user why
 * there are no rows can name the right cause: still loading, failed, a host
 * that advertises the command and does not implement it, or no styles command
 * at all are four different next steps.
 */
export type StylesStatus = "idle" | "loading" | "ready" | "failed" | "unsupported";

export interface HwpEditorContextValue {
  engine: HwpEngine;
  store: EditorStore;
  /** Current store snapshot (from useSyncExternalStore). */
  state: EditorState;
  /** Last read() envelope for the current document; null before load. */
  envelope: CatEnvelope | null;
  capabilities: Capabilities | null;
  /** False for protected/distribution documents: editing UI is disabled. */
  editable: boolean;
  validation: ValidationReport | null;
  /** Queue an image op with bytes held privately until the next apply. */
  queueImage?: (op: Extract<EditOp, { kind: "insert-image" }>, asset: ImageAsset) => void;
  /** Queue of pending ops length convenience. */
  applyPendingOps: () => void;
  /**
   * Replace the current document as one undoable transition. The producer
   * receives the captured current document; results are discarded if it or
   * the loaded file changes while the operation is in flight, and the answer
   * says which happened, so a caller never acts on a replacement the editor
   * threw away.
   */
  replaceDocument: (
    produce: (current: DocumentHandle) => Promise<DocumentHandle>,
  ) => Promise<boolean>;
  /** Re-read + re-render the current document after an external change. */
  refresh: () => Promise<void>;
  /**
   * The current document's `styles-v1` table, or null when this host has no
   * styles command, the read is still running, or it failed. Loaded once per
   * document by the editor, so the Styles panel and the direct-format
   * indicator read one table rather than two snapshots that can disagree. A
   * table read for a PREVIOUS document is never handed out: segment ids are
   * content checksums, so the old table's `used_by` would name paragraphs this
   * document does not have.
   */
  styles: StyleTable | null;
  /**
   * Why `styles` is what it is: `ready` with a table, `loading` while the read
   * runs, `failed` when it threw, `unsupported` when the host advertises the
   * command and the engine object has no `styles` to call, and `idle` when
   * this host serves no styles command at all. Four empty states need four
   * sentences, so a consumer that reports one reads this rather than guessing
   * from `styles === null`.
   */
  stylesStatus: StylesStatus;
  /**
   * The editor's document generation. It moves when a load starts and when
   * the compose flow hands a document back, so an async flow captures it
   * before it awaits and refuses its own result once it has moved on: a slow
   * compose must not replace the file the host selected meanwhile.
   */
  loadEpoch: () => number;
  /** Open the compose panel (new-document flow). */
  openCompose: () => void;
  /**
   * Put one sentence on the editor's notice line. A panel that learns an
   * outcome the user must hear but that is not an error — a preset whose
   * document has no table to style — reports it here instead of through
   * `onError`, which promises something went wrong.
   */
  noteNotice: (text: string, error?: unknown) => void;
  /**
   * Message lookup bound to the active locale and host overrides. Every
   * panel localizes through this one channel; a panel that cannot reach `t`
   * cannot be localized at all.
   */
  t: TFunction;
  /**
   * Host error callback, passed straight through from `HwpEditorProps`. A
   * panel that owns its own error state (ComposePanel) has no other way to
   * reach the host; the caught value travels verbatim.
   */
  // `| undefined` is load-bearing under exactOptionalPropertyTypes: the
  // provider spreads the prop through whether or not the host passed one.
  onError?: ((error: unknown) => void) | undefined;
}

export const HwpEditorContext = createContext<HwpEditorContextValue | null>(
  null,
);

export function useHwpEditorContext(): HwpEditorContextValue {
  const value = useContext(HwpEditorContext);
  if (value === null) {
    throw new Error("hwp-editor panels must be rendered inside <HwpEditor>");
  }
  return value;
}
