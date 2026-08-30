#!/usr/bin/env node
/**
 * REL-01: prove that an outside developer who installs `@hwp-editor/react` from
 * the public registry gets `@hwp-editor/core` as a single deduped peer, at the
 * expected version, declaring the expected range.
 *
 * This is `scripts/smoke-consumer.mjs` with the install source swapped from
 * local tarballs to the registry, and it deliberately differs from it in exactly
 * one way: it must NOT name core on the install line. Installing the react
 * tarball alone was measured to make npm reach for core on its own and fail with
 * a 404 while core was unpublished [06-RESEARCH.md §5]:
 *
 *   npm warn Could not resolve dependency:
 *   npm warn peer @hwp-editor/core@"^1.0.0" from @hwp-editor/react@1.0.0
 *   npm error 404  The requested resource '@hwp-editor/core@^1.0.0' could not be found
 *
 * Only an install that omits core proves the peer arrives by itself.
 * `smoke-consumer.mjs` names core explicitly on purpose (Phase 5 D-13, which
 * proved dedupe under workspace resolution); the two scripts are not duplicates,
 * and neither one's install line should be edited to match the other's.
 *
 * The install specifiers are always exact versions, never a range and never a
 * dist-tag, so a registry that has not finished replicating cannot be papered
 * over by resolving something else.
 *
 * Stages run strictly in order: generate, install, runtime import, type check,
 * assert. There is no try/catch anywhere: any stage that fails throws and stops
 * the script, and the exit hook prints where the evidence was left.
 *
 * Usage: node scripts/smoke-registry.mjs [version] [dist-tag]
 *        node scripts/smoke-registry.mjs 1.0.0-rc.0 next
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(repoRoot, "node_modules", ".bin", "tsc");

/** Prefix of every scratch directory this script creates, exported so a test can
 * assert that merely importing the module creates none of them. */
export const SCRATCH_PREFIX = "hwped-registry-";

// ===========================================================================
// Pure assertions, exported so they can be tested without a registry
// ===========================================================================

/** The core peer range a react or server manifest published at `version` carries. */
export const expectedPeerRange = (version) => `^${version}`;

const CORE_MANIFEST_SUFFIX = join("@hwp-editor", "core", "package.json");

/**
 * A file count rather than parsed dependency-listing or peer-warning output,
 * whose wording varies by package manager version and would break silently.
 */
export const countCoreCopies = (dir) => {
  let found = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found += countCoreCopies(path);
    else if (path.endsWith(CORE_MANIFEST_SUFFIX)) found += 1;
  }
  return found;
};

/**
 * Assert that an installed manifest declares the core peer range this version is
 * expected to carry.
 *
 * D-03: the RC structurally cannot exercise the range `1.0.0` ships. A
 * prerelease does not satisfy a caret range over its own release - `1.0.0-rc.0`
 * does NOT satisfy `^1.0.0` - so the only range the RC ever proves is
 * `^1.0.0-rc.0`. That is why this assertion runs a second time against the
 * published `1.0.0` rather than being treated as a duplicate of the Phase 5
 * dedupe check.
 */
export const assertResolvedPeer = (packageName, declaredRange, expectedRange) => {
  if (declaredRange !== expectedRange) {
    throw new Error(
      `installed ${packageName} declares core peer ${declaredRange}, want ${expectedRange}`,
    );
  }
};

