import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope, DocumentHandle, LayoutRow, PageImage } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine, makePage } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = { name: "canvas-multiselect.hwpx", data: new Uint8Array([1]) };
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("hwped-page")) {
      return {
        top: 0,
        left: 0,
        right: 595,
        bottom: 842,
        width: 595,
        height: 842,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function fixture(): { envelope: CatEnvelope; page: PageImage } {
  const texts = ["One", "Two", "Three", "Four", "Five"];
  let markdown = "";
  const segments: CatEnvelope["segments"] = [];
  const rows: LayoutRow[] = [];
  for (const [para, text] of texts.entries()) {
    const start = [...markdown].length;
    markdown += `${text}\n\n`;
    const id = `paragraph-${para}`;
    segments.push({ id, indices: [para], start, end: start + text.length, kind: "para", section: 0, para });
    rows.push({
      id,
      kind: "para",
      box: { x0: 20, x1: 575, y0: 10 + para * 40, y1: 20 + para * 40 },
      source_chars: { start: 0, end: text.length },
    });
  }
  const page = { ...makePage(), layout: { width_pt: 595, height_pt: 842, truncated: false, rows } };
  return { envelope: { markdown, segments }, page };
}

describe.each([["en", en], ["ko", ko]] as const)("canvas multi-selection (%s)", (locale, messages) => {
  it("extends a five-paragraph range, toggles one item, and paints one band per selected paragraph", async () => {
    const { envelope, page } = fixture();
    const engine = createMockEngine({ envelope });
    engine.render = async () => [page];
    render(<HwpEditor engine={engine} file={file} locale={locale} />);

    const canvasPage = await screen.findByRole("button", { name: messages["page.label"]({ page: 1 }) });
    const clickAt = (para: number, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}): void => {
      fireEvent.click(canvasPage, { clientX: 100, clientY: 15 + para * 40, ...modifiers });
    };
    const selectedBands = (): number => canvasPage.querySelectorAll(".hwped-band-selected").length;

    clickAt(0);
    await waitFor(() => expect(selectedBands()).toBe(1));
    clickAt(4, { shiftKey: true });
    await waitFor(() => expect(selectedBands()).toBe(5));
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 5 }))).toBeTruthy();
    expect(screen.getByText(messages["segment.selectedPara"]({ section: 0, para: 4 }))).toBeTruthy();

    clickAt(2, { ctrlKey: true });
    await waitFor(() => expect(selectedBands()).toBe(4));
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 4 }))).toBeTruthy();
    // Toggling paragraph 2 off removes it from the selection, so the primary falls back to
    // the first remaining paragraph rather than describing a paragraph that is no longer selected.
    expect(screen.getByText(messages["segment.selectedPara"]({ section: 0, para: 0 }))).toBeTruthy();

    clickAt(2, { metaKey: true });
    await waitFor(() => expect(selectedBands()).toBe(5));
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 5 }))).toBeTruthy();
    expect(screen.getByText(messages["segment.selectedPara"]({ section: 0, para: 2 }))).toBeTruthy();
  });
});
