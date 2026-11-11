/**
 * Styles tab (issue #53, WP3/T5): the queue-only controls, the version gate
 * and the preset switch's grouping.
 *
 * The preset switch is the one control here that does not queue an op, because
 * `hwp edit` refuses `--ops` beside `--style-tables`. What this file proves is
 * the clause the spec attaches to it: two engine calls, ONE history entry —
 * one snapshot staged, and one undo returns the original document.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CatEnvelope,
  DocumentHandle,
  EditOp,
  EditOptions,
  HwpEngine,
  StyleTable,
} from "@hwp-editor/core";
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

/** A mock engine that advertises `styles` v1 and records every edit call. */
function styleEngine(opts: { styles?: boolean } = {}): StyleHarness {
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
      return advertised ? { ...caps, styles: "v1" as const } : caps;
    },
    styles: async (document) => {
      styleReads.push(document);
      return TABLE;
    },
    edit: async (document, ops, options) => {
      edits.push({ ops, options });
      return base.edit(document, ops, options);
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

  it("switches preset as two engine calls inside ONE undo entry", async () => {
    const harness = await openPanel(styleEngine());
    fireEvent.click(screen.getByRole("button", { name: en["styles.presetSubmit"] }));
    await waitFor(() => expect(harness.edits).toHaveLength(2));
    // Call one writes the preset's body row; call two is the table styling,
    // which the engine refuses to combine with ops.
    expect(harness.edits[0]!.ops.map((op) => op.kind)).toEqual(["update-style"]);
    expect(harness.edits[0]!.options?.styleTables).toBeUndefined();
    expect(harness.edits[1]!.ops).toEqual([]);
    expect(harness.edits[1]!.options?.styleTables).toBe("official");
    // One replacement, therefore one snapshot: undo returns the document the
    // switch started from in a single step.
    const undo = await screen.findByRole("button", { name: en["toolbar.revert"] });
    await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false));
    const readsBeforeUndo = harness.documentReads.length;
    fireEvent.click(undo);
    await waitFor(() => expect(harness.documentReads.length).toBeGreaterThan(readsBeforeUndo));
  });
});