// ===========================================================================
// Stages, behind an entry-module guard
// ===========================================================================
// The guard exists so packages/server/test/release-guards.test.ts can import the
// assertions above without spawning npm at a registry.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version =
    process.argv[2] ??
    JSON.parse(readFileSync(join(repoRoot, "packages", "core", "package.json"), "utf8")).version;
  const distTag = process.argv[3] ?? "(none)";

  // A CI failure that deletes its own evidence cannot be triaged, so the scratch
  // directories survive a non-zero exit and their absolute paths are printed.
  const evidence = [];
  process.on("exit", (code) => {
    if (code === 0) return;
    console.error("\nsmoke-registry FAILED. Evidence left in place:");
    for (const dir of evidence) console.error(`  ${dir}`);
  });

  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
  const scratch = (suffix) => {
    const dir = mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}${suffix}`));
    evidence.push(dir);
    return dir;
  };
  const write = (dir, name, body) => writeFileSync(join(dir, name), body);
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

  // =========================================================================
  // Stage 1: generate the scratch consumer
  // =========================================================================
  // Generated under os.tmpdir() rather than committed, because a directory under
  // the repository root inherits the repository's own node_modules through
  // Node's parent-directory resolution walk, and a broken exports map would
  // still resolve there.
  const appDir = scratch("consumer-");

  // No "type" field on purpose: that is what makes probe.ts a CommonJS module,
  // which is what makes the node16 tsc leg exercise the require condition
  // instead of vacuously re-proving the import one.
  write(appDir, "package.json", json({ name: "hwped-smoke-registry", private: true, version: "0.0.0" }));

  // A React component export is a forwardRef object, not a function, so the
  // probes assert "usable as a React element type" rather than typeof function.
  const USABLE = [
    `const usable = (v) =>`,
    `  typeof v === "function" || (typeof v === "object" && v !== null && "$$typeof" in v);`,
  ];

  // Core is imported here even though it is never installed by name: that is the
  // point. A peer npm pulled in on its own must be usable, not merely present.
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

  // style.css is deliberately absent here: a stylesheet has no types, so the
  // only thing a TypeScript leg could assert is a declare-module shim this app
  // wrote itself.
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
  console.log(`[generate] scratch consumer at ${appDir} (version ${version}, dist-tag ${distTag})`);

  // =========================================================================
  // Stage 2: install from the registry
  // =========================================================================
  // Core is absent from this list ON PURPOSE and must stay absent: an install
  // that names it proves nothing about whether npm pulls the peer in by itself,
  // which is the whole claim of REL-01. See this file's header.
  //
  // A cache directory created for this run keeps a cached negative packument
  // from making a freshly published version look missing (06-RESEARCH.md §6:
  // packuments are cacheable for 300 s, tarballs are immutable).
  const cacheDir = scratch("cache-");
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--cache",
      cacheDir,
      "react@^19",
      "react-dom@^19",
      "@types/react@^19",
      "@types/react-dom@^19",
      `@hwp-editor/react@${version}`,
      `@hwp-editor/server@${version}`,
    ],
    appDir,
  );
  console.log(`[install] installed react and server at ${version} from the registry`);

  // =========================================================================
  // Stage 3: runtime import
  // =========================================================================
  run("node", ["probe.mjs"], appDir);
  run("node", ["probe.cjs"], appDir);
  console.log("[runtime] every documented subpath loaded under ESM import and CJS require");

  // =========================================================================
  // Stage 4: type check
  // =========================================================================
  // Two separate tsconfig files over the same source, both required to exit 0,
  // so a pass under bundler can never be mistaken for a pass under node16.
  run(TSC, ["-p", "tsconfig.bundler.json"], appDir);
  console.log("[typecheck] tsc leg passed: moduleResolution bundler");
  run(TSC, ["-p", "tsconfig.node16.json"], appDir);
  console.log("[typecheck] tsc leg passed: moduleResolution node16");

  // =========================================================================
  // Stage 5: assert
  // =========================================================================
  const nodeModules = join(appDir, "node_modules");
  const installedManifest = (pkg) =>
    JSON.parse(readFileSync(join(nodeModules, "@hwp-editor", pkg, "package.json"), "utf8"));

  const core = installedManifest("core");
  if (core.version !== version) {
    throw new Error(`installed @hwp-editor/core is ${core.version}, want ${version}`);
  }
  console.log(`[assert] the peer npm resolved on its own is core ${core.version}`);

  const expectedRange = expectedPeerRange(version);
  for (const pkg of ["react", "server"]) {
    const manifest = installedManifest(pkg);
    const name = `@hwp-editor/${pkg}`;
    assertResolvedPeer(name, manifest.peerDependencies?.["@hwp-editor/core"], expectedRange);
    const dep = manifest.dependencies?.["@hwp-editor/core"];
    if (dep !== undefined) {
      throw new Error(`installed ${name} names @hwp-editor/core in dependencies: ${dep}`);
    }
    if (manifest.peerDependenciesMeta?.["@hwp-editor/core"]?.optional === true) {
      throw new Error(`installed ${name} marks the core peer optional`);
    }
  }
  console.log(`[assert] react and server declare core as a ${expectedRange} peer, never a dependency`);

  const copies = countCoreCopies(nodeModules);
  if (copies !== 1) {
    throw new Error(`scratch app resolved ${copies} copies of @hwp-editor/core, want exactly 1`);
  }
  console.log("[assert] exactly one copy of @hwp-editor/core resolved in the scratch app");

  // =======================================================================
  rmSync(appDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  console.log("\nsmoke-registry PASSED");
}
