/**
 * Protected-document detection: the `hwp info --json` pre-flight and the
 * Korean stderr backstop. Pure unit test — it must run on a machine with no
 * hwp-cli binary, so the `edit` cases drive `createCliEngine` with a tiny
 * shell script standing in for the binary rather than a real protected
 * fixture (no such fixture exists in this repo or in hwp-cli's).
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCliEngine,
  documentEditability,
  HwpCliError,
  protectedReasonFromStderr,
} from "../src/cli-engine.js";

const DOC = { name: "sample.hwpx", data: new Uint8Array([80, 75, 3, 4, 1, 2, 3]) };

const FIXED_MESSAGES = [
  "encrypted document; hwp-cli refuses edit/compose",
  "DRM-protected document; hwp-cli refuses edit/compose",
  "signed document; hwp-cli refuses edit/compose",
  "distribution (배포용) document; hwp-cli refuses edit/compose",
];

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * A stand-in `hwp` that logs every argv it receives, answers `--version`
 * with a version the engine accepts, prints `info` as the given JSON, and
 * fails `edit` with the given stderr. The log path is baked into the script
 * because `scrubbedEnv` strips everything but PATH/HOME/HWP_*.
 */
function fakeBin(opts: { info: string; editStderr?: string }): { bin: string; log: () => string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hwp-editor-fake-"));
  dirs.push(dir);
  const logPath = path.join(dir, "argv.log");
  writeFileSync(logPath, "");
  const bin = path.join(dir, "hwp");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(logPath)}`,
      'case "$1" in',
      "  --version) echo 'hwp 0.8.8' ;;",
      `  info) printf '%s' ${JSON.stringify(opts.info)} ;;`,
      `  edit) printf '%s' ${JSON.stringify(opts.editStderr ?? "boom")} >&2; exit 1 ;;`,
      "  *) echo 'unexpected' >&2; exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o700);
  return { bin, log: () => readFileSync(logPath, "utf8") };
}

describe("documentEditability", () => {
  it("reports the hwp5 boolean protections as non-editable, with distinct reasons", () => {
    const encrypted = documentEditability({ encrypted: true });
    const distribution = documentEditability({ distribution: true });
    expect(encrypted.editable).toBe(false);
    expect(distribution.editable).toBe(false);
    expect(encrypted.reason).not.toBe(distribution.reason);
  });

  it.each([
    "DRM 보안",
    "공인 인증서 암호화",
    "공인 인증서 DRM 보안",
    "전자 서명 정보",
  ])("reports attributes[] label %s as non-editable", (label) => {
    const result = documentEditability({ attributes: [label] });
    expect(result.editable).toBe(false);
    expect(typeof result.reason).toBe("string");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a non-object", "nonsense"],
    ["an empty object", {}],
    ["an empty attributes array", { attributes: [] }],
    ["an unrelated attribute", { attributes: ["압축"] }],
  ])("reports %s as editable and does not throw", (_name, info) => {
    expect(() => documentEditability(info)).not.toThrow();
    expect(documentEditability(info)).toEqual({ editable: true });
  });
});

describe("protectedReasonFromStderr", () => {
  it.each([
    ["암호화된 문서는 지원하지 않습니다", FIXED_MESSAGES[0]],
    ["DRM으로 보호된 문서", FIXED_MESSAGES[1]],
    ["서명된 문서", FIXED_MESSAGES[2]],
    ["배포용 문서(ViewText)", FIXED_MESSAGES[3]],
  ])("maps %s to its fixed message", (stderr, message) => {
    expect(protectedReasonFromStderr(`hwp edit failed (exit 1): ${stderr}`)).toBe(message);
  });

  it.each([
    ["an empty stderr", ""],
    ["an unsupported version, which shares 지원하지 않습니다", "지원하지 않는 HWP 버전입니다"],
    ["a marker-free failure", "hwp edit failed (exit 1): no target matched"],
  ])("returns null for %s", (_name, stderr) => {
    expect(protectedReasonFromStderr(stderr)).toBeNull();
  });

  it("never echoes the stderr argument back in the message", () => {
    const stderr =
      "hwp edit failed (exit 1): /tmp/hwp-editor-abc123/in.hwpx 암호화된 문서는 지원하지 않습니다";
    const message = protectedReasonFromStderr(stderr);
    expect(FIXED_MESSAGES).toContain(message);
    expect(message).not.toContain("/tmp/hwp-editor-abc123");
    expect(message).not.toContain("in.hwpx");
    expect(message).not.toContain("exit 1");
  });
});

describe("edit pre-flight and stderr backstop", () => {
  it("rejects an encrypted document as protected without spawning hwp edit", async () => {
    const { bin, log } = fakeBin({ info: '{"encrypted":true}' });
    const engine = createCliEngine({ bin });
    await expect(engine.edit(DOC, [])).rejects.toMatchObject({ reason: "protected" });
    expect(log()).not.toMatch(/^edit /m);
  });

  it("upgrades a failed edit to protected when stderr carries a Korean marker", async () => {
    const { bin } = fakeBin({ info: "{}", editStderr: "DRM으로 보호된 문서입니다" });
    const engine = createCliEngine({ bin });
    await expect(engine.edit(DOC, [])).rejects.toMatchObject({ reason: "protected" });
  });

  it("leaves an unrelated edit failure classified as failed", async () => {
    const { bin } = fakeBin({ info: "{}", editStderr: "no target matched" });
    const engine = createCliEngine({ bin });
    await expect(engine.edit(DOC, [])).rejects.toSatisfy(
      (err: unknown) => err instanceof HwpCliError && err.reason === "failed",
    );
  });
});
