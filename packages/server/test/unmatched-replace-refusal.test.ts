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
 * The stderr below is the line hwp-cli v1.4.0 writes (ahwp 1.6.0 prints the
 * same one) for a `replace` whose find occurs nowhere in the addressed
 * paragraph, with `--verify` on so nothing is applied.
 */
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { EditOp } from "@hwp-editor/core";

import { createCliEngine, HwpCliError } from "../src/cli-engine.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";

afterEach(disposeFakeBins);

const UNMATCHED =
  "Error: 적용되지 않은 편집 요청이 있습니다: " +
  'replace address=0.1 from="없는 텍스트" to="{{owner}}" ' +
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
    const error = await failure('Error: replace address=0.1 (boom)');

    expect(error.message).toBe("hwp edit failed (exit 3)");
  });

  it("does not call a mixed unapplied list an unmatched replace (t14-g8)", async () => {
    // The same line carries every unapplied op: set_field, create_field,
    // delete_image and the rest. Measured on hwp-cli v1.4.0 with one missing
    // `from` and one unknown field name in a verified batch. Telling a user
    // whose field edit missed to select the text again is a wrong remedy.
    const error = await failure(
      "Error: 적용되지 않은 편집 요청이 있습니다: " +
      'replace address=0.0 from="NOPE" to="x", set_field name="missing_field" ' +
      "(--allow-partial로 일치한 요청만 적용 가능)",
    );

    expect(error.message).toBe("hwp edit failed (exit 3)");
    expect(error.message).not.toContain("unmatched_replace");
  });

  it("keeps a mixed list whose value holds the closing suffix (#72)", async () => {
    // The engine closes the list with "(--allow-partial...", and a find text may
    // carry that same text. Ending the list at its first occurrence cuts the
    // item in half and swallows the separator, so a batch with a missed
    // `replace` and a missed `set_field` reads as one replace and sends the
    // user whose field edit missed the wrong remedy.
    const error = await failure(
      "Error: 적용되지 않은 편집 요청이 있습니다: " +
      'replace address=0.0 from="see (--allow-partial in the help)" to="x", ' +
      'set_field name="missing_field" ' +
      "(--allow-partial로 일치한 요청만 적용 가능)",
    );

    expect(error.message).toBe("hwp edit failed (exit 3)");
    expect(error.message).not.toContain("unmatched_replace");
  });

  it("still classifies a find text that carries a comma of its own", async () => {
    // Items are comma separated and a quoted value may hold one, so the split
    // respects double quotes rather than counting separators.
    const error = await failure(
      "Error: 적용되지 않은 편집 요청이 있습니다: " +
      'replace address=0.1 from="Kim, Lee" to="{{owner}}" ' +
      "(--allow-partial로 일치한 요청만 적용 가능)",
    );

    expect(error.message).toBe("hwp edit failed (exit 3): edit refused: unmatched_replace");
  });

  it("splits an item whose value holds a Debug-escaped quote (t14-g14)", async () => {
    // The values are written with Rust's `{:?}`, so an inner quote arrives as
    // `\"`. Counting every `"` ends the quoted stretch early and swallows the
    // separator, which reads a mixed list as one replace and sends a user whose
    // field edit missed the wrong remedy.
    const error = await failure(
      "Error: 적용되지 않은 편집 요청이 있습니다: " +
      'replace address=0.0 from="NOPE" to="{{a\\"b}}", set_field name="missing_field" ' +
      "(--allow-partial로 일치한 요청만 적용 가능)",
    );

    expect(error.message).toBe("hwp edit failed (exit 3)");
    expect(error.message).not.toContain("unmatched_replace");
  });
});
