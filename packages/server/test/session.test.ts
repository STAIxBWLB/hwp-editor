import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionStore,
  PathTraversalError,
  SessionNotFoundError,
  type SessionStore,
} from "../src/session.js";

const BYTES_A = new Uint8Array([1, 2, 3, 4]);
const BYTES_B = new Uint8Array([5, 6, 7, 8]);

describe("session store", () => {
  let store: SessionStore;

  afterEach(async () => {
    await store?.dispose();
  });

  it("creates a session with the uploaded bytes and exports them back", async () => {
    store = createSessionStore();
    const session = await store.create("sample.hwpx", BYTES_A);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.dir.startsWith(session.dir.split(path.sep)[0]!)).toBe(true);
    const exported = await store.exportBytes(session.id);
    expect(exported.name).toBe("sample.hwpx");
    expect([...exported.data]).toEqual([...BYTES_A]);
    expect(store.size()).toBe(1);
    expect(store.ids()).toEqual([session.id]);
  });

  it("keeps the store root under the system temp dir by default", async () => {
    store = createSessionStore();
    const session = await store.create("a.hwpx", BYTES_A);
    expect(session.dir.startsWith(tmpdir())).toBe(true);
  });

  it("snapshots before edit and undo restores the pre-edit bytes", async () => {
    store = createSessionStore();
    const session = await store.create("doc.hwpx", BYTES_A);
    await store.snapshot(session.id);
    await store.put(session.id, "doc.hwpx", BYTES_B);
    expect((await store.exportBytes(session.id)).data).toEqual(BYTES_B);
    const restored = await store.undo(session.id);
    expect(restored).not.toBeNull();
    expect([...restored!.data]).toEqual([...BYTES_A]);
    expect((await store.exportBytes(session.id)).data).toEqual(BYTES_A);
    // History exhausted.
    expect(await store.undo(session.id)).toBeNull();
  });

  it("caps the history depth", async () => {
    store = createSessionStore({ maxHistory: 2 });
    const session = await store.create("doc.hwpx", BYTES_A);
    await store.snapshot(session.id);
    await store.snapshot(session.id);
    await store.snapshot(session.id);
    expect(store.get(session.id).history).toHaveLength(2);
  });

  it("resolvePath confines to the session directory", async () => {
    store = createSessionStore();
    const session = await store.create("doc.hwpx", BYTES_A);
    const ok = store.resolvePath(session.id, "current.hwpx");
    expect(ok.startsWith(session.dir + path.sep)).toBe(true);
    expect(() => store.resolvePath(session.id, "../../etc/passwd")).toThrow(PathTraversalError);
    expect(() => store.resolvePath(session.id, "..")).toThrow(PathTraversalError);
    expect(() => store.resolvePath(session.id, "/etc/passwd")).toThrow(PathTraversalError);
    // A lookalike prefix must not count as inside.
    expect(() => store.resolvePath(session.id, `../${path.basename(session.dir)}-evil/x`)).toThrow(
      PathTraversalError,
    );
  });

  it("rejects unknown and malformed session ids", async () => {
    store = createSessionStore();
    expect(() => store.get("../../tmp")).toThrow(SessionNotFoundError);
    expect(() => store.get(crypto.randomUUID())).toThrow(SessionNotFoundError);
    expect(() => store.resolvePath("not-a-uuid", "x")).toThrow(SessionNotFoundError);
  });

  it("sweep removes sessions past their TTL and deletes their dirs", async () => {
    store = createSessionStore({ ttlMs: 1000 });
    const session = await store.create("doc.hwpx", BYTES_A);
    const removed = await store.sweep(Date.now() + 60_000);
    expect(removed).toBe(1);
    expect(store.size()).toBe(0);
    await expect(readFile(session.currentPath)).rejects.toThrow();
  });

  it("keeps fresh sessions when sweeping", async () => {
    store = createSessionStore({ ttlMs: 60_000 });
    await store.create("doc.hwpx", BYTES_A);
    expect(await store.sweep()).toBe(0);
    expect(store.size()).toBe(1);
  });

  it("honors a caller-provided rootDir", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hwp-editor-test-root-"));
    try {
      store = createSessionStore({ rootDir: root });
      const session = await store.create("doc.hwpx", BYTES_A);
      expect(session.dir.startsWith(root + path.sep)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
