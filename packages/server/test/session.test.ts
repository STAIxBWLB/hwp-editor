import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DocumentInspection } from "../src/cli-engine.js";
import { createSessionStore, SessionNotFoundError, type SessionStore } from "../src/session.js";

function inspection(markdown: string): DocumentInspection {
  return {
    envelope: { markdown, segments: [] },
    fields: null,
    bookmarks: null,
    slots: null,
    info: null,
    capabilities: { editable: true },
  };
}

describe("session store", () => {
  it("creates a session and hands back the attached inspection", () => {
    const store: SessionStore = createSessionStore();
    const session = store.create("sample.hwpx");
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.name).toBe("sample.hwpx");
    expect(store.get(session.id).inspection).toBeUndefined();
    store.attachInspection(session.id, inspection("# hi"));
    expect(store.get(session.id).inspection?.envelope.markdown).toBe("# hi");
    expect(store.size()).toBe(1);
    expect(store.ids()).toEqual([session.id]);
  });

  it("touches the filesystem on no code path", async () => {
    // A root this case owns, not the shared tmpdir (#58 item 31): another
    // worker writing there mid-run would land in a listing of the whole
    // machine, and this case is about what the store creates. Pointing
    // TMPDIR here means anything the store wrote would land in this tree.
    const root = await mkdtemp(join(tmpdir(), "hwped-session-root-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      // The mechanism, asserted rather than assumed: if os.tmpdir() ever
      // stopped following TMPDIR, the empty listing below would read as proof
      // while the store wrote somewhere else.
      expect(tmpdir()).toBe(root);
      const store = createSessionStore();
      const session = store.create("doc.hwpx");
      store.attachInspection(session.id, inspection("x"));
      store.get(session.id);
      store.sweep(Date.now() + 60 * 60 * 1000);
      store.dispose();
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains no document bytes and exposes no filesystem surface", () => {
    const store = createSessionStore() as unknown as Record<string, unknown>;
    for (const gone of ["snapshot", "undo", "put", "exportBytes", "resolvePath", "rootDir"]) {
      expect(store[gone], gone).toBeUndefined();
    }
    expect(Object.keys(store).sort()).toEqual(
      ["attachInspection", "create", "dispose", "get", "has", "ids", "size", "sweep"].sort(),
    );
  });

  it("rejects unknown and malformed session ids", () => {
    const store = createSessionStore();
    expect(() => store.get("../../tmp")).toThrow(SessionNotFoundError);
    expect(() => store.get("not-a-uuid")).toThrow(SessionNotFoundError);
    expect(() => store.get(crypto.randomUUID())).toThrow(SessionNotFoundError);
    expect(store.has(crypto.randomUUID())).toBe(false);
  });

  it("sweep removes sessions past their TTL", () => {
    const store = createSessionStore({ ttlMs: 1000 });
    store.create("doc.hwpx");
    expect(store.sweep(Date.now() + 60_000)).toBe(1);
    expect(store.size()).toBe(0);
  });

  it("keeps fresh sessions when sweeping, and dispose empties the store", () => {
    const store = createSessionStore({ ttlMs: 60_000 });
    store.create("doc.hwpx");
    expect(store.sweep()).toBe(0);
    expect(store.size()).toBe(1);
    store.dispose();
    expect(store.size()).toBe(0);
  });
});
