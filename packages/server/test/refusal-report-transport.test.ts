import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { EditOp } from "@hwp-editor/core";
import { createHttpEngine, HwpEngineError } from "@hwp-editor/core";
import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";
import { hwpxBytes } from "./helpers.js";

afterEach(disposeFakeBins);
const fixture = (name: string) => readFileSync(new URL(`../../core/test/fixtures/refusal-reports-v1.1/${name}`, import.meta.url), "utf8");
const document = { name: "caller.hwpx", data: hwpxBytes() };
const replace: EditOp[] = [{ kind: "replace", find: "a", replace: "b" }];
const insert: EditOp[] = [{ kind: "insert-blocks", address: { at: { section: 0, paragraph: 0 } }, position: "after",
  blocks: [{ type: "paragraph", runs: [{ type: "text", text: "x" }] }] }];
const caught = async (promise: Promise<unknown>): Promise<HwpCliError> => {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(HwpCliError);
  if (!(error instanceof HwpCliError)) throw new Error("Expected typed CLI failure");
  return error;
};

function http(engine: ReturnType<typeof createCliEngine>) {
  const handler = createHwpEditorHandler({ engine, sessions: false });
  return createHttpEngine("http://localhost/api/hwp-editor", {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("content-length", String((await request.clone().arrayBuffer()).byteLength));
      return handler(request);
    }) as typeof fetch,
  });
}

describe("code-based refused report transport (#119)", () => {
  it("keeps successful reports opt-in even though modern engines always write one", async () => {
    const report = readFileSync(new URL("../../core/test/fixtures/edit-report-insert-table.json", import.meta.url), "utf8");
    const { bin, log } = createFakeBin({ version: "2.0.0", mode: "ok", info: "{}", editReport: report });
    const result = await createCliEngine({ bin }).edit(document, replace, { report: false });
    expect(log()).toContain("--report");
    expect(result.report).toBeUndefined();
  });

  it.each(["1.6.3", "2.0.0"])("forces a report on %s even when successful reports were not requested", async version => {
    const { bin, log } = createFakeBin({ version, mode: "fail", info: "{}", editRefusalReport: fixture("preservation-font.json"),
      editStderrLines: fixture("preservation-font.stderr.txt").trimEnd().split("\n") });
    const error = await caught(createCliEngine({ bin }).edit(document, replace, { report: false }));
    expect(log()).toContain("--report");
    expect(error.refusal).toBe("font_type_info");
    expect(error.engineVersion).toBe(version);
    expect(error.report?.output).toBe(document.name);
  });

  it.each([
    ["layout-overflow", { kind: "layout_overflow", blockMm: 400, insertionMm: 170 }],
    ["unknown-style", { kind: "unknown_style", style: "a; layout_overflow at $.z: b" }],
  ])("carries structured insertion values for %s, without parsing a forged stderr list", async (name, expected) => {
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReport: fixture(`${name}.json`),
      editStderrLines: ["Error: unrelated", "layout_overflow at $.styles.evil: width 9999 mm"] });
    const error = await http(createCliEngine({ bin })).edit(document, insert).catch((cause: unknown) => cause) as HwpEngineError;
    expect(error.insertion).toEqual(expected);
    expect(error.refusal).toBeUndefined();
  });

  it.each([false, true])("keeps modern-server range-tag fallback when the report is absent/unreadable=%s", async unreadable => {
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReportUnreadable: unreadable,
      editStderrLines: fixture("range-tag-shift.stderr.txt").trimEnd().split("\n") });
    const error = await caught(createCliEngine({ bin }).edit(document, replace));
    expect(error.refusal).toBe("range_tag");
    expect(error.report).toBeUndefined();
    expect(error.engineVersion).toBe("2.0.0");
  });

  it.each(['{"contract":"wrong"}', '{', ''])("rejects a present malformed report instead of classifying stderr %s", async report => {
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReport: report,
      editStderrLines: ["Error: 출력 검증 실패 (대상: /private/stage/out.hwp)", "layout_overflow at $.x: width 9999 mm"] });
    const error = await caught(createCliEngine({ bin }).edit(document, insert));
    expect(error.refusal).toBeUndefined();
    expect(error.insertion).toBeUndefined();
    expect(error.report).toBeUndefined();
    expect(error.message).toContain("Invalid refused edit report");
    expect(error.message).not.toContain("/private/stage");
  });

  it("keeps fallback when a valid report carries no refusal", async () => {
    const report = JSON.parse(fixture("unapplied-replace.json"));
    delete report.refusal;
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReport: JSON.stringify(report),
      editStderrLines: fixture("range-tag-shift.stderr.txt").trimEnd().split("\n") });
    const error = await http(createCliEngine({ bin })).edit(document, replace).catch((cause: unknown) => cause) as HwpEngineError;
    expect(error.refusal).toBe("range_tag");
    expect((error.cause as { error: { report: { output: string } } }).error.report.output).toBe(document.name);
  });

  it("keeps mixed-upload fallback remedies when a modern host cannot supply a report", async () => {
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editStderrLines: ["Error: 이미지를 삽입할 수 없습니다"] });
    const ops: EditOp[] = [...replace, { kind: "insert-image", anchor: "x", path: "client.png" }];
    const error = await caught(createCliEngine({ bin }).edit(document, ops, {
      assets: [{ name: "client.png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }],
    }));
    expect(error.message).toContain("Fix or remove the pending edit");
    expect(error.message).not.toContain("Re-export valid PNG/JPEG");
  });

  it.each([
    ["preservation-range-tag", "preservation_loss"],
    ["address-unresolvable-valid", "unclassified_refusal"],
  ])("carries the actual %s report cause class", async (name, kind) => {
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReport: fixture(`${name}.json`),
      editStderrLines: ["Error: 출력 검증 실패 (대상: out.hwp)"] });
    const error = await http(createCliEngine({ bin })).edit(document, replace).catch((cause: unknown) => cause) as HwpEngineError;
    expect(error.refusal).toBe(kind);
  });

  it("redacts every diagnostic report string before the HTTP boundary", async () => {
    const report = JSON.parse(fixture("invalid-definition-compile.json"));
    report.output = "/private/stage/out.hwpx";
    report.refusal.values.detail = "bad data at /private/stage/ops.json";
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReport: JSON.stringify(report) });
    const error = await http(createCliEngine({ bin })).edit(document, insert).catch((cause: unknown) => cause) as HwpEngineError;
    expect(error.insertion).toEqual({ kind: "invalid_definition" });
    expect(JSON.stringify(error.cause)).not.toContain("/private/stage");
    expect((error.cause as { error: { report: { output: string } } }).error.report.output).toBe(document.name);
  });

  it("keeps explicit old-engine stderr fallback in the HTTP round trip", async () => {
    const { bin } = createFakeBin({ version: "1.6.2", mode: "fail", info: "{}", editStderrLines: fixture("range-tag-shift.stderr.txt").trimEnd().split("\n") });
    const error = await http(createCliEngine({ bin })).edit(document, replace).catch((cause: unknown) => cause) as HwpEngineError;
    expect(error.refusal).toBe("range_tag");
  });

  it("keeps open-time protection ahead of a modern unclassified report", async () => {
    const { bin } = createFakeBin({ version: "2.0.0", mode: "fail", info: "{}", editRefusalReport: fixture("protected-cert-encrypted.json"),
      editStderrLines: fixture("protected-cert-encrypted.stderr.txt").trimEnd().split("\n") });
    const error = await caught(createCliEngine({ bin }).edit(document, replace));
    expect(error.reason).toBe("protected");
    expect(error.refusal).toBeUndefined();
  });
});
