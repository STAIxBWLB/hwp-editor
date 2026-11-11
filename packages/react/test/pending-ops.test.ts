import { describe, expect, it } from "vitest";
import type { EditOp } from "@hwp-editor/core";
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
  });

  it("keeps a run and a character range readable", () => {
    expect(pendingAddressLabel({ at: { section: 1, paragraph: 2, run: 4 } }, t))
      .toBe(messages["pending.target.run"]({ section: 1, paragraph: 2, run: 4 }));
    // A range op addresses a paragraph or a run by id and carries the WCHAR
    // window separately, so the window reads on top of whichever one it is.
    expect(pendingAddressLabel({ id: "r7", chars: [2, 5] }, t))
      .toBe(messages["pending.target.chars"]({
        range: messages["pending.target.id"]({ id: "r7" }),
        start: 2,
        end: 5,
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

  it("names a table by the number the table panel shows", () => {
    expect(pendingTargetLabel({ kind: "delete-table", target: 2 }, t))
      .toBe(messages["table.tableLabel"]({ index: 2 }));
  });
});
