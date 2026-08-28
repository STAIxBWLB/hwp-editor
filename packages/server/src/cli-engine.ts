/**
 * CliEngine — HwpEngine implementation that shells out to the hwp-cli binary.
 *
 * Hardening ported from the ax deployment wrapper (sites/ax/lib/hwp-cli.ts):
 * execFile only (never a shell), a 60s timeout and 32MB maxBuffer on every
 * invocation, a scrubbed child environment, and per-call temp directories
 * that are removed on every path including failure. Generalizations: the
 * binary is resolved by option/env/PATH instead of a bundled artifact (this
 * package runs on developer machines and servers, not one fixed lambda), and
 * the per-process verification is a minimum-version check instead of a
 * pinned checksum (there is no single reviewed artifact here).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  opsToArgv,
  parseCatEnvelope,
  type Capabilities,
  type CatEnvelope,
  type ComposeResult,
  type DocumentHandle,
  type DocumentSpecV2,
  type EditOp,
  type EditOptions,
  type HwpEngine,
  type HwpErrorCode,
  type PageImage,
  type PageImageFormat,
  type RenderOptions,
  type ValidationError,
  type ValidationReport,
} from "@hwp-editor/core";

export const HWP_TIMEOUT_MS = 60_000;
const HWP_MAX_BUFFER = 32 * 1024 * 1024;
const MIN_VERSION: readonly [number, number, number] = [0, 8, 7];

/** Hancom binary .hwp is a CFBF (OLE2) container; .hwpx is a zip. */
const CFBF_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * The engine half of the published `HwpErrorCode` vocabulary. Derived with
 * `Extract<>` rather than aliased to the full union on purpose: an alias
 * would make `statusFor`'s switch (routes.ts) non-exhaustive by five at
 * once, and the natural fix for that is a `default:` clause, which
 * permanently destroys the exhaustiveness check that must catch the next
 * code addition.
 */
export type HwpCliErrorReason = Extract<
  HwpErrorCode,
  | "unavailable"
  | "version"
  | "timeout"
  | "failed"
  | "bad_request"
  | "unsupported_format"
  | "protected"
>;

export class HwpCliError extends Error {
  constructor(
    public readonly reason: HwpCliErrorReason,
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "HwpCliError";
  }
}

export interface CliEngineOptions {
  /**
   * Explicit path to the hwp binary. Resolution order: this option ->
   * HWP_EDITOR_BIN env -> HWP_CLI env -> `hwp` on PATH.
   */
  bin?: string;
  /**
   * Per-invocation timeout in ms, default HWP_TIMEOUT_MS. Hosts with a hard
   * request budget (e.g. a 60s serverless function) should set this a few
   * seconds below it so the engine's 504 beats the platform's kill.
   */
  timeoutMs?: number;
}

/** Everything `read` gathers beyond the pinned CatEnvelope wire shape. */
export interface DocumentInspection {
  envelope: CatEnvelope;
  /** Raw `hwp fields --json` payload (array), null on failure. */
  fields: unknown;
  /** Raw `hwp bookmarks --json` payload (array), null on failure. */
  bookmarks: unknown;
  /** Raw `hwp slots --json` payload (object), null on failure. */
  slots: unknown;
  /** Raw `hwp info --json` payload, null on failure. */
  info: unknown;
  /** Per-document editability derived from `info` (see below). */
  capabilities: { editable: boolean; reason?: string };
}

export interface CliEngine extends HwpEngine {
  /**
   * Full read pipeline: cat --with-segments plus fields/bookmarks/slots/info.
   * `read()` is this with the extras dropped, per the pinned wire contract.
   */
  describe(document: DocumentHandle): Promise<DocumentInspection>;
  /**
   * Return the pre-edit snapshot of a document this engine edited, or null.
   * Keyed by the edited document's content hash; consumed on use.
   */
  undo(document: DocumentHandle): DocumentHandle | null;
  /** Resolved binary path and verified version. */
  binaryInfo(): Promise<{ bin: string; version: string }>;
}

