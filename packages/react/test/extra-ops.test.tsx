import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, initialState } from "@hwp-editor/core";
import type { EditorState, EditOp } from "@hwp-editor/core";
import { HwpEditorContext } from "../src/context.js";
import type { HwpEditorContextValue } from "../src/context.js";
import { DocumentPanel } from "../src/DocumentPanel.js";
import { FieldsPanel } from "../src/FieldsPanel.js";
import { SegmentInspector } from "../src/SegmentInspector.js";
import { TableGrid } from "../src/TableGrid.js";
import { createT, en, ko } from "../src/messages.js";
import { createMockEngine, makeEnvelope } from "./mock-engine.js";

afterEach(cleanup);

const locales = [["en", en], ["ko", ko]] as const;
function renderPanel(locale: "en" | "ko", panel: "document" | "fields" | "segment" | "table", selected = true) {
  const selection = panel === "table" && !selected ? null : { section: 0, para: panel === "table" ? 2 : 0 };
  const store = createStore({ ...initialState, document: { name: "test.hwpx", data: new Uint8Array([1]) }, selection } as EditorState);
  const engine = createMockEngine();
  const value = {
    engine,
    store,
    state: store.getState(),
    envelope: makeEnvelope(),
    capabilities: { version: "1.3.1", editable: true, formats: ["hwp", "hwpx"], editOps: "v1" },
    editable: true,
    validation: null,
    applyPendingOps: () => undefined,
    queueImage: () => undefined,
    refresh: async () => undefined,
    openCompose: () => undefined,
    t: createT(locale),
  } as HwpEditorContextValue;
  const component = panel === "document" ? <DocumentPanel />
    : panel === "fields" ? <FieldsPanel />
      : panel === "segment" ? <SegmentInspector /> : <TableGrid />;
  render(<HwpEditorContext.Provider value={value}>{component}</HwpEditorContext.Provider>);
  return store;
}
function plain<K extends keyof typeof en>(table: typeof en | typeof ko, key: K): string {
  const value = table[key];
  if (typeof value !== "string") throw new Error(`${String(key)} is not plain text`);
  return value;
}
function queued(store: ReturnType<typeof createStore>): EditOp[] {
  return store.getState().pendingOps;
}

