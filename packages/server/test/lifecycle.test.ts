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

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";
import { multipartRequest } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DOC = { name: "sample.hwpx", data: new Uint8Array([80, 75, 3, 4, 1, 2, 3]) };

/** The 32 MiB stdout ceiling `runCli` hands to execFile as `maxBuffer`. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** `KILL_GRACE_MS` in cli-engine.ts; module-private there, mirrored here. */
const KILL_GRACE_MS = 3_000;

/**
 * Budget for the timeout cases. Comfortably above the cost of spawning a
 * `#!/bin/sh` fake (a few hundred ms under vitest) and far below the `slow`
 * and `hang` fakes' own durations, so what times out is the subcommand.
 */
const TIMEOUT_MS = 1_000;

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

/**
 * Capture a settlement instead of awaiting it. Cases that abort mid-flight
 * must attach their handler before the abort, or the rejection is unhandled
 * for as long as the test takes to get around to asserting on it.
 */
function settled<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (error: unknown) => error,
  );
}

/**
 * Wait until the fake has logged the named subcommand. Spawning a `#!/bin/sh`
 * fake costs a few hundred ms under vitest, so a fixed delay before the abort
 * races the spawn: what these cases must abort is a child that is already
 * running.
 */
async function waitForSpawn(log: () => string, subcommand: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (new RegExp(`^${subcommand}\\b`, "m").test(log())) return;
    await sleep(25);
  }
  throw new Error(`fake hwp never ran ${subcommand}; log: ${log()}`);
}

const helpDirs: string[] = [];

/**
 * The captured `edit --help` with the bare `--set-cell` flag dropped while
 * both `--set-cell-by-label` occurrences remain. This is the prefix collision
 * the handshake's word-boundary match exists for: a naive
 * `help.includes("--set-cell")` passes against this fixture.
 *
 * The dir is named `hwp-editor-fake-*` so `workDirs()` keeps ignoring it.
 */
function helpWithoutSetCell(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hwp-editor-fake-help-"));
  helpDirs.push(dir);
  const source = readFileSync(path.join(HERE, "fixtures", "edit-help.txt"), "utf8");
  const file = path.join(dir, "edit-help.txt");
  writeFileSync(file, source.replace("--set-cell <SET_CELL>", "--dropped-flag <SET_CELL>"));
  return file;
}

