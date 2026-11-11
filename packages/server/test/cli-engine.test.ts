/**
 * Integration tests against a real hwp-cli binary at or above the 0.20.0
 * floor. Skipped with a clear message when the binary is absent (see
 * helpers.ts). Version assertions check the floor, not an exact release:
 * the dev binary moves ahead of the floor as hwp-cli ships.
 */

import { afterEach, describe, expect, it } from "vitest";

import { HwpEngineError } from "@hwp-editor/core";
import type { DocumentHandle, DocumentSpecV2, EditOp } from "@hwp-editor/core";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { BIN, describeBin, multipartRequest, sampleSpec } from "./helpers.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";

afterEach(disposeFakeBins);

describe("CliEngine unit errors", () => {
  it("retains the core error and its cause when edit rejects an invalid unit", async () => {
    const { bin } = createFakeBin({ info: "{}" });
    const failure = await createCliEngine({ bin })
      .edit({ name: "sample.hwpx", data: new Uint8Array([1]) }, [
        { kind: "set-page", key: "width", value: "-5" },
      ])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HwpCliError);
    const cliError = failure as HwpCliError;
    expect(cliError.reason).toBe("bad_request");
    expect(cliError.message).toContain("set_page.width_mm");
    expect(cliError.cause).toBeInstanceOf(HwpEngineError);
    const engineError = cliError.cause as HwpEngineError;
    expect(engineError.code).toBe("bad_request");
    expect(engineError.cause).toBeInstanceOf(Error);
    expect((engineError.cause as Error).message).toContain("set_page.width_mm");
  });
});

const engine = () => createCliEngine({ bin: BIN });

/**
 * Mirrors the engine's MIN_VERSION floor ([0, 20, 0] in cli-engine.ts).
 *
 * The accepted range is now bounded at both ends — MAX_VERSION_EXCLUSIVE is
 * [2, 0, 0] — but this still asserts the floor rather than an exact release,
 * for the reason in the file header: the dev binary moves ahead of the floor
 * as hwp-cli ships. Pinning the range here would mean editing this suite on
 * every upstream patch release, and the ceiling itself is proven against a
 * fake binary in `lifecycle.test.ts` rather than against whichever real one
 * happens to be installed. Reaching this assertion at all already proves the
 * ceiling and the flag handshake passed: `ensureVersion` runs both before it
 * resolves a version string.
 */
function expectVersionAtLeast0200(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const ok = major > 0 || minor > 20 || (minor === 20 && patch >= 0);
  expect(ok, `expected hwp-cli >= 0.20.0, got ${version}`).toBe(true);
}

it("keeps malformed direct-metadata diagnostics actionable at the CLI boundary", async () => {
  const {bin}=createFakeBin({version:"1.4.0",catStdout:JSON.stringify({
    contract:"hwp-segment-envelope-v2",schema_version:"1.0",markdown:"x",segments:[{
      id:"para",kind:"para",path:{section:0,indices:[0]},char_range:{start:0,end:1},
      direct:{char:{bold:"yes"},para:null},
    }],
  })});
  const failure=await createCliEngine({bin}).read({name:"doc.hwpx",data:new Uint8Array([1])}).catch((error:unknown)=>error);
  expect(failure).toMatchObject({reason:"failed",message:expect.stringContaining("direct.char"),cause:expect.any(Error)});
  // The JSON came from the hwp binary on this path, so the remedy is the
  // hwp-cli version, not an upgrade of some other host adapter.
  expect((failure as Error).message).toContain("use hwp-cli 0.20.0 or newer");
  expect((failure as Error).message).not.toContain("host adapter");
});

