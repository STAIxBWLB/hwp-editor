/**
 * The two localization boundaries the palette owns, tested directly rather
 * than through the DOM so every branch of the sentence has an assertion.
 *
 * - An `insert_blocks` width refusal becomes a sentence naming the widths the
 *   failure measured. Three of them exist because the numbers arrive
 *   independently: the server summary carries both, a host wired in process
 *   carries the engine's body width but not the block's, and a refusal with
 *   neither is still a sentence a user can act on. A blank where a width
 *   belongs is the bug this pins against.
 * - The server's two other `insert_blocks` classes — a style the document
 *   lacks, and a definition the engine rejected without naming a field — each
 *   become their own sentence, in both locales, with the engine's classified
 *   tail left on `detail`.
 * - A `ComponentError` becomes a whole sentence in the user's locale, next
 *   step included, while the engine-side English reason survives on `detail`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyInsertionRefusal,
  ComponentError,
  createHttpEngine,
  HwpEngineError,
  NO_ENGINE_CAUSE,
  STOPPED_WITHOUT_DIAGNOSTIC,
} from "@hwp-editor/core";
import type { Blocks, ComponentErrorCode, InsertionRefusal, List } from "@hwp-editor/core";

import { classifiedRefusalMessage, componentFailure, insertionFailure, listEngineRefusal } from "../src/components-support.js";
import { createT } from "../src/messages.js";
import type { MessageKey } from "../src/messages.js";

const en = createT("en");
const ko = createT("ko");

/** A 120 mm table: the widest block the component would insert. */
const WIDE: Blocks = [{
  type: "table",
  width_mm: 120,
  columns: [{ width_mm: 60 }, { width_mm: 60 }],
  rows: [{ cells: [{ blocks: [{ type: "paragraph", runs: [{ type: "text", text: "결재" }] }] }] }],
}];

/** Blocks that carry no measurable width at all. */
const UNMEASURED: Blocks = [{ type: "paragraph", runs: [{ type: "text", text: "붙임" }] }];

/** What the CLI server's classification puts in the message (no paths). */
const serverSummary = (widths: boolean): string =>
  `ahwp edit failed (exit 1): insert_blocks refused: layout_overflow${widths
    ? " (block 120 mm, insertion point 46.4 mm)"
    : ""}`;

/** The engine's own text when a host runs in process: body width, no block width. */
const engineText =
  "Error: insert_blocks 블록/스타일/목록 정의가 유효하지 않습니다: layout_overflow at " +
  "$.sections[0].blocks[0].width_mm: table width exceeds body width 46.40 mm. " +
  "DocumentSpec v1 정의를 수정한 뒤 다시 시도하세요 (삽입 위치의 폭은 46.4mm입니다)";

/**
 * A failure as a transport delivers it: the message for a log, and the class
 * in the structured `insertion` field (#88), which is all the palette reads.
 */
function refused(message: string, insertion?: InsertionRefusal): HwpEngineError {
  return new HwpEngineError("failed", message, { status: 422, ...(insertion === undefined ? {} : { insertion }) });
}
const overflow = (message: string, insertion: InsertionRefusal = classifyInsertionRefusal(engineText)!): HwpEngineError =>
  refused(message, insertion);

