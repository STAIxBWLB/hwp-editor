/**
 * The protection backstop after #112: hwp-cli's protected-document refusals
 * are read off the engine's own first `Error:` line, as whole sentences -
 * never as a marker, a later line, or a value the caller supplied.
 *
 * No binary is needed. The subject here is the text hwp-cli writes, so the
 * fixtures are that text; the sentences were read from
 * `crates/hwp5/src/error.rs` and the printed shape was measured on ahwp 1.6.1
 * (see `PROTECTED_REFUSALS` in src/errors.ts).
 */

import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_NEXT_STEP,
  PROTECTED_NEXT_STEP,
  protectedReasonFromDiagnostics,
} from "../src/errors.js";

/** `Hwp5Error::CertEncrypted`. */
const CERT_ENCRYPTED =
  "공인 인증서로 암호화된 문서는 지원하지 않습니다. 한글에서 인증서 암호화를 해제한 뒤 다시 저장하세요.";
/** `Hwp5Error::CertDrm`. */
const CERT_DRM =
  "공인 인증서 DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 인증서 DRM 보안을 해제한 뒤 다시 저장하세요.";
/** `Hwp5Error::Drm`. */
const DRM = "DRM으로 보호된 문서는 지원하지 않습니다. 한글에서 DRM 보안을 해제한 뒤 다시 저장하세요.";
/** `Hwp5Error::Signed`. */
const SIGNED = "서명된 문서는 지원하지 않습니다. 한글에서 서명을 제거한 뒤 다시 저장하세요.";
/** `Hwp5Error::DistributionDoc`; the only one with no trailing period. */
const DISTRIBUTION =
  "배포용 문서(ViewText)의 원본 구조는 지원하지 않습니다. hwp cat/convert/render는 배포용 문서를 읽을 수 있습니다";

/**
 * The sentence, the kind the client is told about, and the step that kind
 * carries. Five sentences, four kinds: the two DRM variants are one reading.
 */
const REFUSALS: ReadonlyArray<readonly [string, string, string]> = [
  [CERT_ENCRYPTED, "encrypted document", PROTECTED_NEXT_STEP],
  [CERT_DRM, "DRM-protected document", PROTECTED_NEXT_STEP],
  [DRM, "DRM-protected document", PROTECTED_NEXT_STEP],
  [SIGNED, "signed document", PROTECTED_NEXT_STEP],
  [DISTRIBUTION, "distribution (배포용) document", DISTRIBUTION_NEXT_STEP],
];

/**
 * How ahwp 1.6.1 prints a failed command: Rust's `Termination` prepends
 * `Error: `, and anyhow's Debug follows with a blank line, `Caused by:` and
 * the same message indented by four spaces.
 */
function printed(sentence: string): string {
  return `Error: ${sentence}\n\nCaused by:\n    ${sentence}\n`;
}

