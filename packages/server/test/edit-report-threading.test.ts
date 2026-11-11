/**
 * The report half of the components palette, against the real binary.
 *
 * `insert_blocks` is the only op that creates segments, and `edit-report-v1`
 * is the only place the engine names them. This suite proves the loop the
 * palette depends on — compose a base, insert blocks with `report: true`, read
 * the ids back, then address them with `move_para` and `delete_para` — because
 * a stub cannot show that the ids survive from one invocation to the next.
 *
 * Two engine behaviours the panel must respect, both measured here on ahwp
 * 1.6.0 rather than assumed:
 *
 * - A move re-keys its target. `changed` reports `before -> after` for the
 *   addressed paragraph (`cf1c...0.2 -> cf1c...0.1`), and the paragraph it
 *   displaced gets a new id too, which the report does not list. So a
 *   selection has to be re-keyed from each op's own pairs before the next op
 *   addresses it, never carried over.
 * - A batch in which every op fails publishes no document at all (exit 1),
 *   `--allow-partial` or not. Only a partly-applied batch returns a report
 *   carrying a failed outcome.
 *
 * Skipped when no runnable hwp is installed, exactly like `components.test.ts`.
 */
import { expect, it } from "vitest";
import { insertedParagraphIds, type Blocks, type DocumentSpecV2 } from "@hwp-editor/core";
import { createCliEngine } from "../src/cli-engine.js";
import { BIN, describeBin, sampleSpec } from "./helpers.js";

const engine = createCliEngine({ bin: BIN, timeoutMs: 60_000 });

const BLOCKS: Blocks = [
  { type: "paragraph", runs: [{ type: "text", text: "구성 요소 1" }] },
  { type: "paragraph", runs: [{ type: "text", text: "구성 요소 2" }] },
];

const insertAfter = (position: "before" | "after") => ({
  kind: "insert-blocks" as const,
  address: { at: { section: 0, paragraph: 0 } },
  position,
  blocks: BLOCKS,
});

async function base() {
  const composed = await engine.compose(sampleSpec() as unknown as DocumentSpecV2, "base.hwpx");
  return composed.document;
}

describeBin("edit-report threading (real hwp)", () => {
  it("returns no report when the caller does not ask for one", async () => {
    const document = await base();
    const edited = await engine.edit(document, [insertAfter("after")], {});
    expect(edited.report).toBeUndefined();
    expect(edited.data.byteLength).toBeGreaterThan(0);
  });

  it("names the inserted paragraphs and keeps them addressable for reorder and remove", async () => {
    const document = await base();
    const inserted = await engine.edit(document, [insertAfter("after")], { report: true });
    const outcome = inserted.report?.ops[0];
    expect(outcome?.op).toBe("insert_blocks");
    expect(outcome?.status).toBe("applied");
    const ids = insertedParagraphIds(outcome!);
    expect(ids).toHaveLength(BLOCKS.length);

    // Reorder: move the second inserted paragraph above the first, by id.
    const [first, second] = ids;
    const moved = await engine.edit(
      inserted,
      [{
        kind: "move-para",
        address: { id: second! },
        to: { address: { id: first! }, position: "before" },
      }],
      { report: true },
    );
    const move = moved.report?.ops[0];
    expect(move?.status).toBe("applied");
    const rekeyed = move?.changed.find(pair => pair.before === second)?.after;
    expect(rekeyed).toBeDefined();
    expect(rekeyed).not.toBe(second);

    // Remove by the id the move published, not the one the insert did: the old
    // id is stale and a drift-checked address would refuse it.
    const removed = await engine.edit(moved, [{ kind: "delete-para", address: { id: rekeyed! } }], {
      report: true,
    });
    expect(removed.report?.ops[0]?.status).toBe("applied");
    expect(removed.report?.ops[0]?.pieces_touched).toBeGreaterThan(0);
  });

  it("reports a failed op without inventing inserted ids", async () => {
    const document = await base();
    // One op that applies and one that cannot: an all-failed batch publishes
    // nothing, so a report with a failed outcome requires a published edit.
    // The insert goes `after` paragraph 0 on purpose — paragraph 0 of a
    // section is its definition paragraph, and the engine refuses an insertion
    // before it ("구역 정의 문단 앞에는 삽입할 수 없습니다").
    const edited = await engine.edit(
      document,
      [insertAfter("after"), { kind: "delete-para", text: "존재하지 않는 문단" }],
      { report: true, allowPartial: true },
    );
    const [inserted, failed] = edited.report?.ops ?? [];
    expect(inserted?.status).toBe("applied");
    expect(failed?.status).toBe("failed");
    expect(failed?.reason).toBe("delete_para: no match");
    expect(insertedParagraphIds(failed!)).toEqual([]);
    expect(insertedParagraphIds(inserted!)).toHaveLength(BLOCKS.length);
    expect(edited.data.byteLength).toBeGreaterThan(0);
  });
});
