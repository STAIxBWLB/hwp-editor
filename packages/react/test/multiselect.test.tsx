import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope, EditOp } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const file = { name: "multi.hwpx", data: new Uint8Array([1]) };

function fiveParagraphs(): CatEnvelope {
  const lines = ["Paragraph one", "Paragraph two", "Paragraph three", "Paragraph four", "Paragraph five"];
  let markdown = "";
  const segments: CatEnvelope["segments"] = [];
  for (const [para, line] of lines.entries()) {
    const start = markdown.length;
    markdown += `${line}\n\n`;
    segments.push({
      start,
      end: start + line.length,
      kind: "para",
      section: 0,
      para,
      directChar: {
        bold: para === 0 || para === 2,
        italic: false,
        size_pt: 10,
        color: "#000000",
        faces: Array(7).fill("Test"),
        face_ids: Array(7).fill(1),
      },
      directPara: {
        alignment: para === 1 ? "center" : "left",
        indent: 0,
        line_spacing: 100,
        line_spacing_type: 0,
      },
    });
  }
  return { markdown, segments };
}

describe.each([["en", en], ["ko", ko]] as const)("paragraph multi-selection (%s)", (locale, messages) => {
  it("shows a bounded multi-select list and supports shift range selection", async () => {
    render(<HwpEditor engine={createMockEngine({ envelope: fiveParagraphs() })} file={file} locale={locale} />);
    const list = await screen.findByRole("listbox", { name: messages["segment.paragraphChoices"] });
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    expect(list.getAttribute("style")).toContain("max-height: 12rem");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(5);
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 0 }))).toBeTruthy();
    fireEvent.click(options[0]!);
    await waitFor(() => expect((screen.getByLabelText(messages["segment.paraShapeValueAria"]) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(options[4]!, { shiftKey: true });
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(5);
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 5 }))).toBeTruthy();

    fireEvent.change(screen.getByLabelText(messages["segment.paraShapeValueAria"]), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: messages["segment.setPara"] }));
    await waitFor(() => expect(screen.getByText(messages["toolbar.pendingEdits"]({ count: 5 }))).toBeTruthy());
    const pending = screen.getByRole("list", { name: messages["toolbar.pendingList"] });
    expect(pending.querySelectorAll("li")).toHaveLength(5);
    expect(Array.from(pending.querySelectorAll("li")).every((item) => item.textContent?.includes("set-para"))).toBe(true);
    expect((screen.getByLabelText(messages["segment.replaceLabel"]) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(messages["segment.multiTextEditHint"])).toBeTruthy();
  });

  it("toggles from the list and selects paragraphs with matching direct formatting", async () => {
    render(<HwpEditor engine={createMockEngine({ envelope: fiveParagraphs() })} file={file} locale={locale} />);
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[0]!);
    fireEvent.click(options[1]!, { ctrlKey: true });
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(2);

    const choice = (index: number, text: string): string => messages["segment.choiceLabel"]({ index, text });
    fireEvent.click(screen.getByRole("option", { name: choice(1, "Paragraph one") }));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.similarChar"] }));
    const chosen = screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true");
    expect(chosen).toHaveLength(2);
    expect(chosen.map((option) => option.textContent)).toEqual([choice(1, "Paragraph one"), choice(3, "Paragraph three")]);
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 2 }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: messages["segment.similarPara"] }));
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(4);
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 4 }))).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("option", { name: choice(2, "Paragraph two") }), { key: "Enter", ctrlKey: true });
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(5);
  });
});

/**
 * A component starter that inserts several paragraphs leaves exactly this
 * selection: the run of paragraphs it created, all siblings of one another.
 * Move and delete therefore have to act on the run — one `move-para` of the
 * neighbouring paragraph across the whole run, or one `delete-para` per
 * paragraph in a single batch — instead of turning the controls off.
 *
 * Paragraph 0 is the section's definition paragraph here, as it is in every
 * document the engine reads: it carries `SectionDef`, so it cannot move and
 * nothing moves above it. A test that reorders therefore starts at 1.
 */
