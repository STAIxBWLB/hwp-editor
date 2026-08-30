#!/usr/bin/env node
/**
 * PKG-06: prove the published packaging contract by packing this workspace's
 * tarballs and installing them into a scratch consumer app generated outside
 * the repository.
 *
 * The scratch app is generated under os.tmpdir() at run time rather than
 * committed, because a directory under the repository root inherits the
 * repository's own node_modules through Node's parent-directory resolution
 * walk. A broken exports map would still resolve there and the test would go
 * green for the wrong reason.
 *
 * Usage: node scripts/smoke-consumer.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(repoRoot, "node_modules", ".bin", "tsc");

// A CI failure that deletes its own evidence cannot be triaged, so the scratch
// directories survive a non-zero exit and their absolute paths are printed.
// There is no try/catch anywhere in this script: any stage that fails throws
// and stops it, and this exit hook reports where to look.
const evidence = [];
process.on("exit", (code) => {
  if (code === 0) return;
  console.error("\nsmoke-consumer FAILED. Evidence left in place:");
  for (const dir of evidence) console.error(`  ${dir}`);
});

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const capture = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();

// --- build ----------------------------------------------------------------
run("pnpm", ["-r", "build"], repoRoot);
console.log("built all workspace packages");

// --- pack -----------------------------------------------------------------
const packDir = mkdtempSync(join(tmpdir(), "hwped-pack-"));
evidence.push(packDir);
// pnpm 10 reads `--filter` as a recursive selector that `pack` rejects, so each
// package is packed from its own directory instead.
const pack = (pkg) => run("pnpm", ["pack", "--pack-destination", packDir], join(repoRoot, "packages", pkg));
pack("core");
const tarballs = Object.fromEntries(
  readdirSync(packDir)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => [f.replace(/-\d+\.\d+\.\d+\.tgz$/, ""), join(packDir, f)]),
);
const coreTgz = tarballs["hwp-editor-core"];
if (coreTgz === undefined) {
  throw new Error(`core tarball not packed; got ${readdirSync(packDir).join(", ")}`);
}
console.log(`packed @hwp-editor/core -> ${coreTgz}`);

// --- tarball assertions ---------------------------------------------------
const packedManifest = (tgz) =>
  JSON.parse(capture("tar", ["-xzOf", tgz, "package/package.json"], packDir));
const packedFiles = (tgz) =>
  capture("tar", ["-tzf", tgz], packDir).split("\n").filter(Boolean);

const coreManifest = packedManifest(coreTgz);
if (coreManifest.version !== "1.0.0") {
  throw new Error(`packed @hwp-editor/core version is ${coreManifest.version}, want 1.0.0`);
}
const coreFiles = packedFiles(coreTgz);
for (const entry of ["package/LICENSE", "package/README.md"]) {
  if (!coreFiles.includes(entry)) {
    throw new Error(`core tarball is missing ${entry}; listing: ${coreFiles.join(", ")}`);
  }
}
for (const prefix of ["package/dist/", "package/schemas/"]) {
  if (!coreFiles.some((f) => f.startsWith(prefix))) {
    throw new Error(
      `core tarball has no entry under ${prefix}; listing: ${coreFiles.join(", ")}`,
    );
  }
}
console.log("core tarball carries LICENSE, README.md, dist/ and schemas/ at 1.0.0");

// --- scratch consumer app -------------------------------------------------
const appDir = mkdtempSync(join(tmpdir(), "hwped-consumer-"));
evidence.push(appDir);
const write = (name, body) => writeFileSync(join(appDir, name), body);

// No "type" field on purpose: that is what makes probe.ts a CommonJS module,
// which is what makes the node16 tsc leg exercise the require condition
// instead of vacuously re-proving the import one.
write(
  "package.json",
  `${JSON.stringify({ name: "hwped-smoke-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
);

write(
  "probe.mjs",
  [
    `import { createHttpEngine } from "@hwp-editor/core";`,
    ``,
    `if (typeof createHttpEngine !== "function") {`,
    `  throw new Error(\`ESM @hwp-editor/core: createHttpEngine is \${typeof createHttpEngine}\`);`,
    `}`,
    `console.log("  ESM import ok: @hwp-editor/core");`,
    ``,
  ].join("\n"),
);

write(
  "probe.cjs",
  [
    `const { createHttpEngine } = require("@hwp-editor/core");`,
    ``,
    `if (typeof createHttpEngine !== "function") {`,
    `  throw new Error(\`CJS @hwp-editor/core: createHttpEngine is \${typeof createHttpEngine}\`);`,
    `}`,
    `console.log("  CJS require ok: @hwp-editor/core");`,
    ``,
  ].join("\n"),
);

write(
  "probe.ts",
  [
    `import { createHttpEngine } from "@hwp-editor/core";`,
    ``,
    `export const engine = createHttpEngine("/api/hwp-editor");`,
    ``,
  ].join("\n"),
);

const tsconfig = (moduleKind, moduleResolution) =>
  `${JSON.stringify(
    {
      compilerOptions: {
        module: moduleKind,
        moduleResolution,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ["ES2022", "DOM"],
      },
      files: ["probe.ts"],
    },
    null,
    2,
  )}\n`;
write("tsconfig.bundler.json", tsconfig("esnext", "bundler"));
write("tsconfig.node16.json", tsconfig("node16", "node16"));
console.log(`generated scratch consumer app at ${appDir}`);

// --- install --------------------------------------------------------------
run("npm", ["install", "--no-audit", "--no-fund", coreTgz], appDir);
console.log("installed the core tarball into the scratch app");

// --- runtime probes -------------------------------------------------------
run("node", ["probe.mjs"], appDir);
run("node", ["probe.cjs"], appDir);
console.log("runtime probes passed under both ESM import and CJS require");

// --- type resolution probes ----------------------------------------------
// Two separate tsconfig files over the same source, both required to exit 0,
// so a pass under bundler can never be mistaken for a pass under node16.
run(TSC, ["-p", "tsconfig.bundler.json"], appDir);
console.log("tsc leg passed: moduleResolution bundler");
run(TSC, ["-p", "tsconfig.node16.json"], appDir);
console.log("tsc leg passed: moduleResolution node16");

// --- cleanup --------------------------------------------------------------
rmSync(packDir, { recursive: true, force: true });
rmSync(appDir, { recursive: true, force: true });
console.log("\nsmoke-consumer PASSED");