afterEach(() => {
  disposeFakeBins();
  while (helpDirs.length > 0) rmSync(helpDirs.pop()!, { recursive: true, force: true });
});

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
    const engine = createCliEngine({ bin, timeoutMs: TIMEOUT_MS });
    // Warm the version memo first: `--version` runs under the same budget,
    // and spawning a `#!/bin/sh` fake is not free. Without this the timeout
    // under test could be the handshake's rather than the subcommand's.
    await engine.capabilities();
    const error = await engine.read(DOC).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HwpCliError);
    expect((error as HwpCliError).reason).toBe("timeout");
    expect((error as HwpCliError).message).toContain(`${TIMEOUT_MS}ms`);
  }, 30_000);

  it("escalates a SIGTERM-ignoring child to SIGKILL instead of hanging", async () => {
    const { bin } = createFakeBin({ mode: "hang" });
    const engine = createCliEngine({ bin, timeoutMs: TIMEOUT_MS });
    await engine.capabilities();
    const before = workDirs();
    const started = Date.now();
    // The execFile callback fires only after the child exits, so settling
    // inside the budget IS the proof that the SIGKILL landed: a child that
    // ignored SIGTERM and was never escalated would keep the promise open.
    await expect(engine.read(DOC)).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + KILL_GRACE_MS + 2_000);
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);

  it("reports a caller abort as cancelled, not as a timeout", async () => {
    const { bin, log } = createFakeBin({ mode: "slow" });
    const engine = createCliEngine({ bin, timeoutMs: 30_000 });
    const controller = new AbortController();
    const before = workDirs();
    const pending = settled(engine.read(DOC, { signal: controller.signal }));
    await waitForSpawn(log, "cat");
    controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled" });
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);

  it("refuses to spawn at all for a signal that is already aborted", async () => {
    const { bin, log } = createFakeBin({ mode: "slow" });
    const engine = createCliEngine({ bin, timeoutMs: 30_000 });
    // Warm the version memo first; the abort must stop the `cat`, and an
    // aborted signal never re-dispatches, so a listener alone would miss it.
    await engine.capabilities();
    await expect(
      engine.read(DOC, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(log()).not.toMatch(/^cat\b/m);
  }, 30_000);

  it("keeps the first cause when a cancellation follows a timeout", async () => {
    const { bin } = createFakeBin({ mode: "slow" });
    const engine = createCliEngine({ bin, timeoutMs: TIMEOUT_MS });
    await engine.capabilities();
    const controller = new AbortController();
    const pending = settled(engine.read(DOC, { signal: controller.signal }));
    await sleep(TIMEOUT_MS + 500);
    controller.abort();
    expect(await pending).toMatchObject({ reason: "timeout" });
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
    const { bin, log } = createFakeBin({ mode: "hang" });
    const engine = createCliEngine({ bin, timeoutMs: 30_000 });
    await engine.capabilities();
    const before = workDirs();
    const controller = new AbortController();
    const pending = settled(engine.read(DOC, { signal: controller.signal }));
    await waitForSpawn(log, "cat");
    let live: string[] = [];
    for (let i = 0; i < 100 && live.length === 0; i++) {
      await sleep(50);
      live = newWorkDirs(before);
    }
    expect(live).toHaveLength(1);
    const abortedAt = Date.now();
    controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled" });
    // The child ignores SIGTERM, so it cannot have exited before the SIGKILL
    // escalation. Settling any sooner would mean the promise settled on the
    // signal rather than on the exit — which is exactly the ordering that
    // lets `withWorkDir` delete a directory the child still holds.
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(KILL_GRACE_MS);
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);
});

describe("request cancellation reaches every spawning action", () => {
  it("settles an aborted POST /render as 499 cancelled", async () => {
    const { bin, log } = createFakeBin({ mode: "slow" });
    const handler = createHwpEditorHandler({ bin, timeoutMs: 30_000, sessions: false });
    const controller = new AbortController();
    const req = new Request(
      multipartRequest("http://test/api/hwp-editor/render", { file: DOC }),
      { signal: controller.signal },
    );
    const before = workDirs();
    const pending = handler(req);
    await waitForSpawn(log, "render");
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "cancelled" } });
    expect(newWorkDirs(before)).toEqual([]);
  }, 30_000);
});

describe("handshake", () => {
  it("refuses a binary below the version floor", async () => {
    const { bin } = createFakeBin({ version: "0.7.0" });
    const engine = createCliEngine({ bin });
    const error = await engine.capabilities().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HwpCliError);
    expect((error as HwpCliError).reason).toBe("version");
  }, 30_000);

  it("refuses a binary at the major-version ceiling, not just above it", async () => {
    const { bin } = createFakeBin({ version: "1.0.0" });
    const engine = createCliEngine({ bin });
    const error = await engine.capabilities().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HwpCliError);
    expect((error as HwpCliError).reason).toBe("version");
  }, 30_000);

  it("refuses a binary missing a flag the op grammar emits, naming it", async () => {
    const { bin } = createFakeBin({ helpFixture: helpWithoutSetCell() });
    const engine = createCliEngine({ bin });
    const error = await engine.capabilities().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HwpCliError);
    expect((error as HwpCliError).reason).toBe("version");
    // Named, and named alone: both `--set-cell-by-label` occurrences survive
    // in the fixture, so a substring match would have found `--set-cell`
    // inside one of them and let the binary through.
    expect((error as HwpCliError).message).toContain("--set-cell");
    expect((error as HwpCliError).message).not.toContain("--replace");
  }, 30_000);

  it("refuses a binary whose edit --help exits non-zero", async () => {
    const { bin } = createFakeBin({ helpFixture: "/nonexistent/edit-help.txt" });
    const engine = createCliEngine({ bin });
    const error = await engine.capabilities().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HwpCliError);
    expect((error as HwpCliError).reason).toBe("version");
  }, 30_000);

  it("runs once per engine instance", async () => {
    const { bin, log } = createFakeBin();
    const engine = createCliEngine({ bin });
    await engine.capabilities();
    await engine.capabilities();
    await engine.capabilities();
    const helpLines = log()
      .split("\n")
      .filter((line) => /^edit --help\b/.test(line));
    expect(helpLines).toHaveLength(1);
  }, 30_000);
});

