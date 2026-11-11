import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope } from "@hwp-editor/core";
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
        faces: ["Test"],
        face_ids: [1],
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
    fireEvent.click(options[4]!, { shiftKey: true });
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(5);
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 5 }))).toBeTruthy();

    fireEvent.change(screen.getByLabelText(messages["segment.paraShapeValueAria"]), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: messages["segment.setPara"] }));
    await waitFor(() => expect(screen.getByText(messages["toolbar.pendingEdits"]({ count: 5 }))).toBeTruthy());
    const pending = screen.getByRole("list", { name: messages["toolbar.pendingList"] });
    expect(pending.querySelectorAll("li")).toHaveLength(5);
    expect([...pending.querySelectorAll("li")].every((item) => item.textContent?.includes("set-para"))).toBe(true);
    expect((screen.getByLabelText(messages["segment.replaceLabel"]) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(messages["segment.multiTextEditHint"])).toBeTruthy();
  });

  it("toggles from the list and selects paragraphs with matching direct formatting", async () => {
    render(<HwpEditor engine={createMockEngine({ envelope: fiveParagraphs() })} file={file} locale={locale} />);
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[0]!);
    fireEvent.click(options[1]!, { ctrlKey: true });
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: messages["segment.similarChar"] }));
    const chosen = screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true");
    expect(chosen).toHaveLength(2);
    expect(chosen.map((option) => option.textContent)).toEqual(["Paragraph one", "Paragraph three"]);
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 2 }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: messages["segment.similarPara"] }));
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(4);
    expect(screen.getByText(messages["segment.selectedCount"]({ count: 4 }))).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("option", { name: "Paragraph two" }), { key: "Enter", ctrlKey: true });
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(5);
  });
});
