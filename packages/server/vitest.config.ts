import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Real-binary integration tests spawn hwp-cli; cold renders can be slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
