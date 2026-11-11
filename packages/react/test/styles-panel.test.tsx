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

/** The row the definition form queues against: 바탕글, header id 0. */
const BODY_ID = 0;

const TABLE: StyleTable = {
  version: "1.0",
  styles: [
    { id: 0, name: "바탕글", english_name: "Normal", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p2", "p3"] },
    { id: 1, name: "개요 1", english_name: "Outline 1", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p1"] },
    { id: 2, name: "강조", english_name: "Emphasis", kind: "character", next_style: 0, attrs: ATTRS, used_by: ["p2"] },
  ],
};

/**
 * A preset batch's report, as the engine writes it. `pieces` is what the engine
 * measured: 0 means the switch was already in place (byte-identical output),
 * which is how the panel knows not to stage an undo entry for it. The batch is
 * the panel's own ops, so `failed` models the measured table-less answer: the
 * style op lands, `style_tables` is pushed to unapplied. `tableOnly` is the
 * batch a document with no paragraph style sends: the preset and nothing else,
 * so the report must not carry an op that was never sent.
 */
function presetReport(status: "applied" | "failed", pieces = 1, tableOnly = false): EditReport {
  const tableOp: EditReport["ops"][number] = {
    index: tableOnly ? 0 : 1,
    op: "style_tables",
    status,
    pieces_touched: status === "failed" ? 0 : pieces,
    changed: [],
    reason: status === "failed" ? "style_tables: no styleable table" : null,
  };
  return {
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "x.hwpx",
    dry_run: false,
    ops: tableOnly
      ? [tableOp]
      : [
        { index: 0, op: "update_style", status: "applied", pieces_touched: pieces, changed: [], reason: null },
        tableOp,
      ],
    applied_count: tableOnly ? (status === "applied" ? 1 : 0) : (status === "applied" ? 2 : 1),
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

/**
 * The shared envelope with the DIRECT level changed, which is what the promote
 * reads: it describes the paragraph as it renders, not the style it inherits.
 */
function envelopeWithDirect(shape: { italic?: boolean; alignment?: string }): CatEnvelope {
  const base = envelopeWithIds();
  return {
    ...base,
    segments: base.segments.map((segment) => {
      const direct = segment.direct;
      if (direct === undefined) return segment;
      return {
        ...segment,
        direct: {
          ...direct,
          ...(direct.char === undefined || shape.italic === undefined
            ? {}
            : { char: { ...direct.char, italic: shape.italic } }),
          ...(direct.para === undefined || shape.alignment === undefined
            ? {}
            : { para: { ...direct.para, alignment: shape.alignment } }),
        },
      };
    }),
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
    /**
     * Per-read tables, the last repeating. The panel re-reads after every
     * applied edit, undo and file switch, so a test that pins what the form is
     * re-seeded from has to say what each read answers.
     */
    tables?: StyleTable[];
    /**
     * The table to answer with, chosen from the document being read. A panel
     * re-reads after every applied edit and undo, and each of those hands the
     * editor a new document, so a sequence of reads cannot say which document
     * it is answering for: an undo lands back on a document an earlier read
     * already described.
     */
    tableOf?: (document: DocumentHandle) => StyleTable | undefined;
    /** An error to answer the `call`-th document read with (1-based). */
    readError?: (document: DocumentHandle, call: number) => Error | undefined;
    report?: EditReport;
    /** The envelope the panel reads, when a test needs shapes the default lacks. */
    envelope?: CatEnvelope;
    /**
     * Per-call answers. A promise at index `n` holds the nth read open until
     * it settles, which is how a test reaches the state a document switch
     * passes through: the new document is on screen, its table is not yet.
     */
    pending?: (Promise<StyleTable> | undefined)[];
  } = {},
): StyleHarness {
  const base = createMockEngine({ envelope: opts.envelope ?? envelopeWithIds() });
  const edits: StyleHarness["edits"] = [];
  const styleReads: DocumentHandle[] = [];
  const documentReads: DocumentHandle[] = [];
  const advertised = opts.styles ?? true;
  const engine: HwpEngine = {
    ...base,
    read: async (document) => {
      documentReads.push(document);
      const failure = opts.readError?.(document, documentReads.length);
      if (failure !== undefined) throw failure;
      return base.read(document);
    },
    capabilities: async () => {
      const caps = await base.capabilities();
      const versioned = opts.version === undefined ? caps : { ...caps, version: opts.version };
      return advertised ? { ...versioned, styles: "v1" as const } : versioned;
    },
    styles: async (document) => {
      styleReads.push(document);
      const at = styleReads.length - 1;
      const held = opts.pending?.[at];
      if (held !== undefined) return await held;
      const named = opts.tableOf?.(document);
      if (named !== undefined) return named;
      const tables = opts.tables;
      if (tables !== undefined && tables.length > 0) return tables[Math.min(at, tables.length - 1)]!;
      return opts.table ?? TABLE;
    },
    edit: async (document, ops, options) => {
      edits.push({ ops, options });
      const edited = await base.edit(document, ops, options);
      return opts.report === undefined ? edited : { ...edited, report: opts.report };
    },
  };
  return { engine, edits, styleReads, documentReads };
}

function renderEditor(engine: HwpEngine, locale: "en" | "ko" = "en", onError?: (error: unknown) => void) {
  return render(
    <HwpEditor
      engine={engine}
      file={{ name: "x.hwpx", data: new Uint8Array([1]) }}
      locale={locale}
      {...(onError === undefined ? {} : { onError })}
    />,
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
   * n8: an engine that answers no version at all is still below the floor, and
   * the sentence has to end with what to do rather than trail off after "this
   * engine reports .".
   */
  it("names the upgrade as the next step when the engine reports no version", async () => {
    const { engine } = styleEngine({ styles: false, version: "" });
    renderEditor(engine, locale);
    fireEvent.click(await screen.findByRole("tab", { name: messages["tabs.styles"] }));
    const sentence = messages["styles.unavailable"]({ version: "" });
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(sentence).toContain("1.4.0");
    expect(document.body.textContent ?? "").not.toMatch(/reports\s*\./);
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
    expect(pending.textContent).toContain(`${en["pending.kind.update-style"]}: 바탕글`);
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
    // The row's id, not its name: a styles-v1 name can be empty or shared.
    expect(ops).toEqual([{ kind: "update-style", style: BODY_ID, size: "15" }]);
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
    expect(ops).toEqual([{ kind: "update-style", style: BODY_ID, lineSpacingPct: "180" }]);
  });

  it("queues one apply-style per selected paragraph", async () => {
    await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /개요 1/ }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.applyToSelection"] }));
    const pending = screen.getByRole("list", { name: en["toolbar.pendingList"] });
    // One entry per selected paragraph, each naming the element it addresses
    // rather than printing the address as JSON.
    expect(pending.textContent).toContain(`${en["pending.kind.apply-style"]}:`);
    expect(pending.textContent).toContain(en["pending.target.id"]({ id: "p1" }));
    expect(pending.textContent).not.toContain('{"id"');
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
    const create = text.indexOf(`${en["pending.kind.create-style"]}: 인용`);
    const apply = text.indexOf(`${en["pending.kind.apply-style"]}:`);
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
    const harness = await openPanel(styleEngine({ report: presetReport("applied", 2) }));
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
        style: BODY_ID,
        font: DOCUMENT_PROFILES.official.fontFamily,
        size: String(DOCUMENT_PROFILES.official.bodySizePt),
        lineSpacingPct: String(DOCUMENT_PROFILES.official.lineHeightPercent),
      },
      { kind: "style-tables", preset: "official" },
    ]);
    // n10: the options travel through the shared rule, so a host-supplied
    // engine is asked for the report the outcome is read from.
    expect(harness.edits[0]!.options).toMatchObject({ verify: true, allowPartial: true, report: true });
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
  /**
   * t12-a10: `create_style` clones its base's shapes, so a base taken from the
   * highlighted list row brings that row's line spacing, indent and everything
   * else this form has no control for onto every paragraph the promote then
   * applies the new style to. The base is the paragraph's OWN style, and the
   * highlight here is a character row, which is neither.
   */
  it("bases a promoted style on the paragraph's own style, not the highlighted row", async () => {
    const harness = await openPanel(styleEngine());
    // 강조 is a character row that lists p2 in `used_by`, so choosing it selects
    // p2 — whose own paragraph style is 바탕글 (id 0).
    fireEvent.click(await screen.findByRole("button", { name: /강조/ }));
    fireEvent.change(screen.getByLabelText(en["styles.promoteName"]), { target: { value: "인용" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.promoteSubmit"] }));

    const items = screen.getByRole("list", { name: en["toolbar.pendingList"] }).querySelectorAll("li").length;
    fireEvent.click(screen.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: items }) }));
    await waitFor(() => expect(harness.edits).toHaveLength(1));
    const ops = harness.edits[0]!.ops;

    const create = ops.find((op) => op.kind === "create-style");
    expect(create).toMatchObject({ kind: "create-style", name: "인용", basedOn: BODY_ID });
    // Not the highlighted character row, which is the base the clone would
    // otherwise inherit line spacing and indent from.
    expect(create).not.toMatchObject({ basedOn: 2 });
    // The style this batch creates has no id yet, so the applies name it.
    for (const op of ops.filter((candidate) => candidate.kind === "apply-style")) {
      expect(op).toMatchObject({ style: "인용" });
    }
  });

  /**
   * A base clone carries the STYLE's shapes, so what the paragraph adds as its
   * own direct override has to travel in the create op or it is lost: italic
   * and a percentage line height are both readable here and both writable.
   */
  it("promotes the paragraph's own italic and percentage line height", async () => {
    const harness = await openPanel(styleEngine({ envelope: envelopeWithDirect({ italic: true }) }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    fireEvent.change(screen.getByLabelText(en["styles.promoteName"]), { target: { value: "인용" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.promoteSubmit"] }));

    const items = screen.getByRole("list", { name: en["toolbar.pendingList"] }).querySelectorAll("li").length;
    fireEvent.click(screen.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: items }) }));
    await waitFor(() => expect(harness.edits).toHaveLength(1));

    const create = harness.edits[0]!.ops.find((op) => op.kind === "create-style");
    expect(create).toMatchObject({ italic: true, lineSpacingPct: "160" });
  });

  /**
   * `divide` is a value the document can carry and this editor cannot write.
   * Mapping it to justify would rewrite the paragraph's alignment to one it
   * never had, so the create op says nothing about alignment instead.
   */
  it("does not invent justify for an alignment it cannot write", async () => {
    const harness = await openPanel(styleEngine({ envelope: envelopeWithDirect({ alignment: "divide" }) }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    fireEvent.change(screen.getByLabelText(en["styles.promoteName"]), { target: { value: "인용" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.promoteSubmit"] }));

    const items = screen.getByRole("list", { name: en["toolbar.pendingList"] }).querySelectorAll("li").length;
    fireEvent.click(screen.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: items }) }));
    await waitFor(() => expect(harness.edits).toHaveLength(1));

    const create = harness.edits[0]!.ops.find((op) => op.kind === "create-style");
    expect(create).not.toHaveProperty("align");
  });

  /**
   * n4: two rows can share a name in styles-v1, and a name can be empty, while
   * `edit-ops-v1` reads a style reference by name as ambiguous. The row id is
   * the row, so an edit addresses that.
   */
  it("addresses a style by id, so two rows sharing a name stay two styles", async () => {
    const table: StyleTable = {
      version: "1.0",
      styles: [
        { id: 0, name: "본문", english_name: "", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p2"] },
        { id: 1, name: "본문", english_name: "", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p3"] },
      ],
    };
    const harness = await openPanel(styleEngine({ table }));
    const rows = screen.getAllByRole("button", { name: /본문/ });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);
    fireEvent.change(screen.getByLabelText(en["styles.size"]), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.updateSubmit"] }));
    const ops = await applyQueued(harness, 1);
    expect(ops).toEqual([{ kind: "update-style", style: 1, size: "15" }]);
  });

  /**
   * n3: a switch that succeeded and styled nothing is a notice, not a failure.
   * `noteNotice` used to emit an `Error` for every sentence it showed, so a
   * host's `onError` heard about a successful edit.
   */
  it("keeps a successful switch out of onError", async () => {
    const errors: unknown[] = [];
    const engine = styleEngine({ report: presetReport("failed") });
    renderEditor(engine.engine, "en", (error) => errors.push(error));
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    expect(await screen.findByText(en["styles.noTableToStyle"])).toBeTruthy();
    expect(errors).toHaveLength(0);
  });

  /**
   * The same preset pressed again reports every op applied with
   * `pieces_touched: 0` and writes byte-identical output (measured on ahwp
   * 1.6.1), so replacing the document would stage an undo entry that restores
   * it to itself.
   */
  it("stages no undo entry when the preset changed nothing", async () => {
    const harness = await openPanel(styleEngine({ report: presetReport("applied", 0) }));
    const readsBefore = harness.documentReads.length;
    const root = document.querySelector("[data-status]")!;
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));

    await waitFor(() => expect(harness.edits).toHaveLength(1));
    // applyStarted ran, so the status left "clean" and has to come back: the
    // producer's answer settles it.
    await waitFor(() => expect(root.getAttribute("data-status")).toBe("clean"));
    expect(harness.documentReads).toHaveLength(readsBefore);
    expect((screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * t12-a13. On a table-less document the preset stays unapplied on every
   * press and the style op reports `pieces_touched: 0` from the second press
   * on. The unapplied preset is still not a change, so reading it as one adds
   * an undo entry per press that restores the document to itself.
   */
  it("stages no undo entry when a table-less document's preset is already in place", async () => {
    const harness = await openPanel(styleEngine({ report: presetReport("failed", 0) }));
    const readsBefore = harness.documentReads.length;
    const root = document.querySelector("[data-status]")!;
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));

    await waitFor(() => expect(harness.edits).toHaveLength(1));
    await waitFor(() => expect(root.getAttribute("data-status")).toBe("clean"));
    expect(harness.documentReads).toHaveLength(readsBefore);
    expect((screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * t12-a11. A no-op switch holds "applying" while the host switches file. The
   * switched-to load fails, and a failed load dispatches nothing, so no later
   * transition ends "applying" — the release above is the only one that can,
   * and it used to return early because the generation had moved. The reducer
   * then refuses queue, undo and apply until another successful load.
   */
  it("leaves applying when a switched-to load fails during a no-op switch", async () => {
    const engineHarness = styleEngine();
    let releaseEdit = (): void => undefined;
    const gate = new Promise<void>((resolve) => { releaseEdit = resolve; });
    const attempts: string[] = [];
    const engine: HwpEngine = {
      ...engineHarness.engine,
      edit: async (document, ops, options) => {
        await gate;
        const edited = await engineHarness.engine.edit(document, ops, options);
        return { ...edited, report: presetReport("applied", 0) };
      },
      read: async (document) => {
        // The attempt itself, because this read never reaches the shared
        // recorder: it is the one that fails.
        attempts.push(document.name);
        if (document.name === "y.hwpx") throw new Error("load failed");
        return engineHarness.engine.read(document);
      },
    };
    const { rerender } = renderEditor(engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    const root = document.querySelector("[data-status]")!;
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    await waitFor(() => expect(root.getAttribute("data-status")).toBe("applying"));

    // The host switches file; the new load fails, so `load` never runs and the
    // store keeps the document the switch started from.
    rerender(<HwpEditor engine={engine} file={{ name: "y.hwpx", data: new Uint8Array([2]) }} locale="en" />);
    await waitFor(() => expect(attempts).toContain("y.hwpx"));

    releaseEdit();
    await waitFor(() => expect(root.getAttribute("data-status")).toBe("clean"));
  });

  /**
   * t12-a12. A preset switch replaces the document, so it is refused while a
   * load is in flight — and that refusal used to reach only a host listening
   * on `onError`, which the playground does not pass: the click did nothing.
   */
  it("shows a preset switch refused during a load on the notice line", async () => {
    const engineHarness = styleEngine();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine: HwpEngine = {
      ...engineHarness.engine,
      read: async (document) => {
        if (document.name === "y.hwpx") await gate;
        return engineHarness.engine.read(document);
      },
    };
    const { rerender } = renderEditor(engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    expect(await screen.findByRole("button", { name: en["styles.presetSubmit"] })).toBeTruthy();

    rerender(<HwpEditor engine={engine} file={{ name: "y.hwpx", data: new Uint8Array([2]) }} locale="en" />);
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));

    // The sentence is on the editor's own status line, not only in a callback.
    expect(await screen.findByText(en["error.loadingReplacement"])).toBeTruthy();
    // Refused before the engine saw a batch: nothing was edited.
    expect(engineHarness.edits).toHaveLength(0);
    release();
  });

  /**
   * t12-a12. The other half of the same refusal: the state the user can see
   * and clear. Queued edits would be lost by a replacement, so the switch is
   * off and says what stands in its way.
   */
  it("disables the preset switch while edits are queued, and says why", async () => {
    await openPanel(styleEngine());
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    fireEvent.change(screen.getByLabelText(en["styles.size"]), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.updateSubmit"] }));

    const button = screen.getByRole("button", { name: en["styles.presetSubmit"] }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.getByText(en["styles.pendingEdits"])).toBeTruthy();
  });

  /**
   * n9: a notice describes a state, so it goes when that state does. Undo
   * returns the document the "no table to style" sentence was about, and the
   * read that finally works retires the sentence a failed read put up.
   */
  it("retires the no-table notice when undo returns the other document", async () => {
    const harness = await openPanel(styleEngine({ report: presetReport("failed") }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    expect(await screen.findByText(en["styles.noTableToStyle"])).toBeTruthy();

    const undo = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    await waitFor(() => expect(undo.disabled).toBe(false));
    fireEvent.click(undo);
    await waitFor(() => expect(screen.queryByText(en["styles.noTableToStyle"])).toBeNull());
    expect(harness.edits).toHaveLength(1);
  });

  /**
   * The other side of that rule: the notice goes when the transition LANDS.
   * A failed undo leaves the document where it was, so the sentence about it
   * is still true and must not be erased by the attempt.
   */
  it("keeps the no-table notice when the undo fails", async () => {
    // Read 1 is the load, read 2 the replacement the preset produced, read 3
    // the undo's read of the document being restored.
    const harness = await openPanel(styleEngine({
      report: presetReport("failed"),
      readError: (_document, call) => (call === 3 ? new Error("undo read failed") : undefined),
    }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    expect(await screen.findByText(en["styles.noTableToStyle"])).toBeTruthy();

    const undo = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    await waitFor(() => expect(undo.disabled).toBe(false));
    fireEvent.click(undo);
    await waitFor(() => expect(harness.documentReads).toHaveLength(3));
    expect(screen.getByText(en["styles.noTableToStyle"])).toBeTruthy();
  });

  /**
   * t12-a13. The table is re-read after every applied edit, undo and file
   * switch, so a seed taken at click time describes a style that has since
   * changed. Apply would offer to re-send the value it just replaced, and undo
   * would leave the form showing a value the document no longer carries.
   */
  it("re-seeds the definition form from the style after Apply and after undo", async () => {
    const at = (sizePt: number): StyleTable => ({
      version: "1.0",
      styles: TABLE.styles.map((row) => row.id === BODY_ID
        ? { ...row, attrs: { ...row.attrs, char: { ...row.attrs.char!, size_pt: sizePt } } }
        : row),
    });
    // Answered by document, not by read order: the second Apply edits the
    // document the first one produced, and undo lands back on it, so the
    // undone document is the 14pt one and the table has to say so.
    const sizes = new Map<string, number>([
      ["x.hwpx", 12],
      ["edited-1.hwpx", 14],
      ["edited-2.hwpx", 12],
    ]);
    const harness = await openPanel(styleEngine({ tableOf: (document) => at(sizes.get(document.name) ?? 12) }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    const size = () => screen.getByLabelText(en["styles.size"]) as HTMLInputElement;
    const button = () => screen.getByRole("button", { name: en["styles.updateSubmit"] }) as HTMLButtonElement;
    expect(size().value).toBe("12");
    expect(button().disabled).toBe(true);

    fireEvent.change(size(), { target: { value: "14" } });
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    await applyQueued(harness, 1);

    // After Apply the form is on the row's new value, and an untouched form
    // offers nothing: with a stale 12 seed this button would still say the
    // user changed something, and typing 12 back would be a no-op.
    expect(size().value).toBe("14");
    expect(button().disabled).toBe(true);
    fireEvent.change(size(), { target: { value: "12" } });
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    fireEvent.click(await screen.findByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(harness.edits).toHaveLength(2));
    expect(harness.edits[1]!.ops).toEqual([{ kind: "update-style", style: BODY_ID, size: "12" }]);
    expect(size().value).toBe("12");
    expect(button().disabled).toBe(true);

    // Undo restores the FIRST edited document, whose style is 14pt: the form
    // shows the value that document carries, not the value it was last left on.
    const undo = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    await waitFor(() => expect(undo.disabled).toBe(false));
    fireEvent.click(undo);
    await waitFor(() => expect(size().value).toBe("14"));
    expect(button().disabled).toBe(true);
  });

  /**
   * t12-a13. A style id belongs to the document it was read from: the next
   * document's row with the same id is another style, so a switch to another
   * file takes the highlight with it instead of reusing the old seed.
   */
  it("clears the highlight when the file switches", async () => {
    const harness = styleEngine({ tables: [TABLE, TABLE] });
    const view = renderEditor(harness.engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    expect(screen.getByLabelText(en["styles.size"])).toBeTruthy();

    view.rerender(
      <HwpEditor engine={harness.engine} file={{ name: "y.hwpx", data: new Uint8Array([2]) }} locale="en" />,
    );

    // The same id is in the new document's table, and it is another style: the
    // highlight is gone rather than carrying the previous file's seed.
    await waitFor(() => expect(
      screen.getByRole("button", { name: /바탕글/ }).getAttribute("aria-pressed"),
    ).toBe("false"));
    expect(screen.queryByLabelText(en["styles.size"])).toBeNull();
  });

  /**
   * t12-a16: a load takes on a new document even when the file carries the
   * name of the one it replaces, so the highlight cannot key on that name.
   */
  it("clears the highlight when another document arrives under the same name", async () => {
    const harness = styleEngine({ tables: [TABLE, TABLE] });
    const view = renderEditor(harness.engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    expect(screen.getByLabelText(en["styles.size"])).toBeTruthy();

    view.rerender(
      <HwpEditor engine={harness.engine} file={{ name: "x.hwpx", data: new Uint8Array([9]) }} locale="en" />,
    );

    await waitFor(() => expect(harness.styleReads).toHaveLength(2));
    await waitFor(() => expect(
      screen.getByRole("button", { name: /바탕글/ }).getAttribute("aria-pressed"),
    ).toBe("false"));
    expect(screen.queryByLabelText(en["styles.size"])).toBeNull();
  });

  /**
   * t12-a13, the other half of the same rule: a later read that no longer
   * carries the highlighted id means the style is gone from this document, so
   * the selection goes with it. The row is absent from the list either way;
   * what the selection decides is whether the form reopens on the id when a
   * following read carries it again, for a style the user has not chosen in
   * that state of the document.
   */
  it("clears the highlight when the table no longer carries the style", async () => {
    const withoutBody: StyleTable = {
      version: "1.0",
      styles: TABLE.styles.filter((row) => row.id !== BODY_ID),
    };
    const harness = await openPanel({ ...styleEngine({ tables: [TABLE, withoutBody, TABLE] }) });
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    fireEvent.change(screen.getByLabelText(en["styles.size"]), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: en["styles.updateSubmit"] }));
    await applyQueued(harness, 1);
    await waitFor(() => expect(screen.queryByRole("button", { name: /바탕글/ })).toBeNull());
    expect(screen.queryByLabelText(en["styles.size"])).toBeNull();

    // Undo returns a table that carries the id again. The highlight was
    // retired when the row went, so the form stays closed.
    const undo = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    await waitFor(() => expect(undo.disabled).toBe(false));
    fireEvent.click(undo);
    const body = await screen.findByRole("button", { name: /바탕글/ });
    expect(body.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByLabelText(en["styles.size"])).toBeNull();
  });

  /**
   * n11: a press that cannot do anything still has to answer. A table-less
   * document says so on every press, and a document with no paragraph style
   * sends the preset alone.
   */
  it("says nothing changed when a table-less document's preset is pressed again", async () => {
    await openPanel(styleEngine({ report: presetReport("failed", 0) }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    expect(await screen.findByText(en["styles.noTableToStyleNoChange"])).toBeTruthy();
  });

  it("sends the preset alone, and says so, when the document defines no paragraph style", async () => {
    const table: StyleTable = {
      version: "1.0",
      styles: [{
        id: 0, name: "강조", english_name: "", kind: "character", next_style: 0, attrs: ATTRS, used_by: ["p2"],
      }],
    };
    // The report carries what the batch carried: one op, the preset, because
    // there is no paragraph style to update.
    const harness = await openPanel(styleEngine({ table, report: presetReport("failed", 0, true) }));
    fireEvent.click(await screen.findByRole("button", { name: en["styles.presetSubmit"] }));
    await waitFor(() => expect(harness.edits).toHaveLength(1));
    expect(harness.edits[0]!.ops).toEqual([{ kind: "style-tables", preset: "official" }]);
    // No style change was in the batch, so the sentence cannot say the body
    // style already matches: there was no body-style write to report on.
    expect(await screen.findByText(en["styles.noBodyStyleToUpdate"])).toBeTruthy();
    expect(screen.queryByText(en["styles.noTableToStyle"])).toBeNull();
  });

  /**
   * A document WITH a table says something too when its preset is already in
   * place: a press that did nothing must not look like a dead button.
   */
  it("says the document already matches when a preset is pressed again", async () => {
    await openPanel(styleEngine({ report: presetReport("applied", 0) }));
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    expect(await screen.findByText(en["styles.presetUnchanged"])).toBeTruthy();
  });

  /**
   * n7: a host that advertises the capability and hands over an engine object
   * with no `styles` to call used to sit on "Reading styles..." forever.
   */
  it("names a host with no styles command instead of reading forever", async () => {
    const base = createMockEngine({ envelope: envelopeWithIds() });
    const engine: HwpEngine = {
      ...base,
      capabilities: async () => ({ ...(await base.capabilities()), styles: "v1" as const }),
    };
    renderEditor(engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    expect(await screen.findByText(en["styles.unavailableHost"])).toBeTruthy();
    expect(screen.queryByText(en["styles.loading"])).toBeNull();
  });

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

  /**
   * n9: the failed-read sentence goes when a later read works, so the notice
   * line never keeps describing a table that has since arrived.
   */
  it("retires the failed-read notice when a later read works", async () => {
    const base = createMockEngine({ envelope: envelopeWithIds() });
    let calls = 0;
    const engine: HwpEngine = {
      ...base,
      capabilities: async () => ({ ...(await base.capabilities()), styles: "v1" as const }),
      styles: async () => {
        calls += 1;
        if (calls === 1) throw new Error("read failed");
        return TABLE;
      },
    };
    const view = renderEditor(engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    // The sentence sits on the notice line and in the panel; both are one
    // condition, and both go when the read works.
    await waitFor(() => expect(screen.getAllByText(en["styles.loadFailed"]).length).toBeGreaterThan(0));

    view.rerender(
      <HwpEditor engine={engine} file={{ name: "y.hwpx", data: new Uint8Array([2]) }} locale="en" />,
    );
    expect(await screen.findByRole("button", { name: /바탕글/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(en["styles.loadFailed"])).toBeNull());
  });

  /**
   * #53 follow-up 3: the read is the tab's own, so the way back from it must
   * not cost the user a reload of the file. One press re-reads the table, and
   * the sentence that described the failure goes with the read that works.
   */
  it("retries a failed read from the tab, without reloading the document", async () => {
    const base = createMockEngine({ envelope: envelopeWithIds() });
    let calls = 0;
    const engine: HwpEngine = {
      ...base,
      capabilities: async () => ({ ...(await base.capabilities()), styles: "v1" as const }),
      styles: async () => {
        calls += 1;
        if (calls === 1) throw new Error("read failed");
        return TABLE;
      },
    };
    renderEditor(engine);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));

    // The cause, and the next step the tab itself can carry out.
    await waitFor(() => expect(screen.getAllByText(en["styles.loadFailed"]).length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /바탕글/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en["styles.retry"] }));

    expect(await screen.findByRole("button", { name: /바탕글/ })).toBeTruthy();
    expect(calls).toBe(2);
    await waitFor(() => expect(screen.queryByText(en["styles.loadFailed"])).toBeNull());
  });
});
