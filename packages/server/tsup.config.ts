import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/next.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "esnext",
});