describe("insertionFailure", () => {
  it.each([en, ko])("prefers typed engine widths over legacy block fallback and never reads prose", (t) => {
    const error = new HwpEngineError("failed", "block 999 mm, insertion point 998 mm", {
      insertion: { kind: "layout_overflow", blockMm: 240.5, insertionMm: 46.4 }, status: 422,
    });
    const expected = t("components.tooWide", { width: "240.5 mm", available: "46.4 mm" });
    expect(classifiedRefusalMessage(error, t)).toBe(expected);
    const shown = insertionFailure(error, WIDE, t) as HwpEngineError;
    expect(shown.message).toBe(expected);
    expect(shown.insertion).toEqual(error.insertion);
    expect(shown.status).toBe(422);
    expect(shown.cause).toBe(error);

    const legacy = new HwpEngineError("failed", "block 999 mm", { insertion: { kind: "layout_overflow" } });
    expect(classifiedRefusalMessage(legacy, t)).toBe(t("components.tooWideUnknown"));
    expect(classifiedRefusalMessage(legacy, t, WIDE)).toBe(t("components.tooWideUnmeasured", { width: "120 mm" }));
    expect(classifiedRefusalMessage(new HwpEngineError("failed", error.message), t)).toBeUndefined();
  });

  describe.each([en, ko])("structured refusal localization (#119)", (t) => {
    it.each([
      ["keep_together_unsupported", "error.keepTogetherUnsupported"],
      ["section_owner", "error.sectionOwner"],
      ["anchor_not_found", "error.anchorNotFound"],
      ["font_type_info", "error.fontTypeInfo"],
      ["preservation_loss", "error.preservationLoss"],
      ["unapplied_requests", "error.unappliedRequests"],
      ["no_applicable_edits", "error.noApplicableEdits"],
      ["unclassified_refusal", "error.unclassifiedRefusal"],
    ] as const)("uses %s's own cause and action on immediate insertion", (refusal, key) => {
      const error = new HwpEngineError("failed", "untrusted prose mentions a different refusal", {
        refusal, status: 422, insertion: { kind: "invalid_definition" }, stopped: true, noCause: true,
      });
      const shown = insertionFailure(error, UNMEASURED, t) as HwpEngineError & { detail?: string };
      expect(shown.message).toBe(t(key));
      expect(shown.refusal).toBe(refusal);
      expect(shown.code).toBe("failed");
      expect(shown.status).toBe(422);
      expect(shown.insertion).toEqual({ kind: "invalid_definition" });
      expect(shown.stopped).toBe(true);
      expect(shown.noCause).toBe(true);
      expect(shown.cause).toBe(error);
      expect(shown.detail).toBe(error.message);
    });
  });

  it.each([en, ko])("keeps output-validation remedies on an immediate insertion (#171)", (t) => {
    const error = new HwpEngineError("failed", "ahwp edit failed (exit 1): edit refused: output_validation", {
      refusal: "output_validation", status: 422,
    });
    const shown = insertionFailure(error, UNMEASURED, t) as HwpEngineError & { detail?: string };
    expect(shown.message).toBe(t("error.outputValidation"));
    expect(shown.refusal).toBe("output_validation");
    expect(shown.code).toBe("failed");
    expect(shown.status).toBe(422);
    expect(shown.cause).toBe(error);
    expect(shown.detail).toBe(error.message);
  });

  it("does not choose output-validation remedies from an unclassified message (#171)", () => {
    const error = new HwpEngineError("failed", "ahwp edit failed (exit 1): edit refused: output_validation");
    const shown = insertionFailure(error, UNMEASURED, en) as HwpEngineError;
    expect(shown.message).not.toBe(en("error.outputValidation"));
    expect(shown.refusal).toBeUndefined();
  });

  it("names both widths, and keeps the engine code, status and cause", () => {
    const error = overflow(serverSummary(true));
    const shown = insertionFailure(error, WIDE, en) as Error & { detail?: string };

    expect(shown.message).toBe(en("components.tooWide", { width: "120 mm", available: "46.4 mm" }));
    expect((shown as { code?: string }).code).toBe("failed");
    expect((shown as { status?: number }).status).toBe(422);
    expect((shown as { cause?: unknown }).cause).toBe(error);
    // The engine's own diagnostic stays for a log, not for the sentence.
    expect(shown.detail).toContain("layout_overflow");
  });

  it("reads the engine's own body width when a host runs in process", () => {
    const shown = insertionFailure(overflow(engineText), WIDE, en) as Error;

    // Same sentence as the server summary's: the body width is the number
    // that decides the refusal, whichever transport spelled it.
    expect(shown.message).toBe(en("components.tooWide", { width: "120 mm", available: "46.4 mm" }));
  });

  it("names the block width alone when the refusal carries no body width", () => {
    const shown = insertionFailure(overflow(serverSummary(false), { kind: "layout_overflow" }), WIDE, en) as Error;

    expect(shown.message).toBe(en("components.tooWideUnmeasured", { width: "120 mm" }));
    expect(shown.message).toContain("120 mm");
    expect(shown.message).not.toContain("only");
  });

  it("still says something actionable when neither width is known", () => {
    const shown = insertionFailure(overflow(serverSummary(false), { kind: "layout_overflow" }), UNMEASURED, en) as Error;

    expect(shown.message).toBe(en("components.tooWideUnknown"));
    // No placeholder survived as an empty slot: the sentence ends on a step.
    expect(shown.message).not.toMatch(/is\s*[.,]|:\s*$/);
  });

  it("wraps a cause it cannot classify in one localized frame", () => {
    // The frame names both things a caller can vary; the engine's own line
    // rides inside it rather than replacing it.
    const error = new HwpEngineError(
      "failed",
      "ahwp edit failed (exit 1): 구역 정의 문단 앞에는 삽입할 수 없습니다",
    );
    const shown = insertionFailure(error, WIDE, en) as Error & { detail?: string; code?: string };

    expect(shown.message).toBe(en("components.insertionRefused", { reason: "구역 정의 문단 앞에는 삽입할 수 없습니다" }));
    expect(shown.message).toContain("Check the component and the insertion point, then retry.");
    expect(shown.detail).toContain("exit 1");
    expect(shown.code).toBe("failed");
    expect(shown).not.toHaveProperty("stopped");
  });

  it("strips maru's hwp edit head through the Tauri bridge the same way (#133)", () => {
    const error = new HwpEngineError(
      "failed",
      "hwped_edit failed: hwp edit failed (exit 1): 구역 정의 문단 앞에는 삽입할 수 없습니다",
    );
    const shown = insertionFailure(error, WIDE, en) as Error;
    expect(shown.message).toBe(en("components.insertionRefused", { reason: "구역 정의 문단 앞에는 삽입할 수 없습니다" }));
  });

  it("strips the Tauri transport's own prefixes from the cause", () => {
    // The bridge refuses with maru's prefix over the engine's own, so the
    // frame would read as one long chain if the reason were not the last link.
    const error = new HwpEngineError(
      "failed",
      "hwped_edit failed: hwp_failed: Error: insert_blocks 구역 정의 문단 앞에는 삽입할 수 없습니다",
    );
    const shown = insertionFailure(error, WIDE, en) as Error;

    expect(shown.message).toBe(
      en("components.insertionRefused", { reason: "구역 정의 문단 앞에는 삽입할 수 없습니다" }),
    );
  });

  it("keeps one line of a multi-line engine refusal", () => {
    // The frame prints a cause, not a transcript: the engine's first line is
    // the failure and the rest is context.
    const error = new HwpEngineError(
      "failed",
      "hwped_edit failed: hwp_failed: Error: insert_blocks 구역 정의 문단 앞에는 삽입할 수 없습니다\n" +
        "Caused by: 0: layout at /tmp/x.hwpx",
    );
    const shown = insertionFailure(error, WIDE, en) as Error;

    expect(shown.message).toBe(
      en("components.insertionRefused", { reason: "구역 정의 문단 앞에는 삽입할 수 없습니다" }),
    );
    expect(shown.message).not.toContain("Caused by");
  });

  it("puts the locale's own sentence in the frame for a stopped edit (#91)", () => {
    // Both transports append the English sentence to the message for an empty
    // stderr, so reading it into the {reason} slot would print English inside
    // the Korean frame. The structured marker selects the locale's sentence.
    const error = new HwpEngineError("failed", `ahwp edit failed (exit 137): ${STOPPED_WITHOUT_DIAGNOSTIC}`, {
      stopped: true,
    });
    const shown = insertionFailure(error, WIDE, ko) as HwpEngineError;

    expect(shown.message).toBe(ko("components.insertionRefused", { reason: ko("error.stoppedWithoutDiagnostic") }));
    expect(shown.message).not.toContain("the engine stopped without writing");
    // The wrapper keeps the marker beside the code, status and insertion it
    // already copies, so a host reading `onError` can still tell (#91).
    expect(shown.stopped).toBe(true);
    expect(shown.code).toBe("failed");
  });

  it("puts the locale's own cause in the frame for a failure with no Error: line (#140)", () => {
    const error = new HwpEngineError("failed", `ahwp edit failed (exit 101): insert_blocks refused: ${NO_ENGINE_CAUSE}`, {
      noCause: true,
    });
    const shown = insertionFailure(error, WIDE, ko) as HwpEngineError;
    expect(shown.message).toBe(ko("components.insertionRefused", { reason: ko("error.noEngineCause") }));
    expect(ko("error.noEngineCause")).toBe(
      "엔진이 원인을 밝히지 않고 실패했으므로(대개 비정상 종료된 경우입니다) 아무것도 적용되지 않았습니다. 다시 적용하고, 같은 방식으로 실패하면 호스트 로그와 함께 알려 주세요.",
    );
    expect(shown.message).not.toContain("the engine failed without naming a cause");
    expect(shown.noCause).toBe(true);
  });

  it("leaves a failure that is not a refusal with the handling it has", () => {
    // A timeout is not the engine refusing this component, so it keeps its own
    // badge and message rather than being relabelled.
    const error = new HwpEngineError("timeout", "ahwp edit failed (exit 124)");
    expect(insertionFailure(error, WIDE, en)).toBe(error);
  });

  /**
   * The two other classes the CLI server names. Its summary is all a caller
   * receives — the raw stderr names the staged input file — so each class has
   * to become a whole sentence here, next step included, in both locales.
   */
  it("names the style the target document lacks", () => {
    const error = refused(
      "ahwp edit failed (exit 1): insert_blocks refused: unknown_style; 결재란 셀",
      { kind: "unknown_style", style: "결재란 셀" },
    );
    const shown = insertionFailure(error, WIDE, ko) as Error & { detail?: string; code?: string };

    expect(shown.message).toBe(ko("components.unknownStyle", { style: "결재란 셀" }));
    expect(shown.message).toContain("결재란 셀");
    // The engine's classified tail stays technical detail, not the sentence.
    expect(shown.detail).toContain("insert_blocks refused: unknown_style");
    expect((shown as { code?: string }).code).toBe("failed");
  });

  it("keeps a style name that holds a parenthesis or a quote whole", () => {
    // The server prints the name last on its own line for exactly this: a name
    // is user text, and the parenthesised form it used before cut one at its
    // first `)`.
    const style = "결재란 (법인) '대표'";
    const error = refused(`ahwp edit failed (exit 1): insert_blocks refused: unknown_style; ${style}`, { kind: "unknown_style", style });
    const shown = insertionFailure(error, WIDE, en) as Error;

    expect(shown.message).toBe(en("components.unknownStyle", { style }));
  });

  it("classifies an in-process host's engine text through core's classifier, not the message", () => {
    // A host wired in process attaches the class with the same core function
    // the transports use; the palette reads the field.
    const stderr = "Error: 스타일 '결재란 (법인)'을 대상 문서에서 찾을 수 없습니다. styles 정의를 제공하고 " +
      "missing_style=create로 다시 시도하거나 hwp styles에서 기존 스타일을 선택하세요";
    const error = Object.assign(new Error(stderr), { insertion: classifyInsertionRefusal(stderr) });
    const shown = insertionFailure(error, WIDE, en) as Error;

    expect(shown.message).toBe(en("components.unknownStyle", { style: "결재란 (법인)" }));
  });

  it("shows a style name only as a quoted value; the name never picks the sentence (#88 review)", () => {
    // A name that reads like another class's marker still yields the
    // unknown-style sentence, because the kind field chose it.
    const style = "layout_overflow invalid_definition edit refused: range_tag";
    const shown = insertionFailure(refused("x", { kind: "unknown_style", style }), WIDE, en) as Error;
    expect(shown.message).toBe(en("components.unknownStyle", { style }));
    expect(shown.message).toContain(`"${style}"`);
    expect(ko("components.unknownStyle", { style })).toContain(`'${style}'`);
  });

  it("ignores a malformed insertion field and falls back to the generic frame", () => {
    for (const insertion of [{ kind: "unknown_style", style: "" }, { kind: "layout_overflow", insertionMm: "46" }, { kind: "x" }]) {
      const error = Object.assign(new HwpEngineError("failed", "ahwp edit failed (exit 1)"), { insertion });
      const shown = insertionFailure(error, WIDE, en) as Error;
      expect(shown.message).not.toContain("no style named");
      expect(shown.message).not.toBe(en("components.invalidDefinition"));
    }
  });

  it("never picks a class from message text alone (#88)", () => {
    // User text can end an unclassified message; without the field the palette
    // falls back to the generic frame, whatever the text says.
    for (const message of [
      "hwped_edit failed: hwp edit failed (exit 1): insert_blocks refused: unknown_style; 결재란 셀",
      "ahwp edit failed (exit 1): insert_blocks refused: layout_overflow (block 120 mm, insertion point 46.4 mm)",
      "ahwp edit failed (exit 1): insert_blocks refused: invalid_definition",
    ]) {
      const shown = insertionFailure(new HwpEngineError("failed", message), WIDE, en) as Error;
      expect(shown.message).not.toBe(en("components.unknownStyle", { style: "결재란 셀" }));
      expect(shown.message).not.toContain(en("components.tooWide", { width: "120 mm", available: "46.4 mm" }));
      expect(shown.message).not.toBe(en("components.invalidDefinition"));
    }
    // A plain Error with engine text and no field is not a refusal at all.
    const raw = new Error("스타일 '결재란'을 대상 문서에서 찾을 수 없습니다");
    expect(insertionFailure(raw, WIDE, en)).toBe(raw);
  });

  it("turns an unclassified definition refusal into a sentence with a next step", () => {
    const error = refused("ahwp edit failed (exit 1): insert_blocks refused: invalid_definition", { kind: "invalid_definition" });
    const shown = insertionFailure(error, WIDE, en) as Error & { detail?: string };

    expect(shown.message).toBe(en("components.invalidDefinition"));
    expect(shown.message).toContain("then insert it again");
    expect(shown.detail).toContain("invalid_definition");
  });
});

