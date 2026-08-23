/**
 * Server-side document sessions.
 *
 * The wire contract (protocol.ts) is stateless — every request carries the
 * document — so sessions are server-internal infrastructure: they give the
 * server a confined place to keep the current bytes, a pre-edit snapshot
 * history for undo, and an export handle, without trusting any client path.
 *
 * Confinement rules: the store root is a private mkdtemp directory, session
 * ids are UUIDs (never client-supplied paths), and resolvePath verifies the
 * resolved path stays under the session directory before any use.
 */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DocumentHandle } from "@hwp-editor/core";
import type { DocumentInspection } from "./cli-engine.js";

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_HISTORY = 20;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PathTraversalError extends Error {
  constructor(rel: string) {
    super(`path escapes the session directory: ${rel}`);
    this.name = "PathTraversalError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown or expired session: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export interface DocumentSession {
  id: string;
  /** Current document file name (basename only). */
  name: string;
  /** Absolute session directory, under the store root. */
  dir: string;
  /** Absolute path of the current document file. */
  currentPath: string;
  /** Snapshot file paths, oldest first. */
  history: string[];
  createdAt: number;
  touchedAt: number;
  /** Cached read-pipeline extras, when the engine provided them. */
  inspection?: DocumentInspection;
}

export interface SessionStoreOptions {
  /** Defaults to a fresh mkdtemp under os.tmpdir(). */
  rootDir?: string;
  /** Idle time after which sweep() removes a session. Default 30min. */
  ttlMs?: number;
  /** Maximum retained snapshots per session. Default 20. */
  maxHistory?: number;
}

export interface SessionStore {
  readonly rootDir: string;
  create(name: string, data: Uint8Array): Promise<DocumentSession>;
  get(id: string): DocumentSession;
  has(id: string): boolean;
  /** Replace the current document bytes (e.g. after an edit). */
  put(id: string, name: string, data: Uint8Array): Promise<DocumentSession>;
  /** Copy the current document onto the history stack. */
  snapshot(id: string): Promise<string>;
  /** Restore the newest snapshot over the current document; null when empty. */
  undo(id: string): Promise<DocumentHandle | null>;
  /** Current document bytes, for download/export. */
  exportBytes(id: string): Promise<DocumentHandle>;
  attachInspection(id: string, inspection: DocumentInspection): void;
  /**
   * Resolve `rel` inside the session directory, rejecting anything that
   * escapes it (path traversal guard). Throws PathTraversalError.
   */
  resolvePath(id: string, rel: string): string;
  /** Remove expired sessions; returns how many were removed. */
  sweep(now?: number): Promise<number>;
  /** Remove the whole store root. */
  dispose(): Promise<void>;
  size(): number;
  /** All live session ids. */
  ids(): string[];
}

function extensionOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === ".hwp" || ext === ".hwpx" ? ext : ".hwpx";
}

export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  const sessions = new Map<string, DocumentSession>();

  // Lazily created so constructing the store (e.g. at module scope of a
  // route handler) never touches the filesystem.
  let rootPromise: Promise<string> | null = null;
  let rootSnapshot = opts.rootDir ?? "";
  function ensureRoot(): Promise<string> {
    rootPromise ??= opts.rootDir !== undefined
      ? mkdir(opts.rootDir, { recursive: true }).then(() => opts.rootDir as string)
      : mkdtemp(path.join(tmpdir(), "hwp-editor-sessions-"));
    return rootPromise.then((root) => {
      rootSnapshot = root;
      return root;
    });
  }

  function lookup(id: string): DocumentSession {
    if (!SESSION_ID_PATTERN.test(id)) throw new SessionNotFoundError(id);
    const session = sessions.get(id);
    if (session === undefined) throw new SessionNotFoundError(id);
    session.touchedAt = Date.now();
    return session;
  }

  async function writeCurrent(session: DocumentSession, name: string, data: Uint8Array) {
    const fileName = `current${extensionOf(name)}`;
    const filePath = path.join(session.dir, fileName);
    await writeFile(filePath, data, { mode: 0o600 });
    session.name = path.basename(name) || fileName;
    session.currentPath = filePath;
  }

  async function sweepExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [id, session] of [...sessions]) {
      if (session.touchedAt + ttlMs < now) {
        sessions.delete(id);
        await rm(session.dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  return {
    get rootDir() {
      return rootSnapshot;
    },

    async create(name, data) {
      const root = await ensureRoot();
      // Best-effort expiry on growth; no background timer (serverless-safe).
      await sweepExpired();
      const id = randomUUID();
      const dir = path.join(root, id);
      await mkdir(path.join(dir, "history"), { recursive: true });
      const now = Date.now();
      const session: DocumentSession = {
        id,
        name: path.basename(name) || "document.hwpx",
        dir,
        currentPath: path.join(dir, `current${extensionOf(name)}`),
        history: [],
        createdAt: now,
        touchedAt: now,
      };
      sessions.set(id, session);
      await writeCurrent(session, name, data);
      return session;
    },

    get(id) {
      return lookup(id);
    },

    has(id) {
      return sessions.has(id);
    },

    async put(id, name, data) {
      const session = lookup(id);
      await writeCurrent(session, name, data);
      return session;
    },

    async snapshot(id) {
      const session = lookup(id);
      const seq = session.history.length;
      const snapPath = path.join(session.dir, "history", `snap-${seq}${extensionOf(session.name)}`);
      await copyFile(session.currentPath, snapPath);
      session.history.push(snapPath);
      while (session.history.length > maxHistory) {
        const oldest = session.history.shift();
        if (oldest !== undefined) await rm(oldest, { force: true });
      }
      return snapPath;
    },

    async undo(id) {
      const session = lookup(id);
      const snapPath = session.history.pop();
      if (snapPath === undefined) return null;
      await copyFile(snapPath, session.currentPath);
      await rm(snapPath, { force: true });
      const data = new Uint8Array(await readFile(session.currentPath));
      return { name: session.name, data };
    },

    async exportBytes(id) {
      const session = lookup(id);
      const data = new Uint8Array(await readFile(session.currentPath));
      return { name: session.name, data };
    },

    attachInspection(id, inspection) {
      lookup(id).inspection = inspection;
    },

    resolvePath(id, rel) {
      const session = lookup(id);
      const resolved = path.resolve(session.dir, rel);
      if (resolved !== session.dir && !resolved.startsWith(session.dir + path.sep)) {
        throw new PathTraversalError(rel);
      }
      return resolved;
    },

    async sweep(now = Date.now()) {
      return sweepExpired(now);
    },

    async dispose() {
      sessions.clear();
      if (rootPromise !== null) {
        await rm(await rootPromise, { recursive: true, force: true });
      }
    },

    size() {
      return sessions.size;
    },

    ids() {
      return [...sessions.keys()];
    },
  };
}

/** Re-export so route tests can list session dirs without reaching into fs. */
export async function listSessionFiles(session: DocumentSession): Promise<string[]> {
  return readdir(session.dir);
}