describe("paragraph run reorder and delete", () => {
  /** Five paragraphs the engine named, as segment-envelope-v2 addresses them. */
  function addressedFive(): CatEnvelope {
    const envelope = fiveParagraphs();
    return {
      ...envelope,
      segments: envelope.segments.map((segment, para) => ({
        ...segment,
        id: `${"a".repeat(16)}.0.${para}`,
        indices: [para],
      })),
    };
  }

  const ids = (envelope: CatEnvelope) => envelope.segments.map((segment) => segment.id!);

  /** Click Apply for the queued ops and return what the engine was sent. */
  async function apply(messages: typeof en, count: number, engine: ReturnType<typeof createMockEngine>): Promise<EditOp[]> {
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    return engine.calls.edit[0]!.ops;
  }

  it.each([["en", en], ["ko", ko]] as const)("moves a contiguous run as one block (%s)", async (locale, messages) => {
    const envelope = addressedFive();
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const options = await screen.findAllByRole("option");
    // Paragraphs 2..4: the neighbour that moves across the run is paragraph 1,
    // because paragraph 0 is the section's definition paragraph.
    fireEvent.click(options[2]!);
    fireEvent.click(options[4]!, { shiftKey: true });
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 3 }))).toBeTruthy();

    const up = screen.getByRole("button", { name: messages["segment.moveUp"] }) as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    fireEvent.click(up);

    // One op, and the paragraph that moves is the neighbour above the run:
    // placing it after the run's last paragraph is what lifts the block.
    const [, id1, , , id4] = ids(envelope);
    expect(await apply(messages, 1, engine)).toEqual([{
      kind: "move-para",
      address: { id: id1 },
      to: { address: { id: id4 }, position: "after" },
    }]);
  });

  it.each([["en", en], ["ko", ko]] as const)("deletes a contiguous run as one addressed batch (%s)", async (locale, messages) => {
    const envelope = addressedFive();
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[2]!);
    fireEvent.click(options[4]!, { shiftKey: true });

    const remove = screen.getByRole("button", { name: messages["segment.deletePara"] }) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);

    // One entry per paragraph, in document order, still one batch and one undo.
    const [, , id2, id3, id4] = ids(envelope);
    expect(await apply(messages, 3, engine)).toEqual([
      { kind: "delete-para", address: { id: id2 } },
      { kind: "delete-para", address: { id: id3 } },
      { kind: "delete-para", address: { id: id4 } },
    ]);
  });

  it("keeps move and delete off, with the reason, for a non-contiguous selection", async () => {
    const envelope = addressedFive();
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale="en" />);
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[0]!);
    fireEvent.click(options[2]!, { ctrlKey: true });
    expect(screen.getByText(en["segment.selectedCount"]({ count: 2 }))).toBeTruthy();

    // Paragraphs 1 and 3 with paragraph 2 left out: no single op means this
    // set, so the controls stay off rather than acting on a set nobody picked.
    for (const name of [en["segment.moveUp"], en["segment.moveDown"], en["segment.deletePara"]]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(en["segment.multiReorderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("allows the run's edge and refuses only past it", async () => {
    const envelope = addressedFive();
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale="en" />);
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[1]!);
    fireEvent.click(options[2]!, { shiftKey: true });

    // The run reaches neither end of the section: down is available, and up is
    // not, because the paragraph that would move across it is the section's
    // definition paragraph at index 0.
    expect((screen.getByRole("button", { name: en["segment.moveUp"] }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: en["segment.moveDown"] }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(en["segment.sectionDefinitionLocked"])).toBeTruthy();
    expect(screen.queryByText(en["segment.multiReorderRefused"])).toBeNull();
  });

  it("keeps the section definition paragraph and everything above it in place", async () => {
    // Body paragraph 0 of a section carries SectionDef: `move_paragraph` will
    // not move it, and moving paragraph 1 up would put it at index 1, so both
    // controls are off with a reason rather than queuing an op the engine
    // refuses with no cause a caller can read.
    const envelope = addressedFive();
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale="en" />);
    const options = await screen.findAllByRole("option");

    fireEvent.click(options[1]!);
    expect((screen.getByRole("button", { name: en["segment.moveUp"] }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: en["segment.moveDown"] }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(en["segment.sectionDefinitionLocked"])).toBeTruthy();

    fireEvent.click(options[0]!);
    for (const name of [en["segment.moveUp"], en["segment.moveDown"]]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(engine.calls.edit).toHaveLength(0);
  });
});
