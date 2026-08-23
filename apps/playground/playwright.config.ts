import { defineConfig } from "@playwright/test";

/**
 * Playground e2e — drives the real editor UI against the real hwp binary.
 * HWP_EDITOR_BIN points the API route at the binary (the route also has the
 * hwp-cli debug build as its built-in default).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3100",
  },
  webServer: {
    command: "pnpm dev -p 3100",
    url: "http://localhost:3100/editor",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      HWP_EDITOR_BIN:
        process.env.HWP_EDITOR_BIN ??
        "/Users/yj.lee/workspace/work/dev/hwp-cli/target/debug/hwp",
    },
  },
});
