#!/usr/bin/env node
/**
 * PKG-06: prove the published packaging contract by packing this workspace's
 * three tarballs and installing them into scratch consumer apps generated
 * outside the repository.
 *
 * The scratch apps are generated under os.tmpdir() at run time rather than
 * committed, because a directory under the repository root inherits the
 * repository's own node_modules through Node's parent-directory resolution
 * walk. A broken exports map would still resolve there and the test would go
 * green for the wrong reason.
 *
 * Stages run strictly in order: wipe dist, pack, install, runtime import, type
 * check, assert. Any stage that fails stops the script with a non-zero exit.
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

const scratch = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  evidence.push(dir);
  return dir;
};
const write = (dir, name, body) => writeFileSync(join(dir, name), body);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// The scratch apps declare no "type" field on purpose: that is what makes
// probe.ts a CommonJS module, which is what makes the node16 tsc leg exercise
// the require condition instead of vacuously re-proving the import one.
const appManifest = (name) => json({ name, private: true, version: "0.0.0" });

// ===========================================================================
// Stage 1: wipe dist
// ===========================================================================
// This stage used to run `pnpm -r build`. It no longer does, and that is the
// point: a surviving dist/ would let every tarball assertion below pass with
// the `prepack` hook absent, because pack would simply collect the artifacts
// this script had just built for it. Wiping dist first is what makes stages 2
// and 6 a proof of the hook rather than a proof of a build we performed
// ourselves. Packing is now the only thing in this script that builds.
//
// The three packages declare `"prepack": "pnpm run build"` rather than
// `prepublishOnly` or `prepare`. `prepublishOnly` does not run on `pnpm pack`
// or `npm pack`, so it would leave the tarball and git-dependency distribution
// paths this repository actually exercises broken, and no pack-based test
// could observe it. `prepare` runs after every workspace `pnpm install`, which
// turns a plain install into a full build of all three packages. `prepack`
// covers both `pnpm pack` and `pnpm publish` and is the only candidate this
// script can prove. It cannot recurse: `build` is `gen:types && tsup` for core
// and `tsup` for react and server, and neither of those packs.
//
// A local developer's dist/ is collateral of running this script; `pnpm -r
// build` restores it.
for (const pkg of ["core", "react", "server"]) {
  rmSync(join(repoRoot, "packages", pkg, "dist"), { recursive: true, force: true });
}
console.log("[wipe] removed packages/{core,react,server}/dist; only prepack rebuilds them");

// ===========================================================================
// Stage 2: pack
// ===========================================================================
const packDir = scratch("hwped-pack-");
// pnpm 10 reads `--filter` as a recursive selector that `pack` rejects, so each
// package is packed from its own directory instead.
const pack = (pkg) =>
  run("pnpm", ["pack", "--pack-destination", packDir], join(repoRoot, "packages", pkg));
// Pack order is load-bearing now that stage 1 wipes dist. The react and server
// tsup dts builds resolve @hwp-editor/core types through the workspace symlink
// into packages/core/dist/index.d.ts, which exists only once core has been
// packed. Core first, always.
pack("core");
pack("react");
pack("server");

const tarballs = Object.fromEntries(
  readdirSync(packDir)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => [f.replace(/^hwp-editor-/, "").replace(/-\d+\.\d+\.\d+\.tgz$/, ""), join(packDir, f)]),
);
for (const pkg of ["core", "react", "server"]) {
  if (tarballs[pkg] === undefined) {
    throw new Error(`${pkg} tarball not packed; got ${readdirSync(packDir).join(", ")}`);
  }
  console.log(`[pack] packed @hwp-editor/${pkg} -> ${tarballs[pkg]}`);
}

// Asserted here rather than left to stage 6, because without it the first
// symptom of a hook that did not fire is an ERR_MODULE_NOT_FOUND out of
// probe.mjs three stages later, which reads as an exports-map bug.
for (const pkg of ["core", "react", "server"]) {
  const files = capture("tar", ["-tzf", tarballs[pkg]], packDir).split("\n").filter(Boolean);
  if (!files.some((f) => f.startsWith("package/dist/"))) {
    throw new Error(
      `${pkg} tarball carries no package/dist/ entry, so the prepack hook in ` +
        `packages/${pkg}/package.json did not fire (stage 1 wiped dist, and pack ` +
        `is the only thing that rebuilds it); listing: ${files.join(", ")}`,
    );
  }
}
console.log("[pack] every tarball carries package/dist/, so the prepack hook fired");

// ===========================================================================
// Stage 3: install
// ===========================================================================

// The three-package consumer: everything a real host installs at once. A
// single npm invocation is what keeps install order out of the dedupe result.
const appDir = scratch("hwped-consumer-");
write(appDir, "package.json", appManifest("hwped-smoke-consumer"));

// A React component export is a forwardRef object, not a function, so the
// probes assert "usable as a React element type" rather than typeof function.
const USABLE = [
  `const usable = (v) =>`,
  `  typeof v === "function" || (typeof v === "object" && v !== null && "$$typeof" in v);`,
];

const ESM_SUBPATHS = [
  ["@hwp-editor/core", "createHttpEngine"],
  ["@hwp-editor/react", "HwpEditor"],
  ["@hwp-editor/server", "createHwpEditorHandler"],
  ["@hwp-editor/server/next", "createHwpEditorRoutes"],
];

write(
  appDir,
  "probe.mjs",
  [
    ...ESM_SUBPATHS.map(([spec, name]) => `import { ${name} } from "${spec}";`),
    ``,
    ...USABLE,
    ``,
    `const exports_ = {`,
    ...ESM_SUBPATHS.map(([spec, name]) => `  "${spec}": ${name},`),
    `};`,
    `for (const [spec, value] of Object.entries(exports_)) {`,
    `  if (!usable(value)) throw new Error(\`ESM \${spec}: export is \${typeof value}\`);`,
    `  console.log(\`  ESM import ok: \${spec}\`);`,
    `}`,
    ``,
    `// Node has no loader for .css, so importing it throws`,
    `// ERR_UNKNOWN_FILE_EXTENSION before proving anything about the exports`,
    `// map. Assert resolution instead.`,
    `const css = import.meta.resolve("@hwp-editor/react/style.css");`,
    `if (!css.endsWith(".css")) {`,
    `  throw new Error(\`ESM @hwp-editor/react/style.css resolved to \${css}\`);`,
    `}`,
    `console.log("  ESM resolve ok: @hwp-editor/react/style.css");`,
    ``,
  ].join("\n"),
);

write(
  appDir,
  "probe.cjs",
  [
    ...ESM_SUBPATHS.map(([spec, name]) => `const { ${name} } = require("${spec}");`),
    ``,
    ...USABLE,
    ``,
    `const exports_ = {`,
    ...ESM_SUBPATHS.map(([spec, name]) => `  "${spec}": ${name},`),
    `};`,
    `for (const [spec, value] of Object.entries(exports_)) {`,
    `  if (!usable(value)) throw new Error(\`CJS \${spec}: export is \${typeof value}\`);`,
    `  console.log(\`  CJS require ok: \${spec}\`);`,
    `}`,
    ``,
    `// Same reason as the ESM probe: resolvable, not loadable.`,
    `const css = require.resolve("@hwp-editor/react/style.css");`,
    `if (!css.endsWith(".css")) {`,
    `  throw new Error(\`CJS @hwp-editor/react/style.css resolved to \${css}\`);`,
    `}`,
    `console.log("  CJS resolve ok: @hwp-editor/react/style.css");`,
    ``,
  ].join("\n"),
);

// style.css is deliberately absent here: a stylesheet has no types, so the only
// thing a TypeScript leg could assert is a declare-module shim this app wrote
// itself.
write(
  appDir,
  "probe.ts",
  [
    ...ESM_SUBPATHS.map(([spec, name]) => `import { ${name} } from "${spec}";`),
    ``,
    `export const typed = [${ESM_SUBPATHS.map(([, name]) => name).join(", ")}];`,
    ``,
  ].join("\n"),
);

const tsconfig = (moduleKind, moduleResolution) =>
  json({
    compilerOptions: {
      module: moduleKind,
      moduleResolution,
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["ES2022", "DOM"],
    },
    files: ["probe.ts"],
  });
write(appDir, "tsconfig.bundler.json", tsconfig("esnext", "bundler"));
write(appDir, "tsconfig.node16.json", tsconfig("node16", "node16"));
console.log(`[install] generated three-package consumer at ${appDir}`);

run(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    "react@^19",
    "react-dom@^19",
    "@types/react@^19",
    "@types/react-dom@^19",
    tarballs["core"],
    tarballs["react"],
    tarballs["server"],
  ],
  appDir,
);
console.log("[install] installed all three tarballs in one npm invocation");

// The single-package consumer, covering the case where a host wants core on its
// own. It gets its own probe: probe.mjs above imports react and both server
// subpaths, so reusing it here would throw on a package nobody installed and
// the failure would read as a packaging bug.
const coreOnlyDir = scratch("hwped-core-only-");
write(coreOnlyDir, "package.json", appManifest("hwped-smoke-core-only"));
write(
  coreOnlyDir,
  "probe-core-only.mjs",
  [
    `import { createHttpEngine } from "@hwp-editor/core";`,
    ``,
    `if (typeof createHttpEngine !== "function") {`,
    `  throw new Error(\`ESM @hwp-editor/core: createHttpEngine is \${typeof createHttpEngine}\`);`,
    `}`,
    `console.log("  ESM import ok: @hwp-editor/core (core-only app)");`,
    ``,
  ].join("\n"),
);
run("npm", ["install", "--no-audit", "--no-fund", tarballs["core"]], coreOnlyDir);
console.log(`[install] installed the core tarball alone at ${coreOnlyDir}`);

// ===========================================================================
// Stage 4: runtime import
// ===========================================================================
run("node", ["probe.mjs"], appDir);
run("node", ["probe.cjs"], appDir);
run("node", ["probe-core-only.mjs"], coreOnlyDir);
console.log("[runtime] every documented subpath loaded under ESM import and CJS require");

// ===========================================================================
// Stage 5: type check
// ===========================================================================
// Two separate tsconfig files over the same source, both required to exit 0, so
// a pass under bundler can never be mistaken for a pass under node16.
run(TSC, ["-p", "tsconfig.bundler.json"], appDir);
console.log("[typecheck] tsc leg passed: moduleResolution bundler");
run(TSC, ["-p", "tsconfig.node16.json"], appDir);
console.log("[typecheck] tsc leg passed: moduleResolution node16");

// ===========================================================================
// Stage 6: assert
// ===========================================================================
const packedManifest = (tgz) =>
  JSON.parse(capture("tar", ["-xzOf", tgz, "package/package.json"], packDir));
const packedFiles = (tgz) =>
  capture("tar", ["-tzf", tgz], packDir).split("\n").filter(Boolean);

// This is the public 1.0.0 file surface, not just a minimum-presence list.
// Exact listings make a widened `files` allowlist or an unexpected build
// artifact fail before the immutable tarball is published. The server chunk
// hash is intentionally explicit: a changed bundle must be reviewed together
// with the package surface instead of slipping through a prefix check.
const EXPECTED_TARBALL_FILES = {
  core: [
    "package/LICENSE",
    "package/README.md",
    "package/dist/index.cjs",
    "package/dist/index.cjs.map",
    "package/dist/index.d.cts",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/index.js.map",
    "package/package.json",
    "package/schemas/document-spec-v1.schema.json",
    "package/schemas/document-spec-v2.schema.json",
    "package/schemas/template-data-v1.schema.json",
    "package/schemas/template-spec-v1.schema.json",
  ],
  react: [
    "package/LICENSE",
    "package/README.md",
    "package/dist/index.cjs",
    "package/dist/index.cjs.map",
    "package/dist/index.css",
    "package/dist/index.css.map",
    "package/dist/index.d.cts",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/index.js.map",
    "package/package.json",
  ],
  server: [
    "package/LICENSE",
    "package/README.md",
    "package/dist/chunk-YJDXTIO7.js",
    "package/dist/chunk-YJDXTIO7.js.map",
    "package/dist/index.cjs",
    "package/dist/index.cjs.map",
    "package/dist/index.d.cts",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/index.js.map",
    "package/dist/next.cjs",
    "package/dist/next.cjs.map",
    "package/dist/next.d.cts",
    "package/dist/next.d.ts",
    "package/dist/next.js",
    "package/dist/next.js.map",
    "package/package.json",
  ],
};

// Checked before the version assertion so that a core still sitting at 0.0.0
// fails here, naming the range pnpm derived from it, rather than being masked
// by the lockstep check below. A packed range of ^0.0.0 is exactly what a
// PKG-04-after-PKG-03 ordering mistake produces.
for (const pkg of ["react", "server"]) {
  const manifest = packedManifest(tarballs[pkg]);
  const peer = manifest.peerDependencies?.["@hwp-editor/core"];
  const dev = manifest.devDependencies?.["@hwp-editor/core"];
  const dep = manifest.dependencies?.["@hwp-editor/core"];
  if (peer !== "^1.0.0") {
    throw new Error(`packed ${pkg} peerDependencies['@hwp-editor/core'] is ${peer}, want ^1.0.0`);
  }
  if (dev !== "1.0.0") {
    throw new Error(`packed ${pkg} devDependencies['@hwp-editor/core'] is ${dev}, want 1.0.0`);
  }
  if (dep !== undefined) {
    throw new Error(`packed ${pkg} still names @hwp-editor/core in dependencies: ${dep}`);
  }
}
console.log("[assert] react and server declare core as a ^1.0.0 peer, never a dependency");

const versions = {};
for (const pkg of ["core", "react", "server"]) {
  const manifest = packedManifest(tarballs[pkg]);
  if (manifest.version !== "1.0.0") {
    throw new Error(`packed @hwp-editor/${pkg} version is ${manifest.version}, want 1.0.0`);
  }
  versions[pkg] = manifest.version;

  const files = packedFiles(tarballs[pkg]);
  for (const entry of ["package/LICENSE", "package/README.md"]) {
    if (!files.includes(entry)) {
      throw new Error(`${pkg} tarball is missing ${entry}; listing: ${files.join(", ")}`);
    }
  }
  const prefixes = pkg === "core" ? ["package/dist/", "package/schemas/"] : ["package/dist/"];
  for (const prefix of prefixes) {
    if (!files.some((f) => f.startsWith(prefix))) {
      throw new Error(`${pkg} tarball has no entry under ${prefix}; listing: ${files.join(", ")}`);
    }
  }

  const expectedFiles = [...EXPECTED_TARBALL_FILES[pkg]].sort();
  const actualFiles = [...files].sort();
  const added = actualFiles.filter((file) => !expectedFiles.includes(file));
  const removed = expectedFiles.filter((file) => !actualFiles.includes(file));
  if (added.length > 0 || removed.length > 0) {
    throw new Error(
      `${pkg} tarball file surface changed; added: ${added.join(", ") || "(none)"}; ` +
        `removed: ${removed.join(", ") || "(none)"}`,
    );
  }
}
if (new Set(Object.values(versions)).size !== 1) {
  throw new Error(`packed versions are not in lockstep: ${JSON.stringify(versions)}`);
}
console.log("[assert] all three tarballs match the reviewed 1.0.0 file allowlists");

// A file count rather than parsed dependency-listing or peer-warning output,
// whose wording varies by package manager version and would break silently.
const CORE_MANIFEST_SUFFIX = join("@hwp-editor", "core", "package.json");
const countCoreCopies = (dir) => {
  let found = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found += countCoreCopies(path);
    else if (path.endsWith(CORE_MANIFEST_SUFFIX)) found += 1;
  }
  return found;
};
const copies = countCoreCopies(join(appDir, "node_modules"));
if (copies !== 1) {
  throw new Error(`scratch app resolved ${copies} copies of @hwp-editor/core, want exactly 1`);
}
console.log("[assert] exactly one copy of @hwp-editor/core resolved in the scratch app");

// ===========================================================================
rmSync(packDir, { recursive: true, force: true });
rmSync(appDir, { recursive: true, force: true });
rmSync(coreOnlyDir, { recursive: true, force: true });
console.log("\nsmoke-consumer PASSED");
