import { describe, expect, it } from "vitest";
import {
  createStore,
  initialState,
  MAX_SNAPSHOTS,
  reducer,
  type EditorState,
} from "../src/state.js";
import type { DocumentHandle } from "../src/engine.js";

const doc = (name: string, text: string): DocumentHandle => ({
  name,
  data: new TextEncoder().encode(text),
});

const loaded: EditorState = reducer(initialState, {
  type: "load",
  document: doc("a.hwpx", "v1"),
});

describe("reducer", () => {
  it("queues ops and marks the document dirty", () => {
    const s = reducer(loaded, {
      type: "queueOp",
      op: { kind: "replace", find: "a", replace: "b" },
    });
    expect(s.pendingOps).toHaveLength(1);
    expect(s.status).toBe("dirty");
    expect(s.document?.name).toBe("a.hwpx");
  });

  it("apply lifecycle: snapshot on start, clean on success", () => {
    let s = reducer(loaded, {
      type: "queueOp",
      op: { kind: "replace", find: "a", replace: "b" },
    });
    s = reducer(s, { type: "applyStarted" });
    expect(s.status).toBe("applying");
    expect(s.snapshots).toHaveLength(1);
    expect(new TextDecoder().decode(s.snapshots[0]!.data)).toBe("v1");

    s = reducer(s, {
      type: "applySucceeded",
      document: doc("a.hwpx", "v2"),
    });
    expect(s.status).toBe("clean");
    expect(s.pendingOps).toHaveLength(0);
    expect(new TextDecoder().decode(s.document!.data)).toBe("v2");
  });

  it("undo restores the pre-edit snapshot", () => {
    let s = reducer(loaded, {
      type: "queueOp",
      op: { kind: "replace", find: "a", replace: "b" },
    });
    s = reducer(s, { type: "applyStarted" });
    s = reducer(s, { type: "applySucceeded", document: doc("a.hwpx", "v2") });
    s = reducer(s, { type: "undo" });
    expect(new TextDecoder().decode(s.document!.data)).toBe("v1");
    expect(s.snapshots).toHaveLength(0);
    expect(s.status).toBe("clean");
  });

  it("undo is a no-op with an empty snapshot stack", () => {
    expect(reducer(loaded, { type: "undo" })).toBe(loaded);
  });

  it("applyFailed rolls back the snapshot and records the error", () => {
    let s = reducer(loaded, {
      type: "queueOp",
      op: { kind: "delete-para", text: "x" },
    });
    s = reducer(s, { type: "applyStarted" });
    s = reducer(s, {
      type: "applyFailed",
      error: { message: "no target matched" },
    });
    expect(s.status).toBe("error");
    expect(s.error?.message).toBe("no target matched");
    // A carrier that saw no code leaves the field absent rather than
    // synthesizing `internal`, which would be indistinguishable from a
    // real one emitted by the route layer.
    expect(s.error !== null && "code" in s.error).toBe(false);
    expect(s.snapshots).toHaveLength(0);
    // pending ops survive a failed apply so the user can retry
    expect(s.pendingOps).toHaveLength(1);
  });

  it("applyFailed preserves the engine code on the store", () => {
    let s = reducer(loaded, {
      type: "queueOp",
      op: { kind: "delete-para", text: "x" },
    });
    s = reducer(s, { type: "applyStarted" });
    s = reducer(s, {
      type: "applyFailed",
      error: { code: "protected", message: "이 문서는 편집할 수 없습니다" },
    });
    expect(s.error?.code).toBe("protected");
  });

  it("applyStarted without a document does nothing", () => {
    expect(reducer(initialState, { type: "applyStarted" })).toBe(
      initialState,
    );
  });
});

/**
 * BUG-05: the undo snapshot stack is bounded by count (D-11) and overflow
 * drops the oldest snapshot silently (D-12). The trim happens only at the
 * `applyStarted` push, so `applyFailed`'s tail rollback and `undo`'s tail pop
 * keep working unchanged (research Pitfall P10).
 */
describe("snapshot bound", () => {
  /** Run `n` complete apply cycles from `loaded`, so snapshots[i-1] is `v{i}`. */
  const pushSnapshots = (n: number): EditorState => {
    let s = loaded;
    for (let i = 1; i <= n; i++) {
      s = reducer(s, { type: "applyStarted" });
      s = reducer(s, {
        type: "applySucceeded",
        document: doc("a.hwpx", `v${i + 1}`),
      });
    }
    return s;
  };

  const text = (d: DocumentHandle): string => new TextDecoder().decode(d.data);

  it("keeps exactly MAX_SNAPSHOTS entries past the bound", () => {
    expect(MAX_SNAPSHOTS).toBe(50);
    expect(pushSnapshots(MAX_SNAPSHOTS).snapshots).toHaveLength(MAX_SNAPSHOTS);
    expect(pushSnapshots(MAX_SNAPSHOTS + 1).snapshots).toHaveLength(
      MAX_SNAPSHOTS,
    );
  });

  it("drops the oldest snapshot, not the newest", () => {
    const { snapshots } = pushSnapshots(MAX_SNAPSHOTS + 1);
    // v1 — the document loaded first — is gone; the window starts at v2.
    expect(text(snapshots[0]!)).toBe("v2");
    expect(text(snapshots[snapshots.length - 1]!)).toBe("v51");
  });

  it("applyFailed still rolls back exactly the newest snapshot after overflow", () => {
    let s = reducer(pushSnapshots(MAX_SNAPSHOTS), { type: "applyStarted" });
    expect(s.snapshots).toHaveLength(MAX_SNAPSHOTS);
    s = reducer(s, { type: "applyFailed", error: { message: "boom" } });
    expect(s.snapshots).toHaveLength(MAX_SNAPSHOTS - 1);
    // Tail popped; the oldest-drop from the overflowing push stays dropped.
    expect(text(s.snapshots[s.snapshots.length - 1]!)).toBe("v50");
    expect(text(s.snapshots[0]!)).toBe("v2");
  });

  it("undo still returns and pops the newest snapshot after overflow", () => {
    const s = reducer(pushSnapshots(MAX_SNAPSHOTS + 1), { type: "undo" });
    expect(text(s.document!)).toBe("v51");
    expect(s.snapshots).toHaveLength(MAX_SNAPSHOTS - 1);
    expect(text(s.snapshots[0]!)).toBe("v2");
  });
});

describe("createStore", () => {
  it("notifies subscribers on dispatch and supports unsubscribe", () => {
    const store = createStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.dispatch({ type: "load", document: doc("a.hwpx", "v1") });
    store.dispatch({ type: "select", selection: { section: 0, para: 1 } });
    expect(calls).toBe(2);
    expect(store.getState().selection).toEqual({ section: 0, para: 1 });
    unsubscribe();
    store.dispatch({ type: "select", selection: null });
    expect(calls).toBe(2);
  });
});
