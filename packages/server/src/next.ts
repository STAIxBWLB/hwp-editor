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

export interface HwpEditorRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  /** The underlying framework-agnostic handler, for non-Next runtimes. */
  handler: HwpEditorHandler;
}

/**
 * `opts` is forwarded whole (D-03). This module declares no options interface
 * of its own: a field enumeration here is a place for a `RoutesOptions` field
 * to be silently dropped, so every option the core handler accepts reaches a
 * Next.js host by construction rather than by remembering to add a line.
 */
export function createHwpEditorRoutes(opts: RoutesOptions = {}): HwpEditorRouteHandlers {
  const handler = createHwpEditorHandler(opts);
  return {
    GET: (req: Request) => handler(req),
    POST: (req: Request) => handler(req),
    handler,
  };
}
