/**
 * Plain reducer-based editor store. No framework, no dependencies — hosts
 * wrap `createStore` with their own reactivity (React useSyncExternalStore,
 * Tauri signals, ...).
 */

import type { DocumentHandle, PageImage } from "./engine.js";
import type { HwpErrorCode } from "./errors.js";
import type { EditOp } from "./ops.js";
import type { SegmentRef } from "./segments.js";

export type EditorStatus = "clean" | "dirty" | "applying" | "error";

/**
 * A failure held by the store. `code` is optional on purpose: a
 * host-supplied engine, a mock, or a React-internal throw legitimately
 * carries none, and synthesizing `internal` would be indistinguishable
 * from a real `internal` emitted by the route layer. Build it with a
 * conditional spread rather than `{ code: undefined }`.
 */
export interface EditorError {
  /** Stable engine code, when the thrown value supplied one. */
  code?: HwpErrorCode;
  message: string;
}

export interface EditorState {
  /** Current document bytes; null before load. */
  document: DocumentHandle | null;
  /** Rendered pages of the current document. */
  pages: PageImage[];
  /** Selected source segment, if any. */
  selection: SegmentRef | null;
  /** Ops queued for the next engine edit call. */
  pendingOps: EditOp[];
  /**
   * Per-edit file snapshots for undo. snapshots[i] is the document bytes
   * before applied edit i; undo pops the top snapshot.
   */
  snapshots: DocumentHandle[];
  status: EditorStatus;
  /**
   * Failure when status is "error"; `code` is present when the engine
   * supplied one, so a non-React host reads it without parsing prose.
   */
  error: EditorError | null;
}

/**
 * Undo depth bound (BUG-05, D-11/D-12). Each snapshot retains a full copy of
 * the document bytes, so an unbounded stack grows without limit across a long
 * editing session. Overflow drops the oldest snapshot silently — there is no
 * "history truncated" notice. Not barrel-exported: the value is an internal
 * knob, not published API.
 */
export const MAX_SNAPSHOTS = 50;

export const initialState: EditorState = {
  document: null,
  pages: [],
  selection: null,
  pendingOps: [],
  snapshots: [],
  status: "clean",
  error: null,
};

export type EditorAction =
  | { type: "load"; document: DocumentHandle; pages?: PageImage[] }
  | { type: "setPages"; pages: PageImage[] }
  | { type: "select"; selection: SegmentRef | null }
  | { type: "queueOp"; op: EditOp }
  | { type: "dequeueOp"; index: number }
  | { type: "clearOps" }
  | { type: "applyStarted" }
  | { type: "applySucceeded"; document: DocumentHandle; pages?: PageImage[] }
  | { type: "applyFailed"; error: EditorError }
  | { type: "undo" };

export function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return {
        ...initialState,
        document: action.document,
        pages: action.pages ?? [],
      };
    case "setPages":
      return { ...state, pages: action.pages };
    case "select":
      return { ...state, selection: action.selection };
    case "queueOp":
      return {
        ...state,
        pendingOps: [...state.pendingOps, action.op],
        status: "dirty",
      };
    case "dequeueOp": {
      const pendingOps = state.pendingOps.filter((_, i) => i !== action.index);
      return {
        ...state,
        pendingOps,
        status: pendingOps.length === 0 ? "clean" : "dirty",
      };
    }
    case "clearOps":
      return { ...state, pendingOps: [], status: "clean" };
    case "applyStarted": {
      if (state.document === null) return state;
      // Snapshot the pre-edit bytes so the edit can be undone. Trim only
      // here: applyFailed and undo both assume the newest snapshot is the
      // tail, so trimming on any other action would desync them.
      return {
        ...state,
        snapshots: [...state.snapshots, state.document].slice(-MAX_SNAPSHOTS),
        status: "applying",
        error: null,
      };
    }
    case "applySucceeded":
      return {
        ...state,
        document: action.document,
        pages: action.pages ?? state.pages,
        pendingOps: [],
        selection: null,
        status: "clean",
        error: null,
      };
    case "applyFailed":
      // Roll back the snapshot pushed by applyStarted.
      return {
        ...state,
        snapshots: state.snapshots.slice(0, -1),
        status: "error",
        error: action.error,
      };
    case "undo": {
      const previous = state.snapshots[state.snapshots.length - 1];
      if (previous === undefined) return state;
      return {
        ...state,
        document: previous,
        snapshots: state.snapshots.slice(0, -1),
        pages: [],
        selection: null,
        status: state.pendingOps.length === 0 ? "clean" : "dirty",
        error: null,
      };
    }
  }
}

export interface EditorStore {
  getState(): EditorState;
  dispatch(action: EditorAction): void;
  subscribe(listener: () => void): () => void;
}

/** Minimal subscribable store over the pure reducer. */
export function createStore(initial: EditorState = initialState): EditorStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      state = reducer(state, action);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
