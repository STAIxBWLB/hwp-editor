/**
 * Child-process environment pinning (ERR-04). Deliberately NOT wrapped in
 * describeBin: this is the proof that the child's locale is decided by this
 * package rather than the operator's shell, and it must run on a machine
 * with no hwp-cli binary.
 */

import { afterEach, describe, expect, it } from "vitest";

import { scrubbedEnv } from "../src/cli-engine.js";

const MUTATED = [
  "HWP_LANG",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "HWP_FONT_DIR",
  "PATH",
  "HOME",
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("scrubbedEnv", () => {
  it("overrides an inherited Korean locale", () => {
    setEnv("HWP_LANG", "ko");
    setEnv("LANG", "ko_KR.UTF-8");
    setEnv("LC_ALL", "ko_KR.UTF-8");
    setEnv("LC_MESSAGES", "ko_KR.UTF-8");
    const env = scrubbedEnv();
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.LC_MESSAGES).toBe("C.UTF-8");
    expect(env.HWP_LANG).toBe("en");
  });

  it("pins the same four values when none of them are set", () => {
    for (const key of ["HWP_LANG", "LANG", "LC_ALL", "LC_MESSAGES"]) setEnv(key, undefined);
    const env = scrubbedEnv();
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.LC_MESSAGES).toBe("C.UTF-8");
    expect(env.HWP_LANG).toBe("en");
  });

  it("lets the locale option set HWP_LANG only", () => {
    const env = scrubbedEnv("ko");
    expect(env.HWP_LANG).toBe("ko");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.LC_MESSAGES).toBe("C.UTF-8");
  });

  it.each(["", "   "])("resolves a blank locale %j to en", (locale) => {
    expect(scrubbedEnv(locale).HWP_LANG).toBe("en");
  });

  it("still passes every other HWP_* variable through", () => {
    setEnv("HWP_FONT_DIR", "/fonts");
    expect(scrubbedEnv().HWP_FONT_DIR).toBe("/fonts");
  });

  it("still forwards PATH and HOME", () => {
    setEnv("PATH", "/usr/bin");
    setEnv("HOME", "/home/tester");
    const env = scrubbedEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/tester");
  });
});
