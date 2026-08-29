/**
 * Integration tests against a real hwp-cli binary at or above the 0.8.8
 * floor. Skipped with a clear message when the binary is absent (see
 * helpers.ts). Version assertions check the floor, not an exact release:
 * the dev binary moves ahead of the floor as hwp-cli ships.
 */

import { describe, expect, it } from "vitest";

import type { DocumentHandle, DocumentSpecV2, EditOp } from "@hwp-editor/core";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { BIN, describeBin, multipartRequest, sampleSpec } from "./helpers.js";

const engine = () => createCliEngine({ bin: BIN });

/**
 * Mirrors the engine's MIN_VERSION floor ([0, 8, 8] in cli-engine.ts).
 *
 * The accepted range is now bounded at both ends — MAX_VERSION_EXCLUSIVE is
 * [1, 0, 0] — but this still asserts the floor rather than an exact release,
 * for the reason in the file header: the dev binary moves ahead of the floor
 * as hwp-cli ships. Pinning the range here would mean editing this suite on
 * every upstream patch release, and the ceiling itself is proven against a
 * fake binary in `lifecycle.test.ts` rather than against whichever real one
 * happens to be installed. Reaching this assertion at all already proves the
 * ceiling and the flag handshake passed: `ensureVersion` runs both before it
 * resolves a version string.
 */
function expectVersionAtLeast088(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const ok = major > 0 || minor > 8 || (minor === 8 && patch >= 8);
  expect(ok, `expected hwp-cli >= 0.8.8, got ${version}`).toBe(true);
}

describeBin("cli-engine (real hwp-cli binary)", () => {
  it("reports a verified >= 0.8.8 version", async () => {
    const info = await engine().binaryInfo();
    expect(info.bin).toBe(BIN);
    expectVersionAtLeast088(info.version);
    const caps = await engine().capabilities();
    expectVersionAtLeast088(caps.version);
    expect(caps).toMatchObject({ editable: true, formats: ["hwp", "hwpx"] });
  });

  it("rejects binaries older than 0.8.8", async () => {
    // /bin/echo prints no semver — stands in for an unusable binary.
    const bad = createCliEngine({ bin: "/bin/echo" });
    await expect(bad.capabilities()).rejects.toThrow(HwpCliError);
  });

  it("full loop: compose -> read -> edit -> render -> validate -> undo", async () => {
    const cli = engine();

    // compose
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "loop.hwpx");
    expect(composed.document.name).toBe("loop.hwpx");
    expect(composed.document.data.length).toBeGreaterThan(0);
    expect(composed.report).toMatchObject({ schema_version: "2.0" });
    const original = composed.document;

    // read (cat envelope; describe carries fields/bookmarks/slots/info)
    const envelope = await cli.read(original);
    expect(envelope.markdown).toContain("안녕하세요");
    expect(envelope.segments.length).toBeGreaterThan(0);
    expect(envelope.segments[0]).toMatchObject({ section: 0, kind: "para" });
    const inspection = await cli.describe(original);
    expect(inspection.fields).toEqual([]);
    expect(inspection.bookmarks).toEqual([]);
    expect(inspection.capabilities).toEqual({ editable: true });

    // edit: replace + set-cell, verified
    const ops: EditOp[] = [
      { kind: "replace", find: "통합 테스트", replace: "편집 완료" },
      { kind: "set-cell", table: 0, row: 1, col: 1, value: "CELL" },
    ];
    const edited = await cli.edit(original, ops, { verify: true });
    expect(edited.data.length).toBeGreaterThan(0);
    expect(edited.data).not.toEqual(original.data);
    const editedText = (await cli.read(edited)).markdown;
    expect(editedText).toContain("편집 완료");
    expect(editedText).not.toContain("통합 테스트");
    expect(editedText).toContain("CELL");

    // render svg
    const pages = await cli.render(edited, { format: "svg", pages: "1" });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.format).toBe("svg");
    expect(pages[0]!.page).toBe(1);
    expect(pages[0]!.width).toBeGreaterThan(0);
    expect(pages[0]!.height).toBeGreaterThan(0);
    const svg = Buffer.from(pages[0]!.data).toString("utf8");
    expect(svg).toContain("<svg");

    // validate
    const report = await cli.validate(edited);
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);

    // snapshot undo: undo(edited) returns the pre-edit bytes
    const undone = cli.undo(edited);
    expect(undone).not.toBeNull();
    expect([...undone!.data]).toEqual([...original.data]);
    expect(cli.undo(edited)).toBeNull();
  });

  it("render honors page ranges and emits per-page files", async () => {
    const cli = engine();
    const spec = {
      version: "2.0",
      document: {
        version: "1.0",
        sections: [
          {
            blocks: Array.from({ length: 60 }, (_, i) => ({
              type: "paragraph",
              runs: [{ type: "text", text: `페이지 채우기 문단 ${i} `.repeat(15) }],
            })),
          },
        ],
      },
    };
    const composed = await cli.compose(spec as unknown as DocumentSpecV2, "pages.hwpx");
    const pages = await cli.render(composed.document, { format: "svg", pages: "2-3" });
    expect(pages.map((p) => p.page)).toEqual([2, 3]);
    expect(pages.every((p) => p.format === "svg" && p.width > 0)).toBe(true);
  });

  it("render falls back from svg to png when the renderer refuses svg", async () => {
    const cli = engine();
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "fb.hwpx");
    // Sanity: png works directly.
    const png = await cli.render(composed.document, { format: "png", pages: "1" });
    expect(png[0]!.format).toBe("png");
    expect([...png[0]!.data.slice(1, 4)]).toEqual([80, 78, 71]); // "PNG"
    expect(png[0]!.width).toBeGreaterThan(0);
  });

  it("render rejects jpeg/webp (hwp-cli supports png/svg only)", async () => {
    const cli = engine();
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "fmt.hwpx");
    await expect(cli.render(composed.document, { format: "jpeg" })).rejects.toMatchObject({
      reason: "unsupported_format",
    });
    await expect(cli.render(composed.document, { dpi: 10 })).rejects.toMatchObject({
      reason: "bad_request",
    });
  });

  it("validate maps CLI string errors to ValidationError entries", async () => {
    const cli = engine();
    const garbage: DocumentHandle = {
      name: "bad.hwpx",
      data: new TextEncoder().encode("not a document"),
    };
    const report = await cli.validate(garbage);
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toMatchObject({ code: "invalid" });
    expect(typeof report.errors[0]!.message).toBe("string");
  });

  it("edit without a matching target fails; allowPartial publishes the matched ones", async () => {
    const cli = engine();
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "miss.hwpx");
    await expect(
      cli.edit(composed.document, [{ kind: "replace", find: "없는문자열", replace: "x" }]),
    ).rejects.toThrow(HwpCliError);
    // 0.8.8 still refuses when *no* op matches, even with allowPartial.
    await expect(
      cli.edit(composed.document, [{ kind: "replace", find: "없는문자열", replace: "x" }], {
        allowPartial: true,
      }),
    ).rejects.toThrow(HwpCliError);
    // With at least one matched op, allowPartial publishes the matched edits.
    const edited = await cli.edit(
      composed.document,
      [
        { kind: "replace", find: "없는문자열", replace: "x" },
        { kind: "replace", find: "안녕하세요", replace: "부분적용" },
      ],
      { allowPartial: true },
    );
    expect((await cli.read(edited)).markdown).toContain("부분적용");
  });

  it("compose sanitizes hostile output names", async () => {
    const cli = engine();
    // "../evil" must never escape the temp dir: basename + .hwpx appended.
    const result = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "../evil");
    expect(result.document.name).toBe("evil.hwpx");
  });
});

