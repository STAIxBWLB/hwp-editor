import { describe, expect, it } from "vitest";
import type { CatEnvelope, EditOp } from "@hwp-editor/core";
import { createT, en, ko } from "../src/messages.js";
import {
  PENDING_KIND_KEYS,
  pendingAddressLabel,
  pendingKindKey,
  pendingTargetLabel,
} from "../src/pending-ops.js";

/**
 * The pending list's own text (issue #46 AC10, deferred here by T1).
 *
 * A queued row is read by a person deciding what to remove, so it names the
 * operation in their language and the target in the engine's own indices. What
 * this suite pins is exactly what T1 left raw: the op kind and the address,
 * neither of which may reach the list as an identifier or as JSON.
 */
describe.each([["en", en], ["ko", ko]] as const)("pending row text (%s)", (locale, messages) => {
  const t = createT(locale, {});

  it("names every op kind in the locale's own words", () => {
    for (const [kind, key] of Object.entries(PENDING_KIND_KEYS)) {
      // A key that names no message would print the key itself, so a row's
      // first half is proven to resolve to a sentence, not to an identifier.
      expect(typeof messages[key]).toBe("string");
      expect(t(pendingKindKey(kind as EditOp["kind"]))).toBe(messages[key]);
      expect(t(pendingKindKey(kind as EditOp["kind"]))).not.toBe(kind);
    }
  });

  it("prints an at address in the engine's indices, never as JSON", () => {
    const label = pendingAddressLabel({ at: { section: 0, paragraph: 3 } }, t);
    expect(label).toBe(messages["pending.target.at"]({ section: 0, paragraph: 3 }));
    expect(label).not.toContain("{");
    // Engine indices are 0-based while other labels in the editor are 1-based,
    // so a row has to say which base it prints (#58 item 26).
    expect(label).toContain(locale === "en" ? "0-based" : "0 기준");
  });

  it("keeps a run and a character range readable", () => {
    expect(pendingAddressLabel({ at: { section: 1, paragraph: 2, run: 4 } }, t))
      .toBe(messages["pending.target.run"]({ section: 1, paragraph: 2, run: 4 }));
    // A range op addresses a paragraph or a run by id and carries the WCHAR
    // window separately, so the window reads on top of whichever one it is.
    const range = pendingAddressLabel({ id: "r7", chars: [2, 5] }, t);
    expect(range)
      .toBe(messages["pending.target.chars"]({
        range: messages["pending.target.id"]({ id: "r7" }),
        start: 2,
        end: 5,
      }));
    // The window is half-open, counted in UTF-16 code units of the source
    // paragraph, and 0-based; the row states all three before #71 emits one.
    expect(range).toContain(locale === "en" ? "0-based UTF-16" : "0 기준 UTF-16");
    expect(range).toContain(locale === "en" ? "end excluded" : "끝 제외");
  });

  it("says a set-format row with no window formats the whole run", () => {
    // A range op that names only the id formats every character of the run
    // (edit-ops-v1), so its row cannot read like a paragraph target: the
    // reader dropping it from the queue has to know the whole run goes with
    // the selection.
    expect(pendingTargetLabel({ kind: "set-format", address: { id: "r7" }, props: { bold: "on" } }, t))
      .toBe(messages["pending.target.wholeRun"]({ id: "r7" }));
    // With a source window the row names the window, as before.
    expect(pendingTargetLabel({ kind: "set-format", address: { id: "r7", chars: [2, 5] }, props: { bold: "on" } }, t))
      .toBe(messages["pending.target.chars"]({
        range: messages["pending.target.id"]({ id: "r7" }), start: 2, end: 5,
      }));
    // The rule belongs to set-format alone: another op that addresses the same
    // id edits the segment the id names, whatever its length.
    expect(pendingTargetLabel({ kind: "delete-para", address: { id: "p1" } }, t))
      .toBe(messages["pending.target.id"]({ id: "p1" }));
    // A legacy set-format names its text to find, which is also no window.
    expect(pendingTargetLabel({ kind: "set-format", find: "굵게", props: { bold: "on" } }, t)).toBe("굵게");
  });

  it("says a window that is one split piece in full formats the whole piece", () => {
    // The pieces of a run a block control interrupts share one id and one
    // path, and an op naming the id alone would format both, so each piece is
    // addressed by its own source span (the engine's shape: "앞" (0, 1) and
    // "뒤" (9, 11), with the control's 8 units between them). That window is
    // the piece, whole, and the row has to say so - the op shape says nothing,
    // because a window that mapped character for character looks the same.
    const plain = {
      bold: false, italic: false, size_pt: 10, color: "#000000",
      faces: [null, null, null, null, null, null, null], face_ids: [0, 0, 0, 0, 0, 0, 0],
    };
    const envelope: CatEnvelope = {
      markdown: "앞|뒤\n",
      segments: [
        { id: "p", indices: [0], start: 0, end: 4, kind: "para", section: 0, para: 0 },
        { id: "split", indices: [0, 0], start: 0, end: 1, kind: "run", section: 0, para: 0,
          directChar: plain, sourceChars: { start: 0, end: 1 } },
        { id: "split", indices: [0, 0], start: 2, end: 3, kind: "run", section: 0, para: 0,
          directChar: plain, sourceChars: { start: 9, end: 11 } },
      ],
    };
    const wholePiece = { kind: "set-format" as const, address: { id: "split", chars: [9, 11] as [number, number] }, props: { bold: "on" as const } };
    expect(pendingTargetLabel(wholePiece, t, {}, envelope))
      .toBe(messages["pending.target.wholePiece"]({ id: "split" }));
    // A window inside the piece is a window, and says which characters it
    // edits.
    expect(pendingTargetLabel({ ...wholePiece, address: { id: "split", chars: [9, 10] } }, t, {}, envelope))
      .toBe(messages["pending.target.chars"]({
        range: messages["pending.target.id"]({ id: "split" }), start: 9, end: 10,
      }));
    // Without the document a window cannot be told from a whole piece, so the
    // row shows the window rather than guessing.
    expect(pendingTargetLabel(wholePiece, t)).toBe(messages["pending.target.chars"]({
      range: messages["pending.target.id"]({ id: "split" }), start: 9, end: 11,
    }));
    // A run nobody split has no pieces, so a window equal to its whole span is
    // that run's own window and the row reads as a window: the "whole piece"
    // reading belongs to an id a sibling shares, which is what makes an op
    // naming the id alone format more than the window.
    const unsplit: CatEnvelope = {
      markdown: "굵게\n",
      segments: [
        { id: "p2", indices: [1], start: 0, end: 3, kind: "para", section: 0, para: 1 },
        { id: "solo", indices: [1, 0], start: 0, end: 2, kind: "run", section: 0, para: 1,
          directChar: plain, sourceChars: { start: 0, end: 2 } },
      ],
    };
    expect(pendingTargetLabel({ kind: "set-format", address: { id: "solo", chars: [0, 2] },
      props: { bold: "on" } }, t, {}, unsplit))
      .toBe(messages["pending.target.chars"]({
        range: messages["pending.target.id"]({ id: "solo" }), start: 0, end: 2,
      }));
  });

  it("resolves a style row and a metadata key through the tables that own them", () => {
    expect(pendingTargetLabel({ kind: "update-style", style: 3 }, t, { style: () => "바탕글" }))
      .toBe("바탕글");
    // Reuses the document panel's labels rather than a second copy.
    expect(pendingTargetLabel({ kind: "set-meta", key: "author", value: "me" }, t))
      .toBe(messages["document.metaAuthor"]);
    expect(pendingTargetLabel({ kind: "set-page", key: "margin-left", value: "20mm" }, t))
      .toBe(messages["document.page.marginLeft"]);
  });

  it("names the second target an op carries beside its address", () => {
    // A row that showed only the address would name half of what the op does:
    // which text a replace looks for, which side of the paragraph blocks land
    // on, and where a move puts the paragraph.
    expect(pendingTargetLabel(
      { kind: "replace", address: { id: "p3" }, find: "회의", replace: "미팅" }, t,
    )).toBe(messages["pending.target.replaceFind"]({
      find: "회의", range: messages["pending.target.id"]({ id: "p3" }),
    }));
    expect(pendingTargetLabel({
      kind: "insert-blocks", address: { id: "p3" }, position: "after",
      blocks: [{ type: "paragraph", runs: [{ type: "text", text: "블록" }] }],
    }, t)).toBe(messages["pending.target.after"]({
      range: messages["pending.target.id"]({ id: "p3" }),
    }));
    expect(pendingTargetLabel({
      kind: "move-para", address: { id: "p3" },
      to: { address: { id: "p1" }, position: "before" },
    }, t)).toBe(messages["pending.target.moveTo"]({
      range: messages["pending.target.id"]({ id: "p3" }),
      destination: messages["pending.target.id"]({ id: "p1" }),
      before: true,
    }));
  });

  it("names a table by the engine's index, which the row states as a base", () => {
    // The table panel shows the reader's ordinal from one; a queued row has to
    // match the number the op carries and an engine refusal reports, so it
    // keeps the engine's index and says which base it is counting from. Both
    // shapes reach it: a `table` coordinate and a `delete-table` target.
    expect(pendingTargetLabel({ kind: "delete-table", target: 2 }, t))
      .toBe(messages["pending.target.table"]({ index: 2 }));
    expect(pendingTargetLabel({ kind: "delete-row", table: 0, row: 1 }, t))
      .toBe(messages["pending.target.table"]({ index: 0 }));
  });
});