describe("componentFailure", () => {
  /** Each palette-reachable code and the next-step key it must render. */
  const steps = [
    ["component_param", "components.step.param"],
    ["component_style", "components.step.style"],
    ["component_invalid", "components.step.invalid"],
    ["component_load", "components.step.load"],
  ] as const satisfies ReadonlyArray<readonly [ComponentErrorCode, MessageKey]>;

  it.each(steps)("gives %s its own localized next step", (code, key) => {
    const error = new ComponentError(code, "src/components/broken.json", "params.기안자", "the reason");
    const shown = componentFailure(error, ko) as Error & { detail?: string };

    expect(shown.message).toBe(ko("components.refused", {
      code,
      source: "src/components/broken.json",
      field: "params.기안자",
      value: "",
      step: ko(key),
    }));
    // The step is the localized one, and the parser's English reason is not
    // part of what the user reads.
    expect(shown.message).toContain(ko(key));
    expect(shown.message).not.toContain("the reason");
    // The English one-line form survives as technical detail.
    expect(shown.detail).toBe(error.message);
  });

  it("keeps the empty-field form for a refusal about the source itself", () => {
    const error = new ComponentError("component_load", "https://example.test/c.json", "", "unreadable");
    const shown = componentFailure(error, ko) as Error;

    expect(shown.message).toBe(ko("components.refused", {
      code: "component_load",
      source: "https://example.test/c.json",
      field: "",
      value: "",
      step: ko("components.step.load"),
    }));
  });

  it("prints the offending value beside the field that named it", () => {
    // A block's style reference is a field such as `blocks[0].style`, which
    // does not spell the name it failed on; the name is the value, so the
    // sentence can print it without parsing the reason.
    const error = new ComponentError(
      "component_style",
      "시험",
      "blocks[0].style",
      "references style 결재란 셀, which no component defines",
      "결재란 셀",
    );
    const shown = componentFailure(error, en) as Error;

    expect(shown.message).toContain("blocks[0].style = 결재란 셀");
    expect(shown.message).toContain(en("components.step.style"));
  });

  it("passes a non-component throw through", () => {
    const error = new Error("boom");
    expect(componentFailure(error, en)).toBe(error);
  });
});

