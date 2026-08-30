import { defineConfig } from "@playwright/test";

/**
 * Playground e2e — drives the real editor UI against the real hwp binary.
 * The API route passes no `bin`, so the binary is whatever the engine's own
 * chain resolves. No env block is needed here: the `pnpm dev` child inherits
 * this process's environment, so an HWP_EDITOR_BIN exported by the caller (or
 * by the CI e2e job) reaches the route unchanged.
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
  },
});
