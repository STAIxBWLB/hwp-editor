/**
 * Server-internal cache of read-pipeline inspections.
 *
 * A per-process, in-memory map from an opaque session id to the extras a
 * `describe()` produced (fields, bookmarks, slots, info, editability), with an
 * idle TTL swept on growth. It touches the filesystem on no code path and
 * retains no document bytes: the wire contract (protocol.ts) is stateless, so
 * every request already carries the document it operates on, and the cache
 * exists only because opening one document otherwise spawns about seven CLI
 * processes.
 *
 * What this store used to be, and why it is not: it kept the current bytes on
 * disk, a pre-edit snapshot history (up to twenty full document copies per
 * session) and an export handle. Nothing in this repository could read any of
 * it back — no route ever called `undo()` or `exportBytes()`, and protocol.ts
 * has no session or undo surface — so the history was disk amplification with
 * no reader (BUG-07, D-05/D-06). Undo lives in the client store,
 * `packages/core/src/state.ts`, bounded at 50 snapshots, and that is the one
 * undo model.
 *
 * Session ids are UUIDs, never client-supplied paths, and `lookup` still
 * checks the shape before the map: with no filesystem left there is no path to
 * confine, but an id from a client is still an id from a client.
 */

import { randomUUID } from "node:crypto";

import type { DocumentInspection } from "./cli-engine.js";

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown or expired session: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export interface DocumentSession {
  id: string;
  /** Uploaded document file name (basename only); labelling, never a path. */
  name: string;
  createdAt: number;
  touchedAt: number;
  /** Cached read-pipeline extras, when the engine provided them. */
  inspection?: DocumentInspection;
}

export interface SessionStoreOptions {
  /** Idle time after which sweep() removes a session. Default 30min. */
  ttlMs?: number;
}

export interface SessionStore {
  /** Register a session for an uploaded document. Bytes are not retained. */
  create(name: string): DocumentSession;
  get(id: string): DocumentSession;
  has(id: string): boolean;
  attachInspection(id: string, inspection: DocumentInspection): void;
  /** Remove expired sessions; returns how many were removed. */
  sweep(now?: number): number;
  /** Drop every session. */
  dispose(): void;
  size(): number;
  /** All live session ids. */
  ids(): string[];
}

export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sessions = new Map<string, DocumentSession>();

  function lookup(id: string): DocumentSession {
    if (!SESSION_ID_PATTERN.test(id)) throw new SessionNotFoundError(id);
    const session = sessions.get(id);
    if (session === undefined) throw new SessionNotFoundError(id);
    session.touchedAt = Date.now();
    return session;
  }

  function sweepExpired(now = Date.now()): number {
    let removed = 0;
    for (const [id, session] of [...sessions]) {
      if (session.touchedAt + ttlMs < now) {
        sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  return {
    create(name) {
      // Best-effort expiry on growth; no background timer (serverless-safe).
      sweepExpired();
      const id = randomUUID();
      const now = Date.now();
      const session: DocumentSession = {
        id,
        // Basename only: the name rides out in nothing but this record, but a
        // client-supplied string with a path in it should not be kept as one.
        name: name.split(/[/\\]/).pop() || "document.hwpx",
        createdAt: now,
        touchedAt: now,
      };
      sessions.set(id, session);
      return session;
    },

    get(id) {
      return lookup(id);
    },

    has(id) {
      return sessions.has(id);
    },

    attachInspection(id, inspection) {
      lookup(id).inspection = inspection;
    },

    sweep(now = Date.now()) {
      return sweepExpired(now);
    },

    dispose() {
      sessions.clear();
    },

    size() {
      return sessions.size;
    },

    ids() {
      return [...sessions.keys()];
    },
  };
}