describe("insertion class end to end over HTTP (t37-a4)", () => {
  it("takes error.insertion from the server body through parseError to the sentence", async () => {
    const engine = createHttpEngine("/api", {
      fetch: (() => Promise.resolve(new Response(JSON.stringify({
        error: {
          code: "failed",
          message: "ahwp edit failed (exit 3): insert_blocks refused: layout_overflow (block 120.00 mm, insertion point 46.40 mm)",
          insertion: { kind: "layout_overflow", blockMm: 120, insertionMm: 46.4 },
        },
      }), { status: 422 }))) as unknown as typeof fetch,
    });
    const failure = await engine.edit({ name: "a.hwpx", data: new Uint8Array([1]) }, [])
      .then(() => { throw new Error("edit succeeded"); }, (e: unknown) => e);
    const shown = insertionFailure(failure, WIDE, ko) as Error;
    expect(shown.message).toBe(ko("components.tooWide", { width: "120 mm", available: "46.4 mm" }));
  });

  it("shows no class sentence when the body has only the message text", async () => {
    const engine = createHttpEngine("/api", {
      fetch: (() => Promise.resolve(new Response(JSON.stringify({
        error: { code: "failed", message: "ahwp edit failed (exit 3): insert_blocks refused: unknown_style; 결재란 셀" },
      }), { status: 422 }))) as unknown as typeof fetch,
    });
    const failure = await engine.edit({ name: "a.hwpx", data: new Uint8Array([1]) }, [])
      .then(() => { throw new Error("edit succeeded"); }, (e: unknown) => e);
    const shown = insertionFailure(failure, WIDE, en) as Error;
    expect(shown.message).not.toBe(en("components.unknownStyle", { style: "결재란 셀" }));
  });
});

