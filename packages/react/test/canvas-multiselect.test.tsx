import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope, DocumentHandle, LayoutRow, PageImage } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine, makePage } from "./mock-engine.js";
import { bandIdentity } from "../src/PageCanvas.js";

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
    expect(screen.getByText(messages["segment.selectedPara"]({ path: "0/4" }))).toBeTruthy();

    clickAt(2, { ctrlKey: true });
    await waitFor(() => expect(selectedBands()).toBe(4));
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 4 }))).toBeTruthy();
    // Toggling paragraph 2 off removes it from the selection, so the primary falls back to
    // the first remaining paragraph rather than describing a paragraph that is no longer selected.
    expect(screen.getByText(messages["segment.selectedPara"]({ path: "0/0" }))).toBeTruthy();

    clickAt(2, { metaKey: true });
    await waitFor(() => expect(selectedBands()).toBe(5));
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 5 }))).toBeTruthy();
    expect(screen.getByText(messages["segment.selectedPara"]({ path: "0/2" }))).toBeTruthy();
  });
});

describe("band identity", () => {
  it("tells the two pieces of a split run apart, with the span the engine publishes", () => {
    // hwp-cli publishes a run a block control interrupts as two segments under
    // ONE id and one nesting path ("A fragmented run"; "앞" (0, 1) and "뒤"
    // (9, 11) with the control's 8 units between them), so the id names the
    // run and the path names where it sits - neither names a piece. Two bands
    // keyed by either alone collide, and React then keeps one of them.
    const directChar = {
      bold: false, italic: false, size_pt: 10, color: "#000000",
      faces: [null, null, null, null, null, null, null], face_ids: [0, 0, 0, 0, 0, 0, 0],
    };
    const first = { id: "split", indices: [0, 0], start: 0, end: 1, kind: "run" as const,
      section: 0, para: 0, directChar, sourceChars: { start: 0, end: 1 } };
    const second = { ...first, start: 2, end: 3, sourceChars: { start: 9, end: 11 } };
    expect(bandIdentity(first)).not.toBe(bandIdentity(second));
    // Same id, same path, and only the char_range start differs - which is why
    // it is in the key.
    expect(first.id).toBe(second.id);
    expect(first.indices).toEqual(second.indices);
    expect(bandIdentity(first)).toBe("0/0.0:0");
    expect(bandIdentity(second)).toBe("0/0.0:2");
    // A paragraph with no indices of its own still has an identity.
    expect(bandIdentity({ id: "p", start: 0, end: 5, kind: "para", section: 0, para: 3 })).toBe("0/3:0");
  });
});
