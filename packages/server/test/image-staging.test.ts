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
      if(failure)await expect(call).rejects.toThrow(/hwp edit failed \(exit 1\).*Image insertion failed.*PNG\/JPEG.*retry/); else await expect(call).resolves.toMatchObject({name:"doc.hwpx"});
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
 * The 1.4.0 upload grammar refuses where it runs, not only where it is
 * advertised (#58 item 31): `capabilities()` withholds `imageAssets` below the
 * floor, but a direct engine call never reads capabilities, so an older binary
 * took the naive path and staged `asset-0.png` for a grammar it does not have.
 */
it("refuses uploaded assets on a binary below the 1.4.0 upload grammar", async () => {
  // The default fake reports 0.20.0: above the floor, below the upload grammar.
  const { bin, log } = createFakeBin();
  const failure = await createCliEngine({ bin }).edit({ name: "doc.hwpx", data: new Uint8Array([1]) }, [
    { kind: "insert-image", anchor: "x", path: "client.png" },
  ], { assets: [{ name: "client.png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }] })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ reason: "version" });
  expect((failure as Error).message).toContain("hwp 0.20.0 has no image asset uploads");
  expect((failure as Error).message).toContain("upgrade hwp-cli to 1.4.0 or newer");
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
