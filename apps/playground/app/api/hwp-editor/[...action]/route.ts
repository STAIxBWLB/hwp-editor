import { createHwpEditorRoutes } from "@hwp-editor/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = createHwpEditorRoutes({});
