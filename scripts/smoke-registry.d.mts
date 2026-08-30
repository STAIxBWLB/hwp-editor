/**
 * Types for the pure assertions `scripts/smoke-registry.mjs` exports.
 *
 * This file exists because `packages/server/test/release-guards.test.ts` imports
 * those assertions and `pnpm -r typecheck`, the repository's primary static
 * gate, rejects an untyped `.mjs` import under `strict` (TS7016). The script
 * itself stays plain JavaScript so it can be run with bare `node`, as its two
 * siblings in this directory are.
 *
 * Only the exported surface is declared. The stage bodies sit behind an
 * entry-module guard and are unreachable from an import.
 */

/** Prefix of every scratch directory the script creates. */
export declare const SCRATCH_PREFIX: string;

/** The core peer range a react or server manifest published at `version` carries. */
export declare function expectedPeerRange(version: string): string;

/** Number of `@hwp-editor/core/package.json` files anywhere under `dir`. */
export declare function countCoreCopies(dir: string): number;

/** Throws unless `declaredRange` is exactly `expectedRange`. */
export declare function assertResolvedPeer(
  packageName: string,
  declaredRange: string | undefined,
  expectedRange: string,
): void;
