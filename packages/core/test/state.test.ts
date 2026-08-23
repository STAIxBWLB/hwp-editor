import { describe, expect, it } from "vitest";
import {
  createStore,
  initialState,
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
    s = reducer(s, { type: "applyFailed", error: "no target matched" });
    expect(s.status).toBe("error");
    expect(s.error).toBe("no target matched");
    expect(s.snapshots).toHaveLength(0);
    // pending ops survive a failed apply so the user can retry
    expect(s.pendingOps).toHaveLength(1);
  });

  it("applyStarted without a document does nothing", () => {
    expect(reducer(initialState, { type: "applyStarted" })).toBe(
      initialState,
    );
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
