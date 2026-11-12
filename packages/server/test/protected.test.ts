/**
 * Protected-document detection: the `hwp info --json` pre-flight and the
 * Korean stderr backstop. Pure unit test — it must run on a machine with no
 * hwp-cli binary, so the `edit` cases drive `createCliEngine` with a tiny
 * shell script standing in for the binary rather than a real protected
 * fixture (no such fixture exists in this repo or in hwp-cli's).
 */

import { afterEach, describe, expect, it } from "vitest";

import { DISTRIBUTION_NEXT_STEP, PROTECTED_NEXT_STEP, STOPPED_WITHOUT_DIAGNOSTIC } from "@hwp-editor/core";

import {
  cliExitHead,
  createCliEngine,
  documentEditability,
  HwpCliError,
  protectedReasonFromStderr,
} from "../src/cli-engine.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";
import type { FakeBinOptions } from "./fake-bin.js";

const DOC = { name: "sample.hwpx", data: new Uint8Array([80, 75, 3, 4, 1, 2, 3]) };

/**
 * The next step as a literal, not read off the source: this sentence is what a
 * caller acts on, so rewording it has to be a deliberate edit here too. The
 * exported constants are asserted against these below.
 */
const STEP = "remove the protection in a word processor that can open it, save a copy, then reopen that copy here";

/**
 * A 배포용 document keeps a step of its own (#105 item 2 review): hwp-cli's
 * DistributionDoc message offers no word-processor remedy, because a word
 * processor opens one without being able to edit it, so the shared step would
 * name nothing its reader can do. The two steps must not converge.
 */
const DIST_STEP = "open the original this copy was published from, or convert this copy with hwp convert --to hwpx and open the converted file here; saving in another format does not keep the distribution protection";

const FIXED_MESSAGES = [
  `encrypted document; ${STEP}`,
  `DRM-protected document; ${STEP}`,
  `signed document; ${STEP}`,
  `distribution (배포용) document; ${DIST_STEP}`,
];

afterEach(disposeFakeBins);

/** The shared fake in `fail` mode: `info` answers, everything else exits 3. */
function fakeBin(opts: FakeBinOptions & { info: string }): { bin: string; log: () => string } {
  return createFakeBin({ mode: "fail", ...opts });
}

describe("documentEditability", () => {
  it("reports the hwp5 boolean protections as non-editable, with distinct reasons", () => {
    const encrypted = documentEditability({ encrypted: true });
    const distribution = documentEditability({ distribution: true });
    expect(encrypted.editable).toBe(false);
    expect(distribution.editable).toBe(false);
    expect(encrypted.reason).toBe(FIXED_MESSAGES[0]);
    // The pre-flight and the stderr backstop must name the same step for the
    // same kind, or the sentence depends on which path noticed the protection.
    expect(distribution.reason).toBe(FIXED_MESSAGES[3]);
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
  it("pins the exported next steps to the sentences these tests assert", () => {
    expect(PROTECTED_NEXT_STEP).toBe(STEP);
    expect(DISTRIBUTION_NEXT_STEP).toBe(DIST_STEP);
    expect(STEP).not.toBe(DIST_STEP);
  });

  it("gives 배포용 its own step and leaves it off the word-processor kinds", () => {
    const distribution = protectedReasonFromStderr("배포용 문서(ViewText)");
    // The step a word processor can lift is exactly what a 배포용 refusal must
    // not print: nothing in the engine's DistributionDoc message says a word
    // processor can make an editable copy of it.
    expect(distribution).not.toContain(STEP);
    expect(distribution).toContain("hwp convert --to hwpx");
    expect(protectedReasonFromStderr("DRM으로 보호된 문서")).not.toContain(DIST_STEP);
  });

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

/**
 * The protected sentence carries the command that failed, and only that
 * (#105 item 2). `runCliOk` writes nothing else, but a failure's message can
 * hold a wrapper's added text, and some wrappers name the engine's stderr or a
 * staged path, so the head is matched rather than assumed to be the whole
 * message.
 */
describe("the command head a protected sentence may print", () => {
  it("takes the head alone from a message that carries engine text after it", () => {
    const message = "hwp lint failed (exit 1): Error: /private/tmp/hwp-editor-x/in.hwpx 암호화된 문서입니다";
    expect(cliExitHead(message)).toBe("hwp lint failed (exit 1)");
  });

  it("keeps the head when runCliOk appended the stopped-without-diagnostic line", () => {
    const message = `hwp edit failed (exit -1): ${STOPPED_WITHOUT_DIAGNOSTIC}`;
    expect(cliExitHead(message)).toBe("hwp edit failed (exit -1)");
  });

  it.each([
    ["a family sentence a template command replaced the failure with", "hwp lint could not inspect this document with hwp-cli 1.4.0; check that it opens with hwp info, then retry."],
    ["a version refusal", "Template commands require hwp-cli 1.4.0 or newer"],
    ["the head not at the start", "→ hwp edit failed (exit 1)"],
    ["an empty message", ""],
  ])("answers null for %s, so the sentence falls back to the neutral subject", (_name, message) => {
    expect(cliExitHead(message)).toBeNull();
  });
});

describe("edit pre-flight and stderr backstop", () => {
  it("rejects an encrypted document as protected without spawning hwp edit", async () => {
    const { bin, log } = fakeBin({ info: '{"encrypted":true}' });
    const engine = createCliEngine({ bin });
    await expect(engine.edit(DOC, [])).rejects.toMatchObject({ reason: "protected" });
    // `edit --help` is excluded: that is the startup flag handshake, which
    // every engine method awaits before doing anything. What must not appear
    // is an `edit` invocation against the document.
    expect(log()).not.toMatch(/^edit (?!--help\b)/m);
  });

  it("upgrades a failed edit to protected when stderr carries a Korean marker", async () => {
    const { bin } = fakeBin({ info: "{}", editStderr: "DRM으로 보호된 문서입니다" });
    const engine = createCliEngine({ bin });
    // The command that failed and the next step, not a sentence naming
    // edit/compose whatever ran (#105 item 2).
    await expect(engine.edit(DOC, [])).rejects.toMatchObject({
      reason: "protected",
      message: `hwp edit failed (exit 3): ${FIXED_MESSAGES[1]}`,
    });
  });

  it("names the command that failed when a lint is refused as protected", async () => {
    // Since #104 lint rides `runCliOk`, so a protection marker on its stderr
    // reaches a caller as `protected`; the sentence must name lint, which the
    // shared table cannot know.
    const { bin } = fakeBin({
      // Template commands carry their own floor (1.4.0), unlike `edit`.
      version: "1.4.0",
      info: "{}",
      failTemplateCommand: "lint",
      templateStderr: "암호화된 문서는 지원하지 않습니다",
      templateFailureCode: 1,
    });
    const engine = createCliEngine({ bin });
    await expect(engine.lint(DOC)).rejects.toMatchObject({
      reason: "protected",
      message: `hwp lint failed (exit 1): ${FIXED_MESSAGES[0]}`,
    });
  });

  it("leaves an unrelated edit failure classified as failed", async () => {
    const { bin } = fakeBin({ info: "{}", editStderr: "no target matched" });
    const engine = createCliEngine({ bin });
    await expect(engine.edit(DOC, [])).rejects.toSatisfy(
      (err: unknown) => err instanceof HwpCliError && err.reason === "failed",
    );
  });
});