/**
 * The engine-version gate for a component that carries its own list (#176):
 * the own-numbering rule rests on the HWP 5.0 list fix agent-hwp#472 shipped
 * in 1.5.0, and an older engine cannot write the numbering a definition asks
 * for. The sentence names the version and both next steps a user has.
 */
describe("listEngineRefusal", () => {
  const LISTS: Record<string, List> = {
    항목: { kind: "ordered", levels: [{ marker: "{n}.", start: 1 }] },
  };

  it.each([en, ko])("says nothing for a component that carries no list", (t) => {
    for (const version of ["1.4.2", "1.6.1", null]) {
      expect(listEngineRefusal(undefined, version, t)).toBe("");
      expect(listEngineRefusal({}, version, t)).toBe("");
    }
  });

  it.each([en, ko])("says nothing on an engine that can write one", (t) => {
    for (const version of ["1.5.0", "1.6.1", "2.0.0"]) {
      expect({ version, refusal: listEngineRefusal(LISTS, version, t) }).toEqual({
        version,
        refusal: "",
      });
    }
  });

  it.each([en, ko])("names the version and both next steps on an older engine", (t) => {
    const sentence = listEngineRefusal(LISTS, "1.4.2", t);
    expect(sentence).toBe(t("components.listEngine", { version: "1.5.0" }));
    expect(sentence).toContain("1.5.0");
    // A refusal names its cause and the next step in one sentence: update the
    // engine, or write the markers into the text runs instead.
    expect(sentence).toMatch(t === en ? /write the list markers into the text runs/ : /목록 표식/);
  });

  it("keeps the gate open while the engine version is unknown", () => {
    // `componentsSupportReason` treats a null capabilities the same way: an
    // unread version is not an old one, so the engine's own answer stands.
    expect(listEngineRefusal(LISTS, null, en)).toBe("");
  });
});
