import { describe, expect, it } from "vitest";
import { imageAssetMediaType, imageAssetsMatchOps, validateImageAssets } from "../src/assets.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0, 0]);

describe("image assets", () => {
  it("identifies PNG and JPEG from signatures and requires matching safe names", () => {
    expect(imageAssetMediaType(png)).toBe("image/png");
    expect(imageAssetMediaType(jpeg)).toBe("image/jpeg");
    expect(imageAssetMediaType(new Uint8Array([1, 2, 3]))).toBeNull();
    validateImageAssets([{ name: "diagram.png", data: png }, { name: "photo.JPEG", data: jpeg }]);
    expect(() => validateImageAssets([{ name: "diagram.jpg", data: png }])).toThrow(/does not match/);
  });

  it.each([
    { assets: [{ name: "../photo.png", data: png }] },
    { assets: [{ name: "photo..png", data: png }] },
    { assets: [{ name: "photo.svg", data: png }] },
    { assets: [{ name: "photo.png", data: new Uint8Array() }] },
    { assets: [{ name: "photo.png", data: new Uint8Array([1, 2, 3]) }] },
  ])("rejects malformed assets", ({ assets }) => {
    expect(() => validateImageAssets(assets)).toThrow();
  });

  it("rejects duplicate names, more than eight files, and oversized individual files", () => {
    expect(() => validateImageAssets([{ name: "a.png", data: png }, { name: "a.png", data: png }])).toThrow(/duplicate/);
    expect(() => validateImageAssets(Array.from({ length: 9 }, (_, i) => ({ name: `a${i}.png`, data: png })))).toThrow(/at most 8/);
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set(png.subarray(0, 8));
    expect(() => validateImageAssets([{ name: "large.png", data: oversized }])).toThrow(/exceeds/);
  });
});

it("enforces aggregate bytes and never echoes unsafe names", () => {
  expect.assertions(3);
  const image = new Uint8Array(9 * 1024 * 1024); image.set(png.subarray(0,8));
  expect(() => validateImageAssets(Array.from({length:5},(_,index)=>({name:`image-${index}.png`,data:image})))).toThrow(/bytes total/);
  try { validateImageAssets([{name:"/private/input.png",data:png}]); } catch(error) {
    expect((error as Error).message).not.toContain("/private/");
    expect((error as Error).message).toContain("upload PNG/JPEG");
  }
});

it("matches uploaded names exactly while permitting repeated insertions", () => {
  const op = { kind: "insert-image" as const, anchor: "x", path: "a.png" };
  expect(imageAssetsMatchOps([op, op], [{ name: "a.png" }])).toBe(true);
  expect(imageAssetsMatchOps([], [])).toBe(true);
  expect(imageAssetsMatchOps([op], [])).toBe(false);
  expect(imageAssetsMatchOps([], [{ name: "a.png" }])).toBe(false);
  expect(imageAssetsMatchOps([op], [{ name: "b.png" }])).toBe(false);
  expect(imageAssetsMatchOps([op, { ...op, path: "b.png" }], [{ name: "a.png" }, { name: "a.png" }])).toBe(false);
});