describe("additional operation controls", () => {
  it.each(locales)("queues every document metadata and page setup op (%s)", (locale, messages) => {
    const store = renderPanel(locale, "document");
    const metaKeys = ["title", "author", "subject", "keywords"] as const;
    const metaLabels = ["document.metaTitle", "document.metaAuthor", "document.metaSubject", "document.metaKeywords"] as const;
    metaLabels.forEach((label, index) => {
      const value = `Metadata ${index}`;
      fireEvent.change(screen.getByLabelText(plain(messages, label)), { target: { value } });
      fireEvent.click(screen.getAllByRole("button", { name: plain(messages, "document.setMeta") })[index]!);
    });
    const pageSettings = [
      ["width", "210"], ["height", "297"], ["margin-left", "20"], ["margin-right", "20"],
      ["margin-top", "25"], ["margin-bottom", "25"], ["orientation", "landscape"],
    ] as const;
    for (const [key, value] of pageSettings) {
      fireEvent.change(screen.getByLabelText(plain(messages, "document.pageKeyAria")), { target: { value: key } });
      if (key === "orientation") {
        fireEvent.change(screen.getByLabelText(plain(messages, "document.pageValueAria")), { target: { value } });
      } else {
        fireEvent.change(screen.getByLabelText(plain(messages, "document.pageValueAria")), { target: { value } });
      }
      fireEvent.click(screen.getByRole("button", { name: plain(messages, "document.setPage") }));
    }
    expect(queued(store)).toEqual([
      ...metaKeys.map((key, index) => ({ kind: "set-meta" as const, key, value: `Metadata ${index}` })),
      ...pageSettings.map(([key, value]) => ({ kind: "set-page" as const, key, value })),
    ]);
  });

  it.each(locales)("queues all addressed paragraph shape keys and anchored hyperlink ops (%s)", (locale, messages) => {
    const store = renderPanel(locale, "segment");
    const shapeKeys = ["line-spacing", "indent", "left", "right", "top", "bottom"] as const;
    for (const [index, key] of shapeKeys.entries()) {
      fireEvent.change(screen.getByLabelText(plain(messages, "segment.paraShapeKeyAria")), { target: { value: key } });
      fireEvent.change(screen.getByLabelText(plain(messages, "segment.paraShapeValueAria")), { target: { value: String(160 + index) } });
      if (key === "line-spacing") {
        fireEvent.click(screen.getByRole("button", { name: plain(messages, "segment.setPara") }));
        fireEvent.change(screen.getByLabelText(plain(messages, "segment.paraShapeUnitAria")), { target: { value: "pt" } });
        fireEvent.click(screen.getByRole("button", { name: plain(messages, "segment.setPara") }));
        fireEvent.change(screen.getByLabelText(plain(messages, "segment.paraShapeUnitAria")), { target: { value: "%" } });
      } else {
        fireEvent.click(screen.getByRole("button", { name: plain(messages, "segment.setPara") }));
      }
    }
    fireEvent.change(screen.getByLabelText(plain(messages, "segment.hyperlinkUrlAria")), { target: { value: "https://example.test" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "segment.hyperlinkTextAria")), { target: { value: "Reference" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "segment.createHyperlink") }));
    fireEvent.change(screen.getByLabelText(plain(messages, "segment.hyperlinkTextAria")), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "segment.createHyperlink") }));
    expect(queued(store)).toEqual([
      { kind: "set-para", address: { at: { section: 0, paragraph: 0 } }, key: "line-spacing", value: "160%" },
      { kind: "set-para", address: { at: { section: 0, paragraph: 0 } }, key: "line-spacing", value: "160pt" },
      ...shapeKeys.slice(1).map((key, index) => ({ kind: "set-para" as const, address: { at: { section: 0, paragraph: 0 } }, key, value: `${161 + index}mm` })),
      { kind: "create-hyperlink", anchor: "1. 회의록", url: "https://example.test", text: "Reference" },
      { kind: "create-hyperlink", anchor: "1. 회의록", url: "https://example.test" },
    ]);
  });

  it.each(locales)("queues field and bookmark create/delete ops (%s)", (locale, messages) => {
    const store = renderPanel(locale, "fields");
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.anchorAria")), { target: { value: "회의록" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.nameAria")), { target: { value: "department" } });
    fireEvent.change(screen.getByLabelText(messages["fields.fieldValueAria"]({ name: "department" })), { target: { value: "AI" } });
    fireEvent.click(screen.getAllByRole("button", { name: plain(messages, "fields.createFieldSubmit") }).at(-1)!);
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.deleteField")), { target: { value: "oldField" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "fields.deleteField") }));
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.bookmarkNameAria")), { target: { value: "sectionStart" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "fields.createBookmark") }));
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.deleteBookmark")), { target: { value: "oldMark" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "fields.deleteBookmark") }));
    expect(queued(store)).toEqual([
      { kind: "create-field", anchor: "회의록", name: "department", value: "AI" },
      { kind: "delete-field", name: "oldField" },
      { kind: "create-bookmark", anchor: "회의록", name: "sectionStart" },
      { kind: "delete-bookmark", name: "oldMark" },
    ]);
  });

  it.each(locales)("can queue a table before any table is selected (%s)", (locale, messages) => {
    const store = renderPanel(locale, "table", false);
    fireEvent.change(screen.getByLabelText(plain(messages, "table.anchorAria")), { target: { value: "Budget" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "table.addTableRowsLabel")), { target: { value: "Item\tValue" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "table.addTable") }));
    expect(queued(store)).toEqual([{ kind: "add-table", anchor: "Budget", rows: [["Item", "Value"]] }]);
  });

  it.each(locales)("queues row-entry table creation and indexed table clone ops (%s)", (locale, messages) => {
    const store = renderPanel(locale, "table");
    fireEvent.change(screen.getAllByLabelText(plain(messages, "table.anchorAria"))[0]!, { target: { value: "Appendix" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "table.addTableRowsLabel")), { target: { value: "Item\tValue\nHours\t10" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "table.addTable") }));
    fireEvent.change(screen.getByLabelText(plain(messages, "table.cloneModeAria")), { target: { value: "blank" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "table.cloneAnchorAria")), { target: { value: "Appendix copy" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "table.cloneTable") }));
    fireEvent.change(screen.getByLabelText(plain(messages, "table.cloneModeAria")), { target: { value: "keep" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "table.cloneTable") }));
    expect(queued(store)).toEqual([
      { kind: "add-table", anchor: "Appendix", rows: [["Item", "Value"], ["Hours", "10"]] },
      { kind: "clone-table", sourceTable: 0, anchor: "Appendix copy", mode: "blank" },
      { kind: "clone-table", sourceTable: 0, anchor: "Appendix copy", mode: "keep" },
    ]);
  });
});
