/**
 * Subprocess lifecycle: how a CLI invocation ends (SEC-08, SEC-09, SEC-10).
 * Deliberately NOT wrapped in describeBin — running with no real binary is
 * the requirement (TEST-02), not a convenience. Every case is driven by the
 * fake `hwp` in `fake-bin.ts`, so a stdout overflow, a timeout, a
 * SIGTERM-ignoring child and a cancelled request are all reachable without
 * an hwp-cli install.
 *
 * The `edit --help` fixture these fakes serve was captured from hwp 0.15.0.
 */

import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";
import { multipartRequest } from "./helpers.js";

const DOC = { name: "sample.hwpx", data: new Uint8Array([80, 75, 3, 4, 1, 2, 3]) };

/** The 32 MiB stdout ceiling `runCli` hands to execFile as `maxBuffer`. */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Per-call work directories only: `hwp-editor-sessions-*` belongs to the
 * session store and `hwp-editor-fake-*` to the fakes themselves, and stale
 * ones from other suites are not this file's business.
 */
function workDirs(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter(
      (name) =>
        name.startsWith("hwp-editor-") &&
        !name.startsWith("hwp-editor-sessions-") &&
        !name.startsWith("hwp-editor-fake-"),
    ),
  );
}

function newWorkDirs(before: Set<string>): string[] {
  return [...workDirs()].filter((name) => !before.has(name));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(disposeFakeBins);

describe("runCli terminal causes", () => {
  it("reports a stdout overflow as output_too_large, naming the ceiling", async () => {
    const { bin } = createFakeBin({ mode: "overflow" });
    const engine = createCliEngine({ bin });
    const error = await engine.read(DOC).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HwpCliError);
    expect((error as HwpCliError).reason).toBe("output_too_large");
    expect((error as HwpCliError).message).toContain(String(MAX_BUFFER));
  }, 30_000);

  it("reports an over-budget child as timeout, naming the budget", async () => {
    const { bin } = createFakeBin({ mode: "slow" });
    const engine = createCliEngine({ bin, timeoutMs: 200 });
    await expect(engine.read(DOC)).rejects.toMatchObject({ reason: "timeout" });
    await expect(engine.read(DOC)).rejects.toThrow(/200ms/);
  }, 30_000);

  it("escalates a SIGTERM-ignoring child to SIGKILL instead of hanging", async () => {
    const { bin } = createFakeBin({ mode: "hang" });
    const engine = createCliEngine({ bin, timeoutMs: 200 });
    const before = workDirs();
    const started = Date.now();
    // The execFile callback fires only after the child exits, so settling
    // inside the budget IS the proof that the SIGKILL landed: a child that
    // ignored SIGTERM and was never escalated would keep the promise open.
    await expect(engine.read(DOC)).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(200 + 3_000 + 2_000);
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);

  it("reports a caller abort as cancelled, not as a timeout", async () => {
    const { bin } = createFakeBin({ mode: "slow" });
    const engine = createCliEngine({ bin, timeoutMs: 30_000 });
    const controller = new AbortController();
    const before = workDirs();
    const pending = engine.read(DOC, { signal: controller.signal });
    await sleep(300);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);

  it("keeps the first cause when a cancellation follows a timeout", async () => {
    const { bin } = createFakeBin({ mode: "slow" });
    const engine = createCliEngine({ bin, timeoutMs: 200 });
    const controller = new AbortController();
    const pending = engine.read(DOC, { signal: controller.signal });
    await sleep(600);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "timeout" });
  }, 30_000);

  it("reports a missing binary as unavailable", async () => {
    const engine = createCliEngine({ bin: "/nonexistent/hwp" });
    await expect(engine.read(DOC)).rejects.toMatchObject({ reason: "unavailable" });
  }, 30_000);

  it("still resolves a non-zero exit, which validate depends on", async () => {
    const { bin } = createFakeBin({
      mode: "fail",
      stdout: '{"valid":false,"errors":["bad table"]}',
    });
    const engine = createCliEngine({ bin });
    await expect(engine.validate(DOC)).resolves.toEqual({
      valid: false,
      errors: [{ code: "invalid", message: "bad table" }],
    });
  }, 30_000);
});

describe("temp directory outlives the child", () => {
  it("keeps the work directory while the child is alive and removes it after", async () => {
    const { bin } = createFakeBin({ mode: "hang" });
    const engine = createCliEngine({ bin, timeoutMs: 30_000 });
    const before = workDirs();
    const controller = new AbortController();
    const pending = engine.read(DOC, { signal: controller.signal });
    let live: string[] = [];
    for (let i = 0; i < 100 && live.length === 0; i++) {
      await sleep(50);
      live = newWorkDirs(before);
    }
    expect(live).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);
});

describe("request cancellation reaches every spawning action", () => {
  it("settles an aborted POST /render as 499 cancelled", async () => {
    const { bin } = createFakeBin({ mode: "slow" });
    const handler = createHwpEditorHandler({ bin, timeoutMs: 30_000, sessions: false });
    const controller = new AbortController();
    const req = new Request(
      multipartRequest("http://test/api/hwp-editor/render", { file: DOC }),
      { signal: controller.signal },
    );
    const before = workDirs();
    const pending = handler(req);
    await sleep(300);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "cancelled" } });
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);
});
