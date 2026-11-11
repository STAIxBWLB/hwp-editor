/**
 * The cause of a zero-match `replace` refusal, carried across the CLI boundary.
 *
 * `hwp edit --verify` applies nothing when one of the requested edits did not
 * match, and says so in one Korean sentence that also names the staged
 * document and the offending find text. Neither is a contract the editor can
 * read, so `cli-engine` classifies the refusal to the one stable marker the
 * client's string table knows: `unmatched_replace`. These cases pin both
 * halves of that rule — the marker crosses, the prose does not.
 *
 * The stderr below is the line ahwp 1.6.0 writes (measured with `--verify` on
 * a `replace` whose find occurs nowhere in the addressed paragraph).
 */
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { EditOp } from "@hwp-editor/core";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";

afterEach(disposeFakeBins);

const UNMATCHED =
  "Error: 적용되지 않은 편집 요청이 있습니다: " +
  'replace address={"at":{"section":0,"paragraph":1}} from="없는 텍스트" to="{{owner}}" ' +
  "(--allow-partial로 일치한 요청만 적용 가능)";

const REPLACE: EditOp[] = [{
  kind: "replace",
  address: { at: { section: 0, paragraph: 1 } },
  find: "없는 텍스트",
  replace: "{{owner}}",
}];

const document = { name: "sample.hwpx", data: new Uint8Array([1, 2, 3]) };

/** The refusal a failed edit raised, or a thrown assertion when it succeeded. */
async function failure(stderr: string): Promise<HwpCliError> {
  const { bin } = createFakeBin({ info: "{}", mode: "fail", editStderr: stderr });
  const error = await createCliEngine({ bin }).edit(document, REPLACE).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(HwpCliError);
  const cliError = error as HwpCliError;
  expect(cliError.reason).toBe("failed");
  return cliError;
}

describe("unmatched replace refusal classification", () => {
  it("carries the stable marker instead of the engine's own sentence", async () => {
    const error = await failure(UNMATCHED);

    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: unmatched_replace");
    // What must not cross: the Korean sentence, the find text and the staged
    // path. The editor maps the marker onto its own localized sentence.
    expect(error.message).not.toContain("적용되지 않은");
    expect(error.message).not.toContain("없는 텍스트");
    expect(error.message).not.toContain(tmpdir());
    // The verbatim line survives on detail, for an operator, not the wire.
    expect(error.stderr).toBe(UNMATCHED);
    expect(error.detail).toContain("없는 텍스트");
  });

  it("leaves a failure that is not the zero-match one on the bare exit line", async () => {
    // The marker is one sentence, not the whole `failed` class: any other
    // refusal keeps the exit line it had before this classifier existed.
    const error = await failure('Error: replace address={"at":{"section":0,"paragraph":1}} (boom)');

    expect(error.message).toBe("hwp edit failed (exit 3)");
  });
});
