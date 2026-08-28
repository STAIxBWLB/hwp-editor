import { createHwpEditorRoutes } from "@hwp-editor/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Local dev default: the hwp-cli 0.8.8 debug build (PATH carries 0.8.6,
// which is too old). Override with HWP_EDITOR_BIN in .env.local / the shell.
const DEFAULT_BIN = "/Users/yj.lee/workspace/work/dev/hwp-cli/target/debug/hwp";

export const { GET, POST } = createHwpEditorRoutes({
  bin: process.env.HWP_EDITOR_BIN ?? DEFAULT_BIN,
});
