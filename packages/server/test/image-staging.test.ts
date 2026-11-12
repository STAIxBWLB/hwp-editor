import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createCliEngine } from "../src/cli-engine.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";

afterEach(disposeFakeBins);

describe("uploaded image private staging", () => {
  it.each([false,true])("keeps assets inside the call dir and removes them after failure=%s", async failure => {
    const fixture=mkdtempSync(join(tmpdir(),"hwp-staging-fixture-"));
    try {
      const bin=join(fixture,"hwp"), witness=join(fixture,"witness.json");
      const help=readFileSync(fileURLToPath(new URL("./fixtures/edit-help.txt",import.meta.url)),"utf8");
      writeFileSync(bin,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('hwp 1.4.0');process.exit(0);}
if(args[0]==='edit'&&args[1]==='--help'){console.log(${JSON.stringify(help)});process.exit(0);}
if(args[0]==='info'){console.log('{}');process.exit(0);}
if(args[0]!=='edit')process.exit(2);
const opsFile=args[args.indexOf('--ops')+1],dir=path.dirname(opsFile),ops=JSON.parse(fs.readFileSync(opsFile,'utf8'));
const image=ops[0].path;
fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify({dir,image,mode:fs.statSync(image).mode&511,ops}));
if(${JSON.stringify(failure)}){process.stderr.write('Error: 이미지를 삽입할 수 없습니다');process.exit(1);}
fs.writeFileSync(args[args.indexOf('-o')+1],Buffer.from([2,3]));
`);
      chmodSync(bin,0o700);
      const call=createCliEngine({bin}).edit({name:"doc.hwpx",data:new Uint8Array([1])},[
        {kind:"insert-image",anchor:"x",path:"client.png"},{kind:"insert-image",anchor:"y",path:"client.png"},
      ],{assets:[{name:"client.png",data:new Uint8Array([137,80,78,71,13,10,26,10])}]});
      if(failure)await expect(call).rejects.toThrow("ahwp edit failed (exit 1): 이미지를 삽입할 수 없습니다. Re-export valid PNG/JPEG image bytes and confirm the anchor text exists, then apply again."); else await expect(call).resolves.toMatchObject({name:"doc.hwpx"});
      const record=JSON.parse(readFileSync(witness,"utf8"));
      expect(record.image).toBe(join(record.dir,"asset-0.png"));
      expect(record.mode).toBe(384);
      expect(record.ops.map((op:{path:string})=>op.path)).toEqual([record.image,record.image]);
      expect(existsSync(record.image)).toBe(false);
      expect(existsSync(record.dir)).toBe(false);
    } finally {rmSync(fixture,{recursive:true,force:true});}
  });
});

/**
 * Upload mode is entered on `assets?.length`, as the HTTP route and the Tauri
 * client read it: an empty list carries no upload, so an insert-image op that
 * names a desktop-local image is not this engine's to refuse (#58 item 6).
 */
it("treats an empty asset list as no uploads and keeps a local insert-image path", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "hwp-staging-empty-"));
  try {
    const bin = join(fixture, "hwp"), witness = join(fixture, "ops.json");
    const help = readFileSync(fileURLToPath(new URL("./fixtures/edit-help.txt", import.meta.url)), "utf8");
    writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('hwp 1.4.0');process.exit(0);}
if(args[0]==='edit'&&args[1]==='--help'){console.log(${JSON.stringify(help)});process.exit(0);}
if(args[0]==='info'){console.log('{}');process.exit(0);}
if(args[0]!=='edit')process.exit(2);
const opsFile=args[args.indexOf('--ops')+1];
fs.writeFileSync(${JSON.stringify(witness)},fs.readFileSync(opsFile));
fs.writeFileSync(args[args.indexOf('-o')+1],Buffer.from([2,3]));
`);
    chmodSync(bin, 0o700);
    const local = join(fixture, "local-image.png");
    const ops = [{ kind: "insert-image" as const, anchor: "x", path: local }];
    await expect(createCliEngine({ bin }).edit({ name: "doc.hwpx", data: new Uint8Array([1]) }, ops, { assets: [] }))
      .resolves.toMatchObject({ name: "doc.hwpx" });
    // The wire op keeps the caller's path: nothing was staged or rewritten.
    expect(JSON.parse(readFileSync(witness, "utf8"))).toEqual([{ op: "insert_image", anchor: "x", path: local }]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

it("names seal's upload restriction before resolving or spawning the binary", async () => {
  const engine = createCliEngine({ bin: "/no/such/hwp-binary" });
  const failure = await engine.edit({ name: "doc.hwpx", data: new Uint8Array([1]) }, [
    { kind: "insert-image", anchor: "x", path: "upload.png" },
    { kind: "seal", anchor: "signature", path: "local-seal.png" },
  ], { assets: [{ name: "upload.png", data: new Uint8Array([137,80,78,71,13,10,26,10]) }] })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ reason: "bad_request", message: expect.stringMatching(/seal.*without uploaded assets.*local host/) });
  expect((failure as Error).message).not.toContain("insert-image");
});

/**
 * The 1.4.0 upload floor refuses where it runs, not only where it is advertised
 * (#58 item 31): `capabilities()` withholds `imageAssets` below the floor, but a
 * direct engine call never reads capabilities, so an older binary took the naive
 * path and staged `asset-0.png`. The floor is this editor's verified-against
 * policy (#58 item 9), not a missing binary capability: hwp-cli could insert an
 * image from v0.20.0 on, so the refusal has to say whose floor it is.
 */
it("refuses uploaded assets on a binary below the 1.4.0 upload floor", async () => {
  // The default fake reports 0.20.0: above the version floor, below this
  // server's upload floor.
  const { bin, log } = createFakeBin();
  const failure = await createCliEngine({ bin }).edit({ name: "doc.hwpx", data: new Uint8Array([1]) }, [
    { kind: "insert-image", anchor: "x", path: "client.png" },
  ], { assets: [{ name: "client.png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }] })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ reason: "version" });
  // The cause is this server's own floor, and the found version rides along.
  expect((failure as Error).message).toContain("this server accepts uploaded images only with agent-hwp 1.4.0 or newer");
  expect((failure as Error).message).toContain("(agent-hwp 0.20.0 found)");
  expect((failure as Error).message).toContain("upgrade agent-hwp, then retry the edit");
  expect((failure as Error).message).not.toContain("has no image asset uploads");
  // The refusal precedes the edit spawn: nothing was staged, nothing ran.
  const edits = log().split("\n").filter((line) => /^edit\b/.test(line) && !/--help/.test(line));
  expect(edits).toEqual([]);
});

/**
 * A mismatch has two shapes and the engine owes each its own next step, as the
 * route learned in #98 (#58 item 31). One sentence for both told a caller with
 * an unreferenced upload to upload files it had already uploaded.
 */
it("names an upload no op references, and an insert-image path with no upload", async () => {
  const { bin } = createFakeBin({ version: "1.4.0" });
  const engine = createCliEngine({ bin });
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const unreferenced = await engine.edit({ name: "doc.hwpx", data: new Uint8Array([1]) }, [
    { kind: "insert-image", anchor: "x", path: "client.png" },
  ], { assets: [{ name: "client.png", data: png }, { name: "extra.png", data: png }] })
    .catch((error: unknown) => error);
  expect(unreferenced).toMatchObject({ reason: "bad_request" });
  expect((unreferenced as Error).message).toContain("an uploaded image is not referenced by any insert-image op");
  expect((unreferenced as Error).message).toContain("remove the unreferenced upload");
  expect((unreferenced as Error).message).not.toContain("upload matching PNG/JPEG");
  const missing = await engine.edit({ name: "doc.hwpx", data: new Uint8Array([1]) }, [
    { kind: "insert-image", anchor: "x", path: "other.png" },
  ], { assets: [{ name: "client.png", data: png }] })
    .catch((error: unknown) => error);
  expect((missing as Error).message).toContain("insert-image paths must name exactly the uploaded assets");
  expect((missing as Error).message).toContain("attach the PNG/JPEG file for each named path");
});

/**
 * Upload batches keep the engine's own line (#93), as the Tauri client does.
 * The fake engine prints `stderr` (with `{dir}` replaced by its work dir) and
 * exits 1 on edit.
 */
describe("upload batch failures keep the engine line (#93)", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  async function failWith(stderr: string, ops: Parameters<ReturnType<typeof createCliEngine>["edit"]>[1]): Promise<Error> {
    const fixture = mkdtempSync(join(tmpdir(), "hwp-upload-fail-"));
    try {
      const bin = join(fixture, "hwp");
      const help = readFileSync(fileURLToPath(new URL("./fixtures/edit-help.txt", import.meta.url)), "utf8");
      writeFileSync(bin, `#!${process.execPath}
const path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('hwp 1.4.0');process.exit(0);}
if(args[0]==='edit'&&args[1]==='--help'){console.log(${JSON.stringify(help)});process.exit(0);}
if(args[0]==='info'){console.log('{}');process.exit(0);}
if(args[0]!=='edit')process.exit(2);
const dir=path.dirname(args[args.indexOf('--ops')+1]);
process.stderr.write(${JSON.stringify(stderr)}.split('{dir}').join(dir));process.exit(1);
`);
      chmodSync(bin, 0o700);
      return await createCliEngine({ bin }).edit({ name: "doc.hwpx", data: new Uint8Array([1]) }, ops,
        { assets: [{ name: "client.png", data: PNG }] }).then(() => { throw new Error("edit succeeded"); }, (error: Error) => error);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }
  const image = { kind: "insert-image" as const, anchor: "x", path: "client.png" };

  it("leaves an insert-blocks batch with uploads to the insertion line", async () => {
    const error = await failWith("Error: insert_blocks 구역 정의 문단 앞에는 삽입할 수 없습니다", [
      image, { kind: "insert-blocks", anchor: "x", blocks: [{ type: "paragraph", runs: [{ text: "a" }] }] } as never,
    ]);
    expect(error.message).toBe("ahwp edit failed (exit 1): insert_blocks refused: 구역 정의 문단 앞에는 삽입할 수 없습니다");
    expect(error.message).not.toMatch(/re-export|pending edit/i);
  });

  it("scrubs the work dir from the engine line on the upload path", async () => {
    const error = await failWith("Error: 이미지 읽기 실패 {dir}/asset-0.png: Permission denied (os error 13)", [image]);
    expect(error.message).toBe(
      "ahwp edit failed (exit 1): 이미지 읽기 실패 <work dir>/asset-0.png: Permission denied (os error 13). " +
      "Check that the document and any uploaded image can be read, reopen the document, then apply again.",
    );
    expect(error.message).not.toContain(tmpdir());
  });

  it("gives an image-only batch with a document/IO head the file step, not the image one", async () => {
    const error = await failWith("Error: 입출력 오류: No such file or directory (os error 2)", [image]);
    expect(error.message).toBe(
      "ahwp edit failed (exit 1): 입출력 오류: No such file or directory (os error 2). " +
      "Check that the document and any uploaded image can be read, reopen the document, then apply again.",
    );
  });

  it("names a cause class for an image-only batch that panicked", async () => {
    const error = await failWith("thread 'main' panicked at src/image.rs:1:1:\nboom\n", [image]);
    expect(error.message).toMatch(/^ahwp edit failed \(exit 1\): the engine failed without naming a cause .*Apply again/u);
    expect(error.message).not.toMatch(/panicked|boom|re-export/i);
  });
});
