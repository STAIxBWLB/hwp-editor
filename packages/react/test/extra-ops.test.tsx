import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, initialState } from "@hwp-editor/core";
import type { EditorState, EditOp } from "@hwp-editor/core";
import { HwpEditorContext } from "../src/context.js";
import type { HwpEditorContextValue } from "../src/context.js";
import { ImagePanel } from "../src/ImagePanel.js";
import { DocumentPanel } from "../src/DocumentPanel.js";
import { FieldsPanel } from "../src/FieldsPanel.js";
import { SegmentInspector } from "../src/SegmentInspector.js";
import { TableGrid } from "../src/TableGrid.js";
import { createT, en, ko } from "../src/messages.js";
import { createMockEngine, makeEnvelope } from "./mock-engine.js";

afterEach(cleanup);

const locales = [["en", en], ["ko", ko]] as const;
function renderPanel(locale: "en" | "ko", panel: "document" | "fields" | "segment" | "table" | "image", selected = true, addressed = true, envelope = makeEnvelope()) {
  const selection = panel === "table" && !selected ? null : { section: 0, para: panel === "table" ? 2 : 0 };
  const store = createStore({ ...initialState, document: { name: "test.hwpx", data: new Uint8Array([1]) }, selection } as EditorState);
  const engine = createMockEngine();
  const value = {
    engine,
    store,
    state: store.getState(),
    envelope,
    capabilities: { version: "1.3.1", editable: true, formats: ["hwp", "hwpx"], ...(addressed ? { editOps: "v1" as const } : {}), ...(panel === "image" ? { imageAssets: "v1" as const } : {}) },
    editable: true,
    validation: null,
    applyPendingOps: () => undefined,
    replaceDocument: async () => true,
    refresh: async () => undefined,
    openCompose: () => undefined,
    t: createT(locale),
  } as HwpEditorContextValue;
  const component = panel === "document" ? <DocumentPanel />
    : panel === "fields" ? <FieldsPanel />
      : panel === "segment" ? <SegmentInspector /> : panel === "table" ? <TableGrid /> : <ImagePanel />;
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
    expect(screen.getByText(plain(messages, "fields.deleteAllHint"))).toBeTruthy();
    expect(screen.getByText(plain(messages, "fields.deleteAllBookmarksHint"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.anchorAria")), { target: { value: "회의록" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.nameAria")), { target: { value: "department" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.initialValueAria")), { target: { value: "AI" } });
    fireEvent.click(screen.getAllByRole("button", { name: plain(messages, "fields.createFieldSubmit") }).at(-1)!);
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.deleteFieldNameAria")), { target: { value: "oldField" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "fields.deleteField") }));
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.bookmarkAnchorAria")), { target: { value: "회의록" } });
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.bookmarkNameAria")), { target: { value: "sectionStart" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "fields.createBookmark") }));
    fireEvent.change(screen.getByLabelText(plain(messages, "fields.deleteBookmarkNameAria")), { target: { value: "oldMark" } });
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
    fireEvent.change(screen.getByLabelText(plain(messages, "table.addTableRowsLabel")), { target: { value: "| Item | Value |" } });
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

describe.each(locales)("unit controls (%s)", (locale, messages) => {
  it("refuses negative, leading-dot and exponent page dimensions before queueing", () => {
    const store = renderPanel(locale, "document");
    for (const value of ["-5", ".5", "1e2"]) {
      fireEvent.change(screen.getByLabelText(plain(messages, "document.pageValueAria")), { target: { value } });
      const button = screen.getByRole("button", { name: plain(messages, "document.setPage") });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(queued(store)).toEqual([]);
      expect(screen.getByRole("alert").textContent).toBe(plain(messages, "unit.invalid"));
    }
  });
  it("refuses invalid paragraph and font units before queueing", () => {
    const store = renderPanel(locale, "segment");
    fireEvent.change(screen.getByLabelText(plain(messages, "segment.paraShapeKeyAria")), { target: { value: "indent" } });
    for (const value of ["-5", ".5", "1e2"]) {
      fireEvent.change(screen.getByLabelText(plain(messages, "segment.paraShapeValueAria")), { target: { value } });
      const button = screen.getByRole("button", { name: plain(messages, "segment.setPara") });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(queued(store)).toEqual([]);
    }
    fireEvent.change(screen.getByLabelText(plain(messages, "segment.paraShapeValueAria")), { target: { value: "" } });
    for (const value of ["-5", ".5", "1e2"]) {
      fireEvent.change(screen.getByLabelText(plain(messages, "segment.sizeAria")), { target: { value } });
      const button = screen.getByRole("button", { name: plain(messages, "segment.formatSubmit") });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(queued(store)).toEqual([]);
      expect(screen.getByRole("alert").textContent).toBe(plain(messages, "unit.invalid"));
    }
  });
  it("keeps anchored hyperlink controls available without addressed edit support", () => {
    const store = renderPanel(locale, "segment", true, false);
    fireEvent.change(screen.getByLabelText(plain(messages, "segment.hyperlinkUrlAria")), { target: { value: "https://example.test" } });
    fireEvent.click(screen.getByRole("button", { name: plain(messages, "segment.createHyperlink") }));
    expect(queued(store)).toEqual([{kind:"create-hyperlink",anchor:"1. 회의록",url:"https://example.test"}]);
    expect(screen.getByText(plain(messages, "segment.hyperlinkHint"))).toBeTruthy();
  });
});

describe.each(locales)("delete scope and hyperlink separators (%s)", (locale, messages) => {
  it("warns about all image matches and supports providers without queueImage", () => {
    renderPanel(locale, "image");
    expect(screen.getByText(plain(messages, "image.deleteAllHint"))).toBeTruthy();
    expect((screen.getByLabelText(plain(messages, "image.file")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(plain(messages, "image.unsupported"))).toBeTruthy();
  });
  it.each([false, true])("refuses separator input only on a legacy host (JSON=%s)", addressed => {
    for (const example of [
      { anchor: "A=>B", text: "Label", url: "https://example.test" },
      { anchor: "Safe", text: "A=>B", url: "https://example.test" },
      { anchor: "Safe", text: "Label", url: "https://example.test/?x=A=>B" },
    ]) {
      cleanup();
      const envelope = { markdown: example.anchor, segments: [{kind: "para" as const, section: 0, para: 0, start: 0, end: example.anchor.length}] };
      const store = renderPanel(locale, "segment", true, addressed, envelope);
      fireEvent.change(screen.getByLabelText(plain(messages, "segment.hyperlinkUrlAria")), {target:{value:example.url}});
      fireEvent.change(screen.getByLabelText(plain(messages, "segment.hyperlinkTextAria")), {target:{value:example.text}});
      const button = screen.getByRole("button", {name:plain(messages, "segment.createHyperlink")});
      expect((button as HTMLButtonElement).disabled).toBe(!addressed);
      fireEvent.click(button);
      if (addressed) expect(queued(store)).toEqual([{kind:"create-hyperlink",...example}]);
      else {
        expect(queued(store)).toEqual([]);
        expect(screen.getByRole("alert").textContent).toBe(plain(messages,"segment.legacyHyperlinkSeparator"));
      }
    }
  });
  it("requires positive page width and height while allowing zero margins", () => {
    const store = renderPanel(locale, "document");
    for (const key of ["width", "height"]) {
      fireEvent.change(screen.getByLabelText(plain(messages,"document.pageKeyAria")), {target:{value:key}});
      fireEvent.change(screen.getByLabelText(plain(messages,"document.pageValueAria")), {target:{value:"0"}});
      expect((screen.getByRole("button",{name:plain(messages,"document.setPage")}) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("alert").textContent).toBe(plain(messages,"document.invalidDimension"));
    }
    fireEvent.change(screen.getByLabelText(plain(messages,"document.pageKeyAria")), {target:{value:"margin-left"}});
    fireEvent.change(screen.getByLabelText(plain(messages,"document.pageValueAria")), {target:{value:"0"}});
    fireEvent.click(screen.getByRole("button",{name:plain(messages,"document.setPage")}));
    expect(queued(store)).toEqual([{kind:"set-page",key:"margin-left",value:"0"}]);
  });
});

describe.each(locales)("table rows and legacy field creation (%s)", (locale, messages) => {
  it("preserves intended empty cells, skips GFM alignment rows and keeps tabs authoritative", () => {
    const store = renderPanel(locale, "table", false);
    fireEvent.change(screen.getByLabelText(plain(messages,"table.anchorAria")), {target:{value:"Budget"}});
    for (const value of [
      "| | Q1 | Q2 |\n| --- | :---: | ---: |\n| Sales | 10 | 20 |",
      "A|B\tC",
      "| Q1 | Q2 | |",
    ]) {
      fireEvent.change(screen.getByLabelText(plain(messages,"table.addTableRowsLabel")), {target:{value}});
      fireEvent.click(screen.getByRole("button",{name:plain(messages,"table.addTable")}));
    }
    expect(queued(store)).toEqual([
      {kind:"add-table",anchor:"Budget",rows:[["","Q1","Q2"],["Sales","10","20"]]},
      {kind:"add-table",anchor:"Budget",rows:[["A|B","C"]]},
      {kind:"add-table",anchor:"Budget",rows:[["Q1","Q2",""]]},
    ]);
  });
  it.each([false,true])("guards separator-joined creation on legacy hosts only (JSON=%s)", addressed => {
    const store = renderPanel(locale,"fields",true,addressed);
    if (!addressed) expect(screen.getByText(plain(messages,"fields.legacySeparatorHint"))).toBeTruthy();
    for (const example of [{anchor:"A=>B",name:"Name"},{anchor:"Safe",name:"a=b"}]) {
      fireEvent.change(screen.getByLabelText(plain(messages,"fields.anchorAria")),{target:{value:example.anchor}});
      fireEvent.change(screen.getByLabelText(plain(messages,"fields.nameAria")),{target:{value:example.name}});
      const button=screen.getByRole("button",{name:plain(messages,"fields.createFieldSubmit")});
      expect((button as HTMLButtonElement).disabled).toBe(!addressed);
      fireEvent.click(button);
    }
    for (const example of [{anchor:"A=>B",name:"Mark"},{anchor:"Safe",name:"A=>B"}]) {
      fireEvent.change(screen.getByLabelText(plain(messages,"fields.bookmarkAnchorAria")),{target:{value:example.anchor}});
      fireEvent.change(screen.getByLabelText(plain(messages,"fields.bookmarkNameAria")),{target:{value:example.name}});
      const button=screen.getByRole("button",{name:plain(messages,"fields.createBookmark")});
      expect((button as HTMLButtonElement).disabled).toBe(!addressed);
      fireEvent.click(button);
    }
    expect(queued(store)).toHaveLength(addressed ? 4 : 0);
  });
  it("refuses separator-bearing table anchors on legacy hosts with a localized hint", () => {
    const store = renderPanel(locale,"table",false,false);
    expect(screen.getByText(plain(messages,"table.legacySeparatorHint"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(plain(messages,"table.anchorAria")),{target:{value:"A=>B"}});
    fireEvent.change(screen.getByLabelText(plain(messages,"table.addTableRowsLabel")),{target:{value:"A|B"}});
    const button=screen.getByRole("button",{name:plain(messages,"table.addTable")});
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(queued(store)).toEqual([]);
  });
  it("refuses zero font/line-spacing and whitespace-only metadata", () => {
    const store = renderPanel(locale,"segment");
    fireEvent.change(screen.getByLabelText(plain(messages,"segment.paraShapeValueAria")),{target:{value:"0"}});
    expect((screen.getByRole("button",{name:plain(messages,"segment.setPara")}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(plain(messages,"unit.positive"));
    fireEvent.change(screen.getByLabelText(plain(messages,"segment.paraShapeValueAria")),{target:{value:""}});
    fireEvent.change(screen.getByLabelText(plain(messages,"segment.sizeAria")),{target:{value:"0"}});
    expect((screen.getByRole("button",{name:plain(messages,"segment.formatSubmit")}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(plain(messages,"unit.positive"));
    expect(queued(store)).toEqual([]);
    cleanup();
    const metadata = renderPanel(locale,"document");
    fireEvent.change(screen.getByLabelText(plain(messages,"document.metaTitle")),{target:{value:"   "}});
    const button=screen.getAllByRole("button",{name:plain(messages,"document.setMeta")})[0]!;
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(queued(metadata)).toEqual([]);
  });
});
