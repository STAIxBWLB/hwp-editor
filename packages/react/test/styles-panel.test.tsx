/**
 * Styles tab (issue #53, WP3/T5): the queue-only controls, the gates, and the
 * preset switch's grouping.
 *
 * The preset switch is the one control here that does not queue an op: it runs
 * immediately as ONE engine call carrying the body-style update and the
 * `style_tables` op together. What this file proves is the clause the spec
 * attaches to it — one undo entry, one snapshot staged — plus the two things a
 * stub can show and a real binary cannot: which fields the definition form
 * actually sends, and what the user is told when the document has no table to
 * style.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CatEnvelope,
  DocumentHandle,
  EditOp,
  EditOptions,
  EditReport,
  HwpEngine,
  StyleTable,
} from "@hwp-editor/core";
import { DOCUMENT_PROFILES } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine, makeEnvelope } from "./mock-engine.js";

afterEach(cleanup);

const ATTRS = {
  char: {
    bold: false,
    italic: false,
    size_pt: 12,
    color: "#000000",
    faces: ["함초롬바탕", null, null, null, null, null, null],
    face_ids: [1, 0, 0, 0, 0, 0, 0],
  },
  para: { alignment: "justify", indent: 0, line_spacing: 160, line_spacing_type: 0 },
  char_shape_id: 0,
  para_shape_id: 0,
};

const TABLE: StyleTable = {
  version: "1.0",
  styles: [
    { id: 0, name: "바탕글", english_name: "Normal", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p2", "p3"] },
    { id: 1, name: "개요 1", english_name: "Outline 1", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p1"] },
    { id: 2, name: "강조", english_name: "Emphasis", kind: "character", next_style: 0, attrs: ATTRS, used_by: ["p2"] },
  ],
};

/** A `style_tables` outcome the engine could not apply, as the report carries it. */
function presetReport(status: "applied" | "failed"): EditReport {
  return {
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "x.hwpx",
    dry_run: false,
    ops: [{
      index: 0,
      op: "style_tables",
      status,
      pieces_touched: 0,
      changed: [],
      reason: status === "failed" ? "style_tables: no styleable table" : null,
    }],
    applied_count: status === "applied" ? 1 : 0,
    failed_count: status === "failed" ? 1 : 0,
  };
}

/** The shared envelope, with the ids `used_by` joins on and both levels. */
function envelopeWithIds(): CatEnvelope {
  const base = makeEnvelope();
  return {
    ...base,
    segments: base.segments.map((segment, at) => ({
      ...segment,
      id: `p${at}`,
      // Promote reads the paragraph as it renders, and select-similar matches
      // on the flattened direct level, so every paragraph carries what a real
      // 1.4.0 envelope publishes.
      style: { char: ATTRS.char, para: ATTRS.para, charShapeId: 0, paraShapeId: 0 },
      direct: { char: ATTRS.char, para: ATTRS.para, charShapeId: 0, paraShapeId: 0 },
      directChar: ATTRS.char,
      directPara: ATTRS.para,
    })),
  };
}

interface StyleHarness {
  engine: HwpEngine;
  edits: { ops: EditOp[]; options: EditOptions | undefined }[];
  styleReads: DocumentHandle[];
  documentReads: DocumentHandle[];
}

/**
 * A mock engine that advertises `styles` v1 and records every edit call.
 * `styles: false` withholds the capability while the version stays what
 * `version` says, which is how a host missing the command is told apart from a
 * binary below the floor.
 */
