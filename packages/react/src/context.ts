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
  ValidationReport,
} from "@hwp-editor/core";
import type { TFunction } from "./messages.js";

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
  /** Open the compose panel (new-document flow). */
  openCompose: () => void;
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
