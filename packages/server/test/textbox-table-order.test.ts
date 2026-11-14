/**
 * A table inside a text box takes the same index in the `cat --segments v2`
 * table segments as in the engine's nth-table walk (`walk_nth_table_root`)
 * (#119 item 2, from #130 item 3).
 *
 * `tableCountMismatch` lets index-addressed table ops through when the two
 * counts agree. Equal counts prove alignment only when both orders match, and
 * a text-box table was the one case nobody had checked. The fixture is a
 * genuine document (see fixtures/textbox-table.NOTICE.md) with nine body
 * tables, then a text box holding a table, then one more table after the box.
 * For each engine index this suite writes a marker into cell 0:0 with
 * `--set-cell` and asserts that the innermost published table enclosing the
 * marker is the table at that same published index.
 *
 * Measured on ahwp 2.0.0: indices 0-10 all match, with the text-box table at
 * 9 in both orders. Skipped when no runnable hwp is installed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import {
  publishedTableCount,
  segmentText,
  tableCountMismatch,
  type CatEnvelope,
  type Segment,
} from "@hwp-editor/core";

import { createCliEngine } from "../src/cli-engine.js";
import { BIN, describeBin } from "./helpers.js";

const engine = createCliEngine({ bin: BIN, timeoutMs: 60_000 });

const document = {
  name: "textbox-table.hwpx",
  data: new Uint8Array(
    readFileSync(fileURLToPath(new URL("./fixtures/textbox-table.hwpx", import.meta.url))),
  ),
};

/** Index of the text-box table among the published table segments. */
const TEXT_BOX_TABLE = 9;

const tables = (envelope: CatEnvelope): Segment[] =>
  envelope.segments.filter((segment) => segment.kind === "table");

const isPrefix = (prefix: number[], path: number[]): boolean =>
  prefix.length <= path.length && prefix.every((n, i) => path[i] === n);

/** Published index of the innermost table enclosing the paragraph holding `marker`. */
function tableHolding(envelope: CatEnvelope, marker: string): number | undefined {
  let deepest: number[] | undefined;
  for (const segment of envelope.segments) {
    if (segment.kind !== "para" || segment.indices === undefined) continue;
    if (!segmentText(envelope, segment).includes(marker)) continue;
    if (deepest === undefined || segment.indices.length > deepest.length) deepest = segment.indices;
  }
  if (deepest === undefined) return undefined;
  let best: number | undefined;
  let bestDepth = -1;
  tables(envelope).forEach((table, index) => {
    const path = table.indices ?? [];
    if (!isPrefix(path, deepest) || path.length <= bestDepth) return;
    best = index;
    bestDepth = path.length;
  });
  return best;
}

describeBin("text-box table order (real hwp, #119 item 2)", () => {
  it("publishes a table inside the text box, between body tables, with agreeing counts", async () => {
    const read = await engine.read(document);
    const published = tables(read);
    expect(published).toHaveLength(11);
    expect(read.bodyTables).toBe(11);
    expect(publishedTableCount(read)).toBe(11);
    expect(tableCountMismatch(read)).toBeNull();
    // Paragraph 50's control 0 is the text box (hp:drawText); its paragraph 1
    // holds the table. No published table encloses it, so it is not a cell's.
    expect(published[TEXT_BOX_TABLE]?.indices).toEqual([50, 0, 1, 0]);
    expect(
      published.some(
        (table, index) => index !== TEXT_BOX_TABLE && isPrefix(table.indices ?? [], [50, 0, 1, 0]),
      ),
    ).toBe(false);
    expect(published[TEXT_BOX_TABLE + 1]?.indices).toEqual([51, 0]);
  });

  it("edits the table at the same position the cat order gives it, for every index", async () => {
    for (let index = 0; index < 11; index++) {
      const marker = `ZZMARK${index}Z`;
      const edited = await engine.edit(document, [
        { kind: "set-cell", table: index, row: 0, col: 0, value: marker },
      ]);
      const read = await engine.read({ name: document.name, data: edited.data });
      expect(tableHolding(read, marker), `engine table ${index}`).toBe(index);
    }
  }, 120_000);
});