describe("the protection backstop", () => {
  it.each(REFUSALS)("classifies %s as the engine prints it", (sentence, kind, step) => {
    expect(protectedReasonFromDiagnostics(printed(sentence))).toBe(`${kind}; ${step}`);
  });

  it.each(REFUSALS)("classifies %s from the Error line alone", (sentence, kind, step) => {
    expect(protectedReasonFromDiagnostics(`Error: ${sentence}\n`)).toBe(`${kind}; ${step}`);
  });

  it("classifies the desktop bridge's one-line detail, where maru's head precedes the engine's", () => {
    expect(
      protectedReasonFromDiagnostics(`hwp_failed: hwp edit failed (exit 1): Error: ${DRM}`),
    ).toBe(`DRM-protected document; ${PROTECTED_NEXT_STEP}`);
  });

  /**
   * The engine's line is the first `Error:` line, not necessarily the first
   * line: a distribution load prints its notice before the failure, and the
   * bridge pastes the whole stderr after its own head.
   */
  it("finds the engine's line after the notice a distribution load prints first", () => {
    const notice = "정보: 배포용 문서를 해제했습니다 (다른 형식으로 변환해 저장하면 배포용 보호는 유지되지 않습니다)";
    expect(protectedReasonFromDiagnostics(`${notice}\nError: ${DISTRIBUTION}\n`)).toBe(
      `distribution (배포용) document; ${DISTRIBUTION_NEXT_STEP}`,
    );
    expect(
      protectedReasonFromDiagnostics(`hwp_failed: hwp edit failed (exit 1): ${notice}\nError: ${DRM}`),
    ).toBe(`DRM-protected document; ${PROTECTED_NEXT_STEP}`);
  });

  it("reads CRLF stderr the same as LF", () => {
    expect(protectedReasonFromDiagnostics(printed(DRM).replaceAll("\n", "\r\n"))).toBe(
      `DRM-protected document; ${PROTECTED_NEXT_STEP}`,
    );
  });

  /**
   * The `Caused by:` copy is the engine's too, but it is not accepted, and
   * this is the case that says so: `fill` prints unmatched field names with
   * `{}` (fill.rs, joined and not escaped), so a caller's value can put a
   * newline and then a protection sentence at the start of a line. An
   * indented line is therefore not evidence of anything.
   */
  it.each(REFUSALS)("does not classify %s from the Caused by copy alone", (sentence) => {
    expect(protectedReasonFromDiagnostics(`\nCaused by:\n    ${sentence}\n`)).toBeNull();
  });

  it("keeps the two DRM variants on one reading and the rest apart", () => {
    const kinds = new Set(
      REFUSALS.map(([sentence]) => protectedReasonFromDiagnostics(`Error: ${sentence}`)?.split(";")[0]),
    );
    expect(kinds).toEqual(
      new Set([
        "encrypted document",
        "DRM-protected document",
        "signed document",
        "distribution (배포용) document",
      ]),
    );
  });

  /**
   * Everything #112 named, plus the shapes the engine produces around those.
   * Each of the first three carried a marker the old substring test matched, so
   * each turned an ordinary refusal into a protection refusal and dropped the
   * real cause.
   */
  it.each([
    ["a bare marker", "DRM"],
    ["a bare kind word", "배포용 문서"],
    [
      "the 배포용 info line every distribution load prints",
      "정보: 배포용 문서를 해제했습니다 (다른 형식으로 변환해 저장하면 배포용 보호는 유지되지 않습니다)",
    ],
    ["an anchor the caller supplied, echoed into a warning", '경고: 앵커 "DRM"를 찾지 못했습니다'],
    ["an anchor that holds the whole sentence", `경고: 앵커 "${DRM}"를 찾지 못했습니다`],
    [
      "the same sentence inside a longer Error line, quoted by the engine",
      `Error: 앵커 "${DRM}"를 찾지 못했습니다`,
    ],
    [
      "an unmatched field list, which appends its hint after the names",
      `Error: 요청한 자리표시자·양식 필드를 찾지 못했습니다: ${DRM} (--allow-partial로 일치한 값만 적용 가능)`,
    ],
    [
      "a field name carrying a newline, which puts the sentence alone on its own line",
      `Error: 요청한 자리표시자·양식 필드를 찾지 못했습니다: x\n${DRM}\n (--allow-partial로 일치한 값만 적용 가능)`,
    ],
    [
      "a field name whose newline starts a second Error line",
      `Error: 요청한 자리표시자·양식 필드를 찾지 못했습니다: a\nError: ${DRM}\nb (--allow-partial로 일치한 값만 적용 가능)`,
    ],
    [
      "a field name whose newline fakes the indented Caused by copy",
      `Error: 요청한 자리표시자·양식 필드를 찾지 못했습니다: a\n    ${DRM}\nb (--allow-partial로 일치한 값만 적용 가능)`,
    ],
    [
      "the same forged Error line behind the bridge's head",
      `hwp_failed: hwp fill failed (exit 1): Error: 요청한 자리표시자·양식 필드를 찾지 못했습니다: a\nError: ${DRM}\nb (--allow-partial로 일치한 값만 적용 가능)`,
    ],
    [
      "a password refusal, which is a credential problem rather than protection",
      "Error: HWP_PASSWORD_REQUIRED_OR_INVALID: 암호가 필요하거나 올바르지 않습니다. --password-stdin으로 암호를 전달하세요.",
    ],
    ["an unsupported version", "Error: 지원하지 않는 HWP 버전입니다: 3.0 (HWP 5.x만 지원)"],
    ["an empty stderr", ""],
  ])("answers null for %s", (_name, stderr) => {
    expect(protectedReasonFromDiagnostics(stderr)).toBeNull();
  });
});