describe("capabilities", () => {
  it("reports the resolved binary version with no hwp-cli installed", async () => {
    const { bin } = createFakeBin({ version: "0.14.0" });
    const engine = createCliEngine({ bin });
    await expect(engine.capabilities()).resolves.toEqual({
      version: "0.14.0",
      editable: true,
      formats: ["hwp", "hwpx"],
    });
  }, 30_000);
});

/** The tmpdir roots a staged path or a resolved binary path would sit under. */
const ABSOLUTE_PATH = /\/(tmp|var|Users|home|opt)\//;

async function thrown(promise: Promise<unknown>): Promise<HwpCliError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HwpCliError);
  return error as HwpCliError;
}

describe("no leak: engine messages carry no path and no CLI output", () => {
  it("names the subcommand and exit code, keeping CLI output on stderr and detail", async () => {
    const { bin } = createFakeBin({
      mode: "fail",
      info: "{}",
      editStderr: "boom on stderr",
      stdout: "chatter on stdout",
    });
    const error = await thrown(createCliEngine({ bin }).edit(DOC, []));
    expect(error.reason).toBe("failed");
    expect(error.message).toContain("edit");
    expect(error.message).toContain("exit 3");
    expect(error.message).not.toContain("boom on stderr");
    expect(error.message).not.toContain("chatter on stdout");
    // stderr is what protectedReasonFromStderr reads; it must survive verbatim.
    expect(error.stderr).toContain("boom on stderr");
    expect(error.detail).toContain("boom on stderr");
    expect(error.detail).toContain(bin);
  }, 30_000);

  it("reports a missing binary without naming the path it tried", async () => {
    const error = await thrown(createCliEngine({ bin: "/nonexistent/hwp" }).capabilities());
    expect(error.reason).toBe("unavailable");
    // Pinned by packages/react/src/errors.ts's fallback classifier.
    expect(error.message).toContain("binary not found");
    expect(error.message).not.toContain("/nonexistent/hwp");
    expect(error.detail).toContain("/nonexistent/hwp");
  }, 30_000);

  it("reports an unparseable version without quoting the output", async () => {
    const { bin } = createFakeBin({ version: "no semver here" });
    const error = await thrown(createCliEngine({ bin }).capabilities());
    expect(error.reason).toBe("version");
    expect(error.message).toMatch(/parse/i);
    expect(error.message).not.toContain("no semver here");
    expect(error.detail).toContain("no semver here");
  }, 30_000);

  it("produces no message matching an absolute filesystem path", async () => {
    const messages: string[] = [];
    const collect = async (promise: Promise<unknown>): Promise<void> => {
      const error = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      if (error instanceof Error) messages.push(error.message);
    };
    // The fakes themselves live under the tmpdir, so a leaked `bin` trips the
    // pattern as surely as a leaked staged input path does.
    const failing = createFakeBin({
      mode: "fail",
      info: "{}",
      editStderr: "cannot open /var/folders/xx/in.hwpx",
    });
    await collect(createCliEngine({ bin: failing.bin }).edit(DOC, []));
    await collect(createCliEngine({ bin: failing.bin }).validate(DOC));
    await collect(createCliEngine({ bin: createFakeBin({ version: "none" }).bin }).capabilities());
    await collect(createCliEngine({ bin: createFakeBin({ version: "0.7.0" }).bin }).capabilities());
    await collect(
      createCliEngine({ bin: createFakeBin({ helpFixture: helpWithoutSetCell() }).bin }).capabilities(),
    );
    await collect(createCliEngine({ bin: "/nonexistent/hwp" }).capabilities());
    expect(messages.length).toBeGreaterThanOrEqual(4);
    for (const message of messages) expect(message).not.toMatch(ABSOLUTE_PATH);
  }, 60_000);
});
