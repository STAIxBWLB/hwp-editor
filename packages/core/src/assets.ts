import { HwpEngineError } from "./errors.js";
import type { ImageAsset } from "./engine.js";
import type { EditOp } from "./ops.js";

export const MAX_IMAGE_ASSETS = 8;
export const MAX_IMAGE_ASSET_BYTES = 10 * 1024 * 1024;
/**
 * The per-image bound in the unit the strings say it in. Derived rather than
 * written twice: a message table that hardcoded "10 MiB" kept saying ten after
 * the byte bound moved.
 */
export const MAX_IMAGE_ASSET_MIB = MAX_IMAGE_ASSET_BYTES / (1024 * 1024);
export const MAX_IMAGE_ASSETS_TOTAL_BYTES = 40 * 1024 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Identify an image by its bytes, never by a caller supplied MIME header. */
export function imageAssetMediaType(data: Uint8Array): "image/png" | "image/jpeg" | null {
  if (data.length >= PNG.length && PNG.every((byte, i) => data[i] === byte)) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

function invalid(message: string): never {
  throw new HwpEngineError("bad_request", `${message}; upload PNG/JPEG images with safe unique filenames within the size limits.`);
}

/** Validate a bounded set of safely named, signature-checked image assets. */
export function validateImageAssets(assets: readonly ImageAsset[]): void {
  if (!Array.isArray(assets)) invalid("image assets must be an array");
  if (assets.length > MAX_IMAGE_ASSETS) invalid(`at most ${MAX_IMAGE_ASSETS} image assets are allowed`);
  let total = 0;
  const names = new Set<string>();
  for (const asset of assets) {
    if (asset === null || typeof asset !== "object" || typeof asset.name !== "string" || !(asset.data instanceof Uint8Array)) {
      invalid("each image asset requires a name and Uint8Array data");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(asset.name) || asset.name.includes("..")) {
      invalid("image asset name must be a safe basename of at most 128 ASCII characters");
    }
    if (names.has(asset.name)) invalid("duplicate image asset names are not allowed");
    names.add(asset.name);
    if (!/[.](png|jpe?g)$/i.test(asset.name)) invalid("image asset extension must be png, jpg or jpeg");
    if (asset.data.length === 0) invalid("image asset data must not be empty");
    if (asset.data.length > MAX_IMAGE_ASSET_BYTES) invalid(`image asset exceeds ${MAX_IMAGE_ASSET_BYTES} bytes`);
    total += asset.data.length;
    if (total > MAX_IMAGE_ASSETS_TOTAL_BYTES) invalid(`image assets exceed ${MAX_IMAGE_ASSETS_TOTAL_BYTES} bytes total`);
    const mediaType = imageAssetMediaType(asset.data);
    if (mediaType === null) invalid("image asset data is not PNG or JPEG");
    if ((asset.name.toLowerCase().endsWith(".png")) !== (mediaType === "image/png")) {
      invalid("image asset extension does not match its contents");
    }
  }
}

/** Every uploaded name must be referenced, and every insertion must name an upload. */
export function imageAssetsMatchOps(ops: readonly EditOp[], assets: readonly Pick<ImageAsset, "name">[]): boolean {
  const refs = new Set(ops.filter(op => op?.kind === "insert-image").map(op => op.path));
  const names = new Set(assets.map(asset => asset.name));
  return refs.size === assets.length && [...refs].every(name => names.has(name));
}