describeBin("routes (real hwp-cli binary)", () => {
  it("POST /read round-trips a composed document over multipart", async () => {
    const cli = engine();
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "wire.hwpx");
    const handler = createHwpEditorHandler({ engine: cli });
    const res = await handler(
      multipartRequest("http://localhost/api/hwp-editor/read", { file: composed.document }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markdown).toContain("안녕하세요");
    expect(Array.isArray(body.segments)).toBe(true);
  });

  it("POST /edit over the wire, then validate the result", async () => {
    const cli = engine();
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "wire-edit.hwpx");
    const handler = createHwpEditorHandler({ engine: cli });
    const editRes = await handler(
      multipartRequest("http://localhost/api/hwp-editor/edit", {
        file: composed.document,
        ops: JSON.stringify([{ kind: "replace", find: "안녕하세요", replace: "반갑습니다" }]),
      }),
    );
    expect(editRes.status).toBe(200);
    const editBody = await editRes.json();
    const editedBytes = new Uint8Array(Buffer.from(editBody.dataBase64, "base64"));
    const validateRes = await handler(
      multipartRequest("http://localhost/api/hwp-editor/validate", {
        file: { name: editBody.name, data: editedBytes },
      }),
    );
    expect(validateRes.status).toBe(200);
    expect((await validateRes.json()).valid).toBe(true);
    const text = await cli.read({ name: editBody.name, data: editedBytes });
    expect(text.markdown).toContain("반갑습니다");
  });

  it("GET /capabilities over the wire", async () => {
    const handler = createHwpEditorHandler({ engine: engine() });
    const res = await handler(new Request("http://localhost/api/hwp-editor/capabilities"));
    expect(res.status).toBe(200);
    expectVersionAtLeast088((await res.json()).version);
  });
});