describeBin("cli-engine (real hwp-cli binary)", () => {
  it("AC3: applies spacing to five addressed paragraphs in one edit and restores all with one undo", async () => {
    const cli = engine();
    const spec = { version: "2.0", document: { version: "1.0", sections: [{ blocks:
      Array.from({length:5},(_,index)=>({type:"paragraph",runs:[{type:"text",text:`문단 ${index} 😀`}]})),
    }] } };
    const original = (await cli.compose(spec as unknown as DocumentSpecV2, "batch.hwpx")).document;
    const before = await cli.read(original);
    const paragraphs = before.segments.filter(segment=>segment.kind === "para");
    expect(paragraphs).toHaveLength(5);
    const ops: EditOp[] = paragraphs.map(paragraph=>({kind:"set-para",address:{id:paragraph.id!},key:"line-spacing",value:"200%"}));
    const edited = await cli.edit(original,ops);
    const after = await cli.read(edited);
    expect(after.segments.filter(segment=>segment.kind === "para").map(segment=>segment.directPara?.line_spacing)).toEqual([200,200,200,200,200]);
    const restored = cli.undo(edited);
    if (restored === null) throw new Error("missing undo snapshot");
    expect(restored.data).toEqual(original.data);
    expect((await cli.read(restored)).segments.filter(segment=>segment.kind === "para").map(segment=>segment.directPara))
      .toEqual(paragraphs.map(segment=>segment.directPara));
  });

  it("reports a verified >= 0.20.0 version", async () => {
    const info = await engine().binaryInfo();
    expect(info.bin).toBe(BIN);
    expectVersionAtLeast0200(info.version);
    const caps = await engine().capabilities();
    expectVersionAtLeast0200(caps.version);
    expect(caps).toMatchObject({ editable: true, editOps: "v1", formats: ["hwp", "hwpx"] });
  });

  it("AC2: bolds three WCHARs in only the addressed repeated phrase", async () => {
    const cli = engine();
    const phrase = "반복문구입니다.";
    const spec = { version: "2.0", document: { version: "1.0", sections: [{
      blocks: [0, 1].map(() => ({
        type: "paragraph", runs: [{ type: "text", text: phrase }],
      })),
    }] } };
    const { document } = await cli.compose(spec as unknown as DocumentSpecV2, "repeated.hwpx");
    const before = await cli.read(document);
    const paragraphs = before.segments.filter((segment) => segment.kind === "para");
    expect(paragraphs).toHaveLength(2);
    const run = before.segments.find((segment) =>
      segment.kind === "run" && segment.para === paragraphs[1]!.para);
    expect(run?.id).toBeDefined();
    const edited = await cli.edit(document, [{ kind: "set-format",
      address: { id: run!.id!, chars: [0, 3] }, props: { bold: "on" } }]);
    const after = await cli.read(edited);
    expect(after.markdown).toBe(`${phrase}\n\n**반복문**구입니다.\n\n`);
    // Explicit find-and-replace still supports a document-wide text pattern.
    const replaced = await cli.edit(document, [{ kind: "replace", find: phrase, replace: "수정" }]);
    expect((await cli.read(replaced)).markdown).toBe("수정\n\n수정\n\n");
  });

  it("rejects binaries older than 0.20.0", async () => {
    // /bin/echo prints no semver — stands in for an unusable binary.
    const bad = createCliEngine({ bin: "/bin/echo" });
    await expect(bad.capabilities()).rejects.toThrow(HwpCliError);
  });

  it("inserts an uploaded PNG from its per-call staged asset path", async () => {
    const cli = engine();
    const { document } = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "image-upload.hwpx");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    );
    const edited = await cli.edit(document, [{
      kind: "insert-image", anchor: "안녕하세요", path: "figure.png", width: 20, height: 15,
    }], { assets: [{ name: "figure.png", data: new Uint8Array(image) }], verify: true });
    expect(edited.data.length).toBeGreaterThan(document.data.length);
    expect((await cli.validate(edited)).valid).toBe(true);
    expect((await cli.render(edited, { format: "png", pages: "1" })).length).toBeGreaterThan(0);
  });

  it("preserves the engine failure for a mixed upload batch whose formatting target is missing", async () => {
    const cli = engine();
    const { document } = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "mixed-upload.hwpx");
    const image = new Uint8Array(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64",
    ));
    const failure = await cli.edit(document, [
      { kind: "insert-image", anchor: "안녕하세요", path: "figure.png", width: 20, height: 15 },
      { kind: "set-format", find: "missing-format-target", props: { bold: "on" } },
    ], { assets: [{ name: "figure.png", data: image }] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HwpCliError);
    expect(failure).toMatchObject({ reason: "failed", message: expect.stringMatching(/hwp edit failed \(exit [0-9]+\).*operation targets and values/) });
    expect((failure as HwpCliError).message).not.toMatch(/Image insertion failed|re-export/);
    expect((failure as HwpCliError).stderr).toBeTruthy();
    expect((failure as HwpCliError).detail).toContain((failure as HwpCliError).stderr!.trim());
  });

  it("rejects direct API asset references before resolving or spawning the binary", async () => {
    const missing = createCliEngine({ bin: "/no/such/hwp-binary" });
    await expect(missing.edit({ name: "doc.hwpx", data: new Uint8Array() }, [
      { kind: "insert-image", anchor: "x", path: "not-uploaded.png" },
    ], { assets: [{ name: "figure.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }] }))
      .rejects.toMatchObject({ reason: "bad_request" });
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

  it("render accepts jpeg and webp and returns valid images of each format", async () => {
    const cli = engine();
    const composed = await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "fmt.hwpx");
    const jpeg = await cli.render(composed.document, { format: "jpeg", pages: "1" });
    expect(jpeg).toHaveLength(1);
    expect(jpeg[0]!.format).toBe("jpeg");
    expect([...jpeg[0]!.data.slice(0, 2)]).toEqual([0xff, 0xd8]); // JPEG SOI
    expect(jpeg[0]!.width).toBeGreaterThan(0);
    expect(jpeg[0]!.height).toBeGreaterThan(0);
    const webp = await cli.render(composed.document, { format: "webp", pages: "1" });
    expect(webp).toHaveLength(1);
    expect(webp[0]!.format).toBe("webp");
    expect(Buffer.from(webp[0]!.data.slice(0, 4)).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(webp[0]!.data.slice(8, 12)).toString("ascii")).toBe("WEBP");
    expect(webp[0]!.width).toBeGreaterThan(0);
    expect(webp[0]!.height).toBeGreaterThan(0);
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
    // The 0.20.0 ops channel still refuses when *no* op matches, even with
    // allowPartial. Re-observed against the v0.20.0 release binary rather
    // than renumbered on trust; the assertion below is what re-verifies it
    // on every run.
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
  it("returns an actionable bad_request for invalid units before invoking edit", async () => {
    const cli = engine();
    const document = (await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "units.hwpx")).document;
    const handler = createHwpEditorHandler({ engine: cli });
    const response = await handler(multipartRequest("http://localhost/api/hwp-editor/edit", {
      file: document,
      ops: JSON.stringify([{ kind: "set-page", key: "width", value: "-5" }]),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: {
      code: "bad_request", message: expect.stringContaining("provide a nonnegative decimal"),
    } });
  });

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

  it("POST /edit inserts uploaded image bytes through the real route", async () => {
    const cli=engine();
    const document=(await cli.compose(sampleSpec() as unknown as DocumentSpecV2,"wire-image.hwpx")).document;
    const image=new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64"));
    const form=new FormData();
    form.append("file",new Blob([document.data as BlobPart]),document.name);
    form.append("asset",new Blob([image]),"upload.png");
    form.append("ops",JSON.stringify([{kind:"insert-image",anchor:"안녕하세요",path:"upload.png",width:20,height:15}]));
    const url="http://localhost/api/hwp-editor/edit";
    const uncounted=new Request(url,{method:"POST",body:form}),body=await uncounted.arrayBuffer();
    const request=new Request(url,{method:"POST",body,headers:{"content-type":uncounted.headers.get("content-type")!,"content-length":String(body.byteLength)}});
    const response=await createHwpEditorHandler({engine:cli})(request);
    expect(response.status).toBe(200);
    const result=await response.json();
    const edited={name:result.name,data:new Uint8Array(Buffer.from(result.dataBase64,"base64"))};
    expect((await cli.read(edited)).segments.some(segment=>segment.kind==="image")).toBe(true);
    expect((await cli.validate(edited)).valid).toBe(true);
  });

  it("GET /capabilities over the wire", async () => {
    const handler = createHwpEditorHandler({ engine: engine() });
    const res = await handler(new Request("http://localhost/api/hwp-editor/capabilities"));
    expect(res.status).toBe(200);
    expectVersionAtLeast0200((await res.json()).version);
  });

  /**
   * The engine half of SEC-04. `inspections` and `snapshots` live inside
   * `createCliEngine` and are not reachable from outside it, so a cache hit is
   * asserted by OBJECT IDENTITY on the returned inspection: a miss re-runs the
   * five-spawn pipeline and cannot return the same object. The route half —
   * that the scope reaches these calls at all — is `authorize.test.ts`'s
   * describe of the same name.
   */
  describe("scope isolation", () => {
    it("does not serve one scope's inspection to another", async () => {
      const cli = engine();
      const doc = (await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "scope.hwpx"))
        .document;
      const a1 = await cli.describe(doc, { scope: "tenant-a" });
      const a2 = await cli.describe(doc, { scope: "tenant-a" });
      expect(a2).toBe(a1); // same scope, same bytes: cache hit
      const b1 = await cli.describe(doc, { scope: "tenant-b" });
      expect(b1).not.toBe(a1); // different scope, same bytes: real call
      expect(b1.envelope.markdown).toBe(a1.envelope.markdown);
    });

    it("does not let one scope undo another's edit", async () => {
      const cli = engine();
      const original = (await cli.compose(sampleSpec() as unknown as DocumentSpecV2, "undo.hwpx"))
        .document;
      const ops: EditOp[] = [{ kind: "replace", find: "안녕하세요", replace: "반갑습니다" }];
      const edited = await cli.edit(original, ops, {}, { scope: "tenant-a" });
      // Wrong scope first: a hit here would consume the entry and mask the next.
      expect(cli.undo(edited, { scope: "tenant-b" })).toBeNull();
      const undone = cli.undo(edited, { scope: "tenant-a" });
      expect(undone).not.toBeNull();
      expect([...undone!.data]).toEqual([...original.data]);
    });
  });
});