function styleEngine(
  opts: {
    styles?: boolean;
    version?: string;
    table?: StyleTable;
    report?: EditReport;
    /**
     * Per-call answers. A promise at index `n` holds the nth read open until
     * it settles, which is how a test reaches the state a document switch
     * passes through: the new document is on screen, its table is not yet.
     */
    pending?: (Promise<StyleTable> | undefined)[];
  } = {},
): StyleHarness {
  const base = createMockEngine({ envelope: envelopeWithIds() });
  const edits: StyleHarness["edits"] = [];
  const styleReads: DocumentHandle[] = [];
  const documentReads: DocumentHandle[] = [];
  const advertised = opts.styles ?? true;
  const engine: HwpEngine = {
    ...base,
    read: async (document) => {
      documentReads.push(document);
      return base.read(document);
    },
    capabilities: async () => {
      const caps = await base.capabilities();
      const versioned = opts.version === undefined ? caps : { ...caps, version: opts.version };
      return advertised ? { ...versioned, styles: "v1" as const } : versioned;
    },
    styles: async (document) => {
      styleReads.push(document);
      const held = opts.pending?.[styleReads.length - 1];
      return held === undefined ? (opts.table ?? TABLE) : await held;
    },
    edit: async (document, ops, options) => {
      edits.push({ ops, options });
      const edited = await base.edit(document, ops, options);
      return opts.report === undefined ? edited : { ...edited, report: opts.report };
    },
  };
  return { engine, edits, styleReads, documentReads };
}

function renderEditor(engine: HwpEngine, locale: "en" | "ko" = "en") {
  return render(
    <HwpEditor engine={engine} file={{ name: "x.hwpx", data: new Uint8Array([1]) }} locale={locale} />,
  );
}

describe.each([["en", en], ["ko", ko]] as const)("styles tab (%s)", (locale, messages) => {
  it("is disabled with the version reason below hwp-cli 1.4.0", async () => {
    const { engine, styleReads } = styleEngine({ styles: false });
    renderEditor(engine, locale);
    fireEvent.click(await screen.findByRole("tab", { name: messages["tabs.styles"] }));
    // The verdict badge is also a status, so the sentence is matched by text.
    expect(await screen.findByText(/1\.4\.0/)).toBeTruthy();
    // Nothing is read and no control is offered: the tab is a sentence.
    expect(styleReads).toHaveLength(0);
    expect(screen.queryByRole("button", { name: messages["styles.presetSubmit"] })).toBeNull();
  });

  /**
   * t12-a8: a host whose engine is new enough but whose adapter never learned
   * the command is not a version problem. The sentence it used to show said
   * "this engine reports 1.6.1", which blamed a binary that is fine.
   */
  it("names a host that does not serve the command, not the engine version", async () => {
    const { engine } = styleEngine({ styles: false, version: "1.6.1" });
    renderEditor(engine, locale);
    fireEvent.click(await screen.findByRole("tab", { name: messages["tabs.styles"] }));
    expect(await screen.findByText(messages["styles.unavailableHost"])).toBeTruthy();
    expect(screen.queryByText(/1\.4\.0/)).toBeNull();
  });

  it("lists paragraph and character styles with their usage counts", async () => {
    const { engine } = styleEngine();
    renderEditor(engine, locale);
    fireEvent.click(await screen.findByRole("tab", { name: messages["tabs.styles"] }));
    const body = await screen.findByRole("button", { name: /바탕글/ });
    expect(body.textContent).toContain(messages["styles.usage"]({ count: 2 }));
    expect(screen.getByRole("button", { name: /개요 1/ }).textContent)
      .toContain(messages["styles.usage"]({ count: 1 }));
    expect(await screen.findByRole("button", { name: /강조/ })).toBeTruthy();
  });
});

