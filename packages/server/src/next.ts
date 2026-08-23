/**
 * Next.js App Router adapter. Next 16 route handlers speak Web
 * Request/Response, so this is a thin wrapper over routes.ts:
 *
 *   // app/api/hwp-editor/[...action]/route.ts
 *   import { createHwpEditorRoutes } from "@hwp-editor/server/next";
 *   export const runtime = "nodejs";
 *   export const { GET, POST } = createHwpEditorRoutes();
 */

import { createHwpEditorHandler, type HwpEditorHandler, type RoutesOptions } from "./routes.js";
import type { SessionStore } from "./session.js";

export interface HwpEditorRouteOptions {
  /** Explicit hwp binary path; falls back to HWP_EDITOR_BIN / HWP_CLI / PATH. */
  bin?: string;
  /**
   * Per-invocation CLI timeout in ms (defaults to the engine's 60s). Hosts
   * with a hard request budget should set this a few seconds below it.
   */
  timeoutMs?: number;
  /** Custom engine (defaults to CliEngine). */
  engine?: RoutesOptions["engine"];
  /** Custom session store, or false to disable server-side sessions. */
  sessions?: SessionStore | false;
}

export interface HwpEditorRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  /** The underlying framework-agnostic handler, for non-Next runtimes. */
  handler: HwpEditorHandler;
}

export function createHwpEditorRoutes(opts: HwpEditorRouteOptions = {}): HwpEditorRouteHandlers {
  const handler = createHwpEditorHandler({
    ...(opts.bin !== undefined ? { bin: opts.bin } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.engine !== undefined ? { engine: opts.engine } : {}),
    ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}),
  });
  return {
    GET: (req: Request) => handler(req),
    POST: (req: Request) => handler(req),
    handler,
  };
}