function scrubbedEnv(): Record<string, string> {
  // An inherited env is the usual way a subprocess reaches credentials it has
  // no business with. The CLI needs PATH (for helpers) and little else;
  // HWP_* is the CLI's own configuration surface (HWP_LANG, HWP_FONT_DIR...).
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.LANG ??= "C.UTF-8";
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HWP_") && value !== undefined) env[key] = value;
  }
  return env;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(bin: string, args: string[], timeoutMs: number = HWP_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: HWP_MAX_BUFFER,
        env: scrubbedEnv(),
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const killed = (error as { killed?: boolean }).killed === true;
        const signal = (error as { signal?: string | null }).signal;
        if (killed || signal === "SIGTERM") {
          reject(new HwpCliError("timeout", `hwp ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
          return;
        }
        if ((error as { code?: unknown }).code === "ENOENT") {
          reject(new HwpCliError(
            "unavailable",
            `hwp binary not found: ${bin} (install hwp-cli >= 0.8.7, or set HWP_EDITOR_BIN / the bin option)`,
          ));
          return;
        }
        const code = typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code: number }).code)
          : 1;
        // Non-zero exit still carries stdout/stderr; let callers that expect
        // failure output (validate) inspect it instead of always throwing.
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** Run a command that must succeed; throw a rich error otherwise. */
async function runCliOk(bin: string, args: string[], timeoutMs?: number): Promise<RunResult> {
  const result = await runCli(bin, args, timeoutMs);
  if (result.code !== 0) {
    throw new HwpCliError(
      "failed",
      `hwp ${args[0] ?? ""} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      result.stderr,
    );
  }
  return result;
}

function parseVersion(stdout: string): [number, number, number] | null {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(v: [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! > min[i]!) return true;
    if (v[i]! < min[i]!) return false;
  }
  return true;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sniffExtension(document: DocumentHandle): ".hwp" | ".hwpx" {
  const ext = path.extname(document.name).toLowerCase();
  if (ext === ".hwp" || ext === ".hwpx") return ext;
  const isCfbf =
    document.data.length >= CFBF_SIGNATURE.length &&
    CFBF_SIGNATURE.every((byte, i) => document.data[i] === byte);
  return isCfbf ? ".hwp" : ".hwpx";
}

/** Basename + validated extension, so a hostile name can never escape tmp. */
function safeOutputName(name: string, fallbackExt: ".hwp" | ".hwpx"): string {
  const base = path.basename(name).replace(/[^\w.가-힣-]/g, "_") || `document${fallbackExt}`;
  const ext = path.extname(base).toLowerCase();
  if (ext === ".hwp" || ext === ".hwpx") return base;
  return `${base}${fallbackExt}`;
}

async function tryJson(bin: string, args: string[], timeoutMs?: number): Promise<unknown> {
  try {
    const result = await runCliOk(bin, args, timeoutMs);
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

/** Distribution/encrypted documents: 0.8.7 can read them but refuses edit/fill. */
function documentEditability(info: unknown): { editable: boolean; reason?: string } {
  if (typeof info !== "object" || info === null) return { editable: true };
  const record = info as Record<string, unknown>;
  if (record["encrypted"] === true) {
    return { editable: false, reason: "encrypted document; hwp-cli refuses edit/fill" };
  }
  if (record["distribution"] === true) {
    return {
      editable: false,
      reason: "distribution (배포용) document; hwp-cli 0.8.7 refuses edit/fill",
    };
  }
  return { editable: true };
}

function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function svgSize(source: string): { width: number; height: number } | null {
  const tag = source.match(/<svg\b[^>]*>/i);
  if (tag === null) return null;
  const width = tag[0].match(/\bwidth="([\d.]+)(?:pt|px)?"/i);
  const height = tag[0].match(/\bheight="([\d.]+)(?:pt|px)?"/i);
  if (width === null || height === null) return null;
  return { width: Number(width[1]), height: Number(height[1]) };
}

function parseSinglePage(pages: string | undefined): number | null {
  if (pages !== undefined && /^\d+$/.test(pages)) return Number(pages);
  return null;
}

export function createCliEngine(opts: CliEngineOptions = {}): CliEngine {
  const timeoutMs = opts.timeoutMs ?? HWP_TIMEOUT_MS;

  function resolveBin(): string {
    const fromOpts = opts.bin?.trim();
    if (fromOpts) return fromOpts;
    const fromEditorEnv = process.env.HWP_EDITOR_BIN?.trim();
    if (fromEditorEnv) return fromEditorEnv;
    const fromCliEnv = process.env.HWP_CLI?.trim();
    if (fromCliEnv) return fromCliEnv;
    return "hwp";
  }

  // One version verification per resolved binary per process.
  let verifiedVersion: Promise<string> | null = null;
  function ensureVersion(): Promise<string> {
    verifiedVersion ??= (async () => {
      const bin = resolveBin();
      let result: RunResult;
      try {
        result = await runCli(bin, ["--version"], timeoutMs);
      } catch (error) {
        if (error instanceof HwpCliError) throw error;
        throw new HwpCliError(
          "unavailable",
          `hwp binary is not executable: ${bin} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (result.code !== 0) {
        throw new HwpCliError("unavailable", `hwp --version failed for ${bin}: ${result.stderr.trim()}`);
      }
      const version = parseVersion(result.stdout);
      if (version === null) {
        throw new HwpCliError("version", `cannot parse hwp --version output: ${result.stdout.trim()}`);
      }
      if (!versionAtLeast(version, MIN_VERSION)) {
        throw new HwpCliError(
          "version",
          `hwp ${version.join(".")} is too old; >= ${MIN_VERSION.join(".")} required (${bin})`,
        );
      }
      return version.join(".");
    })();
    return verifiedVersion;
  }

  /** Per-call private workspace; removed on every path including failure. */
  async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "hwp-editor-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function stage(dir: string, document: DocumentHandle): Promise<string> {
    const file = path.join(dir, `in${sniffExtension(document)}`);
    await writeFile(file, document.data, { mode: 0o600 });
    return file;
  }

  const inspections = new Map<string, DocumentInspection>();
  const snapshots = new Map<string, DocumentHandle>();

  async function describe(document: DocumentHandle): Promise<DocumentInspection> {
    await ensureVersion();
    const bin = resolveBin();
    const hash = sha256(document.data);
    const cached = inspections.get(hash);
    if (cached !== undefined) return cached;
    const inspection = await withWorkDir(async (dir) => {
      const file = await stage(dir, document);
      const cat = await runCliOk(bin, ["cat", file, "--format", "markdown", "--with-segments"], timeoutMs);
      const envelope = parseCatEnvelope(cat.stdout);
      // Best-effort extras: a document that cats fine but fails fields should
      // still read; the extras inform editing UI, not the wire contract.
      const [fields, bookmarks, slots, info] = await Promise.all([
        tryJson(bin, ["fields", file, "--json"], timeoutMs),
        tryJson(bin, ["bookmarks", file, "--json"], timeoutMs),
        tryJson(bin, ["slots", file, "--json"], timeoutMs),
        tryJson(bin, ["info", file, "--json"], timeoutMs),
      ]);
      return {
        envelope,
        fields,
        bookmarks,
        slots,
        info,
        capabilities: documentEditability(info),
      } satisfies DocumentInspection;
    });
    if (inspections.size >= 64) {
      const oldest = inspections.keys().next().value;
      if (oldest !== undefined) inspections.delete(oldest);
    }
    inspections.set(hash, inspection);
    return inspection;
  }

  const engine: CliEngine = {
    async read(document) {
      return (await describe(document)).envelope;
    },

    describe,

    async render(document, options = {}) {
      await ensureVersion();
      const bin = resolveBin();
      const requested = options.format ?? "svg";
      if (requested === "jpeg" || requested === "webp") {
        throw new HwpCliError(
          "unsupported_format",
          `hwp-cli render supports png and svg only; got "${requested}"`,
        );
      }
      const dpi = options.dpi ?? 96;
      if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600) {
        throw new HwpCliError("bad_request", `dpi must be within 36..=600; got ${options.dpi}`);
      }
      const pages = options.pages ?? "all";
      if (pages !== "all" && !/^\d+(-\d+)?$/.test(pages)) {
        throw new HwpCliError("bad_request", `invalid page range: ${pages}`);
      }
      return withWorkDir(async (dir) => {
        const input = await stage(dir, document);
        const attempt = async (format: "svg" | "png"): Promise<PageImage[]> => {
          const outBase = path.join(dir, `page.${format}`);
          const reportPath = path.join(dir, "render-report.json");
          await runCliOk(bin, [
            "render", input, "-o", outBase,
            "--format", format, "--pages", pages, "--dpi", String(dpi),
            "--report", reportPath,
          ], timeoutMs);
          // Multi-page renders land as page-<n>.<ext>; a single selected page
          // keeps the exact -o name. The report's selected_pages pins numbers.
          const filePattern = new RegExp(`^page-(\\d+)\\.${format}$`);
          const files = (await readdir(dir))
            .filter((f) => f === `page.${format}` || filePattern.test(f))
            .sort((a, b) => {
              const na = Number(filePattern.exec(a)?.[1] ?? 0);
              const nb = Number(filePattern.exec(b)?.[1] ?? 0);
              return na - nb;
            });
          let selected: number[] | null = null;
          try {
            const report = JSON.parse(await readFile(reportPath, "utf8")) as {
              selected_pages?: unknown;
            };
            if (Array.isArray(report.selected_pages)) {
              selected = report.selected_pages.filter((n): n is number => typeof n === "number");
            }
          } catch {
            selected = null;
          }
          const images: PageImage[] = [];
          for (let i = 0; i < files.length; i++) {
            const file = files[i]!;
            const data = new Uint8Array(await readFile(path.join(dir, file)));
            const suffix = file.match(/^page-(\d+)\./);
            const page =
              suffix !== null
                ? Number(suffix[1])
                : (selected?.[i] ?? parseSinglePage(options.pages) ?? i + 1);
            const size =
              format === "png"
                ? pngSize(data)
                : svgSize(Buffer.from(data).toString("utf8"));
            images.push({
              page,
              width: size?.width ?? 0,
              height: size?.height ?? 0,
              dpi,
              format,
              data,
            });
          }
          return images;
        };
        try {
          return await attempt(requested);
        } catch (error) {
          // SVG is the default; fall back to PNG when the renderer refuses.
          if (requested === "svg" && error instanceof HwpCliError && error.reason === "failed") {
            return attempt("png");
          }
          throw error;
        }
      });
    },

    async edit(document, ops: EditOp[], options: EditOptions = {}) {
      await ensureVersion();
      const bin = resolveBin();
      if (!Array.isArray(ops)) {
        throw new HwpCliError("bad_request", "ops must be an array of edit operations");
      }
      const ext = sniffExtension(document);
      const edited = await withWorkDir(async (dir) => {
        const input = await stage(dir, document);
        const output = path.join(dir, `out${ext}`);
        const args = ["edit", input, "-o", output, ...opsToArgv(ops)];
        if (options.verify !== false) args.push("--verify");
        if (options.allowPartial === true) args.push("--allow-partial");
        await runCliOk(bin, args, timeoutMs);
        return new Uint8Array(await readFile(output));
      });
      // Pre-edit snapshot keyed by the edited hash: undo(edited) -> original.
      snapshots.set(sha256(edited), { name: document.name, data: document.data });
      if (snapshots.size > 256) {
        const oldest = snapshots.keys().next().value;
        if (oldest !== undefined) snapshots.delete(oldest);
      }
      return { name: document.name, data: edited };
    },

    undo(document) {
      const key = sha256(document.data);
      const snapshot = snapshots.get(key) ?? null;
      if (snapshot !== null) snapshots.delete(key);
      return snapshot;
    },

    async compose(spec: DocumentSpecV2, name: string) {
      await ensureVersion();
      const bin = resolveBin();
      const outName = safeOutputName(name, ".hwpx");
      return withWorkDir(async (dir) => {
        const specPath = path.join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
        const outPath = path.join(dir, outName);
        const result = await runCliOk(bin, ["compose", specPath, "-o", outPath, "--report"], timeoutMs);
        let report: unknown;
        try {
          report = JSON.parse(result.stdout) as unknown;
        } catch {
          report = undefined;
        }
        const data = new Uint8Array(await readFile(outPath));
        const composeResult: ComposeResult = { document: { name: outName, data } };
        if (report !== undefined) composeResult.report = report;
        return composeResult;
      });
    },

    async validate(document) {
      await ensureVersion();
      const bin = resolveBin();
      return withWorkDir(async (dir) => {
        const file = await stage(dir, document);
        // Exit 1 means "invalid" and still prints the JSON report.
        const result = await runCli(bin, ["validate", file, "--json"], timeoutMs);
        let parsed: { valid?: unknown; errors?: unknown };
        try {
          parsed = JSON.parse(result.stdout) as { valid?: unknown; errors?: unknown };
        } catch {
          throw new HwpCliError(
            "failed",
            `hwp validate failed (exit ${result.code}): ${result.stderr.trim() || "no JSON report"}`,
            result.stderr,
          );
        }
        const rawErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
        const errors: ValidationError[] = rawErrors.map((entry) =>
          typeof entry === "string"
            ? { code: "invalid", message: entry }
            : { code: "invalid", message: JSON.stringify(entry) },
        );
        const report: ValidationReport = { valid: parsed.valid === true, errors };
        return report;
      });
    },

    async capabilities(): Promise<Capabilities> {
      const version = await ensureVersion();
      return { version, editable: true, formats: ["hwp", "hwpx"] };
    },

    async binaryInfo() {
      return { bin: resolveBin(), version: await ensureVersion() };
    },
  };

  return engine;
}
