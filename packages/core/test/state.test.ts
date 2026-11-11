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

  it("selects unique refs with a coherent primary and batches ops atomically", () => {
    const a = { section: 0, para: 1, id: "a" };
    let s = reducer(loaded, { type: "selectMany", selections: [a, a, { section: 0, para: 2 }], primary: a });
    expect(s.selection).toEqual(a);
    expect(s.selections).toEqual([a, { section: 0, para: 2 }]);
    s = reducer(s, { type: "setRange", range: { paragraph: a, start: 2, end: 4 } });
    s = reducer(s, { type: "queueOps", ops: [
      { kind: "set-field", name: "a", value: "1" },
      { kind: "set-field", name: "b", value: "2" },
    ] });
    expect(s.pendingOps).toHaveLength(2);
    expect(s.status).toBe("dirty");
    const applying = reducer(s, { type: "applyStarted" });
    expect(reducer(applying, { type: "queueOps", ops: [{ kind: "set-field", name: "c", value: "3" }] })).toBe(applying);
  });

  it("single selection and lifecycle transitions clear every selection field", () => {
    let s = reducer(loaded, { type: "selectMany", selections: [{ section: 0, para: 2 }], anchor: { section: 0, para: 1 } });
    s = reducer(s, { type: "setRange", range: { paragraph: { section: 0, para: 2 }, start: 0, end: 1 } });
    s = reducer(s, { type: "select", selection: { section: 0, para: 3 } });
    expect(s.selections).toEqual([{ section: 0, para: 3 }]);
    expect(s.selectionAnchor).toBeNull();
    expect(s.range).toBeNull();
    s = reducer(s, { type: "applySucceeded", document: doc("a.hwpx", "v2") });
    expect(s.selections).toEqual([]);
    expect(s.selectionAnchor).toBeNull();
    expect(s.range).toBeNull();
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

  /**
   * #58 item 23a: the store's line is the caller's to restate when the
   * condition it described has changed — an apply dropped during a load says
   * "wait for it to finish", which a failed load makes impossible. It is not a
   * second way to report a failure, so a store with no error ignores it.
   */
  it("replaceError restates an error the store is already showing", () => {
    let s = reducer(loaded, {
      type: "queueOp",
      op: { kind: "delete-para", text: "x" },
    });
    s = reducer(s, { type: "applyStarted" });
    s = reducer(s, {
      type: "applyFailed",
      error: { message: "a new document is still loading" },
    });
    const restated = reducer(s, {
      type: "replaceError",
      error: { message: "the document changed under the edit" },
    });
    expect(restated.error?.message).toBe("the document changed under the edit");
    expect(restated.status).toBe("error");
    // Only the sentence moves: not the rollback, not the retryable queue.
    expect(restated.snapshots).toBe(s.snapshots);
    expect(restated.pendingOps).toHaveLength(1);

    // No error to restate, so nothing is painted.
    expect(reducer(loaded, { type: "replaceError", error: { message: "new" } })).toBe(loaded);
    const dirty = reducer(loaded, {
      type: "queueOp",
      op: { kind: "delete-para", text: "x" },
    });
    expect(reducer(dirty, { type: "replaceError", error: { message: "new" } })).toBe(dirty);
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

  it("applyFailed at the cap rolls back the newest snapshot and keeps the oldest", () => {
    let s = reducer(pushSnapshots(MAX_SNAPSHOTS), { type: "applyStarted" });
    expect(s.status).toBe("applying");
    s = reducer(s, { type: "applyFailed", error: { message: "boom" } });
    expect(s.snapshots).toHaveLength(MAX_SNAPSHOTS);
    expect(text(s.snapshots[s.snapshots.length - 1]!)).toBe("v50");
    // The edit never landed, so the oldest undo entry survives.
    expect(text(s.snapshots[0]!)).toBe("v1");
  });

  it("a no-op applyUnchanged at the cap does not cost the oldest undo entry", () => {
    let s = reducer(pushSnapshots(MAX_SNAPSHOTS), { type: "applyStarted" });
    expect(s.status).toBe("applying");
    s = reducer(s, { type: "applyUnchanged" });
    expect(s.snapshots).toHaveLength(MAX_SNAPSHOTS);
    expect(text(s.snapshots[0]!)).toBe("v1");
    expect(text(s.snapshots[s.snapshots.length - 1]!)).toBe("v50");
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

describe("applying transaction lock", () => {
  it("refuses queue plus reentrant apply without adding a second snapshot", () => {
    const applying=reducer(loaded,{type:"applyStarted"});
    let next=reducer(applying,{type:"queueOp",op:{kind:"set-field",name:"date",value:"2026-11-11"}});
    next=reducer(next,{type:"applyStarted"});
    expect(next).toBe(applying);
    expect(next.pendingOps).toEqual([]);
    expect(next.snapshots).toHaveLength(1);
    const applied=reducer(next,{type:"applySucceeded",document:doc("a.hwpx","v2")});
    const undone=reducer(applied,{type:"undo"});
    expect(undone.document).toBe(loaded.document);
    expect(undone.snapshots).toEqual([]);
  });
  it("keeps other queue mutations and undo from releasing the applying lock", () => {
    const queued=reducer(loaded,{type:"queueOp",op:{kind:"set-field",name:"date",value:"x"}});
    const applying=reducer(queued,{type:"applyStarted"});
    for (const action of [{type:"clearOps"},{type:"dequeueOp",index:0},{type:"undo"}] as const) {
      expect(reducer(applying,action)).toBe(applying);
    }
  });
});

/**
 * #58 item 22: the host can choose no document, and the store must be able to
 * follow it there — including out of "applying", which no other action
 * reaches. Apply, the template panel and Styles all read this store, so an
 * empty one is what makes them act on nothing.
 */
describe("unload", () => {
  it("empties a store whose document was closed mid-apply", () => {
    const applying = reducer(loaded, { type: "applyStarted" });
    expect(applying.status).toBe("applying");
    expect(applying.snapshots).toHaveLength(1);
    // Closing a document is the one way out of the lock; the lock itself is
    // untouched, so a queued op still changes nothing here.
    expect(
      reducer(applying, {
        type: "queueOp",
        op: { kind: "set-field", name: "date", value: "2026-11-12" },
      }),
    ).toBe(applying);

    const closed = reducer(applying, { type: "unload" });
    expect(closed).toBe(initialState);
    expect(closed.status).toBe("clean");
    expect(closed.document).toBeNull();
    expect(closed.snapshots).toEqual([]);
  });

  it("drops ops staged against the closed document and their snapshots", () => {
    let s = reducer(loaded, { type: "applyStarted" });
    s = reducer(s, { type: "applySucceeded", document: doc("a.hwpx", "v2") });
    s = reducer(s, {
      type: "queueOp",
      op: { kind: "delete-para", text: "gone" },
    });
    s = reducer(s, { type: "select", selection: { section: 0, para: 0 } });
    expect(s.status).toBe("dirty");
    expect(s.snapshots).toHaveLength(1);

    expect(reducer(s, { type: "unload" })).toBe(initialState);
  });
});