describe("styles tab operations (en)", () => {
  async function openPanel(harness: StyleHarness) {
    renderEditor(harness.engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    return harness;
  }

  /** Apply the queued ops and return the ops the engine was asked to run. */
  async function applyQueued(harness: StyleHarness, count: number): Promise<EditOp[]> {
    fireEvent.click(await screen.findByRole("button", { name: en["toolbar.applyWithCount"]({ count }) }));
    await waitFor(() => expect(harness.edits).toHaveLength(1));
    return harness.edits[0]!.ops;
  }

  it("seeds the definition form from the chosen style and queues one update_style", async () => {
    const harness = await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    const size = screen.getByLabelText(en["styles.size"]) as HTMLInputElement;
    // The form starts from the style's own definition, so an untouched field
    // rewrites the value it already had rather than inventing one.
    expect(size.value).toBe("12");
    fireEvent.change(size, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.updateSubmit"] }));
    // One queued op; nothing reaches the engine until Apply.
    const pending = screen.getByRole("list", { name: en["toolbar.pendingList"] });
    expect(pending.textContent).toContain("update-style: 바탕글");
    expect(harness.edits).toHaveLength(0);
  });

  /**
   * t12-a5: a supplied `font` is written into every language slot and a
   * supplied `bold`/`align` overwrites the definition, so a size-only change
   * must carry the size and nothing else. The untouched fields are seeded from
   * the style, and re-sending them is what rewrote it.
   */
  it("sends only the fields the user changed", async () => {
    const harness = await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    fireEvent.change(screen.getByLabelText(en["styles.size"]), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.updateSubmit"] }));
    const ops = await applyQueued(harness, 1);
    expect(ops).toEqual([{ kind: "update-style", style: "바탕글", size: "15" }]);
  });

  it("offers nothing to queue until a field differs from the style", async () => {
    await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    // An untouched form is not an empty patch for the engine to refuse.
    expect((screen.getByRole("button", { name: en["styles.updateSubmit"] }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * t12-a7: an empty size field is a valid form state meaning "leave it", not
   * `size: "0"`-or-empty travelling to `withUnit` and failing the whole
   * pending batch at Apply.
   */
  it("omits an empty size field instead of queueing it", async () => {
    const harness = await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    const size = screen.getByLabelText(en["styles.size"]) as HTMLInputElement;
    fireEvent.change(size, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(en["styles.lineSpacing"]), { target: { value: "180" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.updateSubmit"] }));
    const ops = await applyQueued(harness, 1);
    expect(ops).toEqual([{ kind: "update-style", style: "바탕글", lineSpacingPct: "180" }]);
  });

  it("queues one apply-style per selected paragraph", async () => {
    await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /개요 1/ }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.applyToSelection"] }));
    const pending = screen.getByRole("list", { name: en["toolbar.pendingList"] });
    // One entry per selected paragraph, addressed the way every addressed op
    // is printed in the pending list.
    expect(pending.textContent).toContain("apply-style:");
    expect(pending.textContent).toContain('{"id":"p1"}');
  });

  it("groups a promote into one queue action: create_style then apply-style", async () => {
    await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    fireEvent.change(screen.getByLabelText(en["styles.promoteName"]), { target: { value: "인용" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.promoteSubmit"] }));
    const pending = screen.getByRole("list", { name: en["toolbar.pendingList"] });
    // One queue action, so the create comes first and the applies follow it:
    // the engine resolves create before apply within a batch, and the whole
    // batch is one engine call and one undo step.
    const text = pending.textContent ?? "";
    const create = text.indexOf("create-style: 인용");
    const apply = text.indexOf("apply-style:");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(apply).toBeGreaterThan(create);
  });

  /**
   * A row whose kind the document does not answer (`null` in the contract) is
   * listed but offers nothing: applying a style the engine may refuse is worse
   * than saying the document does not describe it.
   */
  it("lists a style whose kind is unknown without offering edits", async () => {
    const table: StyleTable = {
      version: "1.0",
      styles: [{ id: 0, name: "알 수 없음", english_name: "", kind: null, next_style: 0, attrs: ATTRS, used_by: ["p1"] }],
    };
    await openPanel(styleEngine({ table }));
    fireEvent.click(await screen.findByRole("button", { name: /알 수 없음/ }));
    expect(screen.getByText(en["styles.kindUnknown"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["styles.applyToSelection"] })).toBeNull();
  });

  /**
   * t12-a4: a side the document cannot resolve is absent, not defaulted. The
   * control is disabled rather than seeded with a value the style does not
   * have, and the tab says why.
   */
  it("disables the character fields when the style's char shape does not resolve", async () => {
    const table: StyleTable = {
      version: "1.0",
      styles: [{
        id: 0, name: "미해결", english_name: "", kind: "paragraph", next_style: 0,
        attrs: { para: ATTRS.para, paraShapeId: 0 }, used_by: ["p1"],
      }],
    };
    await openPanel(styleEngine({ table }));
    fireEvent.click(await screen.findByRole("button", { name: /미해결/ }));
    expect((screen.getByLabelText(en["styles.size"]) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(en["styles.font"]) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(en["styles.attrsUnresolved"])).toBeTruthy();
  });

  it("switches preset as ONE engine call inside ONE undo entry", async () => {
    const harness = await openPanel(styleEngine());
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    await waitFor(() => expect(harness.edits).toHaveLength(1));
    // One batch: the body-style update and the preset op together. The flag
    // form could not carry both, and it aborted the whole edit on a document
    // with no table.
    // The body row comes from the preset's profile -- the one copy react also
    // reads -- not from the font the document happened to carry.
    expect(harness.edits[0]!.ops).toEqual([
      {
        kind: "update-style",
        style: "바탕글",
        font: DOCUMENT_PROFILES.official.fontFamily,
        size: String(DOCUMENT_PROFILES.official.bodySizePt),
        lineSpacingPct: String(DOCUMENT_PROFILES.official.lineHeightPercent),
      },
      { kind: "style-tables", preset: "official" },
    ]);
    // One replacement, therefore one snapshot: undo returns the document the
    // switch started from in a single step.
    const undo = await screen.findByRole("button", { name: en["toolbar.revert"] });
    await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false));
    const readsBeforeUndo = harness.documentReads.length;
    fireEvent.click(undo);
    await waitFor(() => expect(harness.documentReads.length).toBeGreaterThan(readsBeforeUndo));
  });

  /**
   * t12-a2: the preset's own outcome is not a failed switch. A document with
   * no multi-column table has nothing to style; the style update landed, and
   * the user hears the rest on the notice line instead of losing the edit.
   */
  it("reports a preset with no table to style without failing the edit", async () => {
    const harness = await openPanel(styleEngine({ report: presetReport("failed") }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    expect(await screen.findByText(en["styles.noTableToStyle"])).toBeTruthy();
    // The document was still replaced: the style half of the switch landed.
    expect(harness.edits).toHaveLength(1);
    expect(harness.documentReads.length).toBeGreaterThan(0);
  });

  it("says nothing when the preset did style the tables", async () => {
    await openPanel(styleEngine({ report: presetReport("applied") }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    await waitFor(() => expect(screen.queryByText(en["styles.noTableToStyle"])).toBeNull());
  });

  /**
   * t12-n2: the table is kept WITH the document it describes. A file switch
   * puts the new document on screen before its table lands, and `used_by` ids
   * are content checksums, so handing the old rows out would list paragraphs
   * this document does not have and select nothing when a row is pressed.
   */
  it("does not carry the previous document's table across a file switch", async () => {
    let release = (_table: StyleTable): void => undefined;
    const held = new Promise<StyleTable>((resolve) => { release = resolve; });
    const harness = styleEngine({ pending: [undefined, held] });
    const view = renderEditor(harness.engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    expect(await screen.findByRole("button", { name: /바탕글/ })).toBeTruthy();

    view.rerender(
      <HwpEditor engine={harness.engine} file={{ name: "y.hwpx", data: new Uint8Array([2]) }} locale="en" />,
    );

    // The read for the new document has started and not answered: the tab says
    // it is reading instead of listing the document that just went away.
    await waitFor(() => expect(harness.styleReads).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /바탕글/ })).toBeNull();
    expect(screen.getByText(en["styles.loading"])).toBeTruthy();

    release(TABLE);
    expect(await screen.findByRole("button", { name: /바탕글/ })).toBeTruthy();
  });
});
