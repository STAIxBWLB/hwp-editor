/**
 * AC9: a new document composed from an ordered component list.
 *
 * The assertions read the spec the panel handed the engine — the order of the
 * blocks, the value a param was filled with, and the styles the components
 * resolved — rather than the dialog's own bookkeeping, because a list that
 * renders in order and composes out of order is exactly the bug a UI-only
 * check would miss.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Blocks, Component, DocumentHandle } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import type { HwpEditorHandle } from "../src/HwpEditor.js";
import { en } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = {
  name: "minutes.hwpx",
  data: new TextEncoder().encode("original"),
};

/** Render the empty editor and open the new-document dialog. */
async function openCompose(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: en["canvas.createCta"] }));
  return screen.findByRole("dialog", { name: en["compose.title"] });
}

/** Choose a component in the dialog's picker and add it to the assembly. */
function add(name: string): void {
  fireEvent.change(screen.getByLabelText(en["compose.componentPicker"]), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: en["compose.addComponent"] }));
}

/** The assembly's component names, top to bottom. */
function rows(): string[] {
  const list = screen.getByRole("list", { name: en["compose.assemblyAria"] });
  return Array.from(list.querySelectorAll("li")).map(
    (row) => row.querySelector("strong")?.textContent ?? "",
  );
}

/** The visible text of a paragraph block; "" for anything else. */
function paragraphText(block: Blocks[number]): string {
  if (block.type !== "paragraph") return "";
  return block.runs
    .map((run) => (run.type === "text" ? run.text : ""))
    .join("");
}

describe("ComposePanel component assembly (AC9)", () => {
  it("composes the list in its order, with the params the user set", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={null} />);
    await openCompose();

    add("결재란");
    add("붙임");
    expect(rows()).toEqual(["결재란", "붙임"]);

    // Both order controls move a row, not the list around it.
    fireEvent.click(screen.getByRole("button", { name: en["components.moveUp"]({ name: "붙임" }) }));
    expect(rows()).toEqual(["붙임", "결재란"]);
    fireEvent.click(screen.getByRole("button", { name: en["components.moveDown"]({ name: "붙임" }) }));
    expect(rows()).toEqual(["결재란", "붙임"]);

    fireEvent.change(
      screen.getByLabelText(en["compose.paramAria"]({ component: "결재란", param: "기안자" })),
      { target: { value: "김기안" } },
    );
    fireEvent.change(screen.getByPlaceholderText(en["compose.titlePlaceholder"]), {
      target: { value: "구성 문서" },
    });
    fireEvent.click(screen.getByRole("button", { name: en["compose.submit"] }));

    expect(engine.calls.compose).toHaveLength(1);
    const { spec, name } = engine.calls.compose[0]!;
    expect(name).toBe("구성 문서.hwpx");
    expect(spec.document.metadata).toEqual({ title: "구성 문서" });

    const blocks = spec.document.sections[0]!.blocks;
    // The approval box is a table and the attachment list four paragraphs, so
    // the type sequence alone proves which came first.
    expect(blocks.map((block) => block.type)).toEqual([
      "table",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    const table = blocks[0]!;
    if (table.type !== "table") throw new Error("the approval box did not come first");
    const applicant = table.rows[1]!.cells[0]!.blocks![0]!;
    expect(paragraphText(applicant)).toBe("김기안");
    // An untouched param keeps the component's own value.
    expect(paragraphText(table.rows[2]!.cells[0]!.blocks![0]!)).toBe("2026. 11. 9.");
    expect(blocks.slice(1).map(paragraphText)).toEqual([
      "붙임",
      "붙임 1. 관련 자료 1부.",
      "붙임 2. 세부 일정 1부.",
      "",
    ]);

    // `결재란 셀` is the component's own style; `바탕글` is resolved from the
    // official profile, because hwp compose refuses an undefined reference.
    expect(spec.document.styles?.["결재란 셀"]).toBeDefined();
    expect(spec.document.styles?.["바탕글"]).toBeDefined();
  });

  it("uses the guided form again once the last row is removed", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={null} />);
    await openCompose();

    add("붙임");
    const preset = screen.getByRole("radio", { name: en["presets.report"] });
    const body = screen.getByLabelText(en["compose.bodyLabel"]);
    expect(preset).toHaveProperty("disabled", true);
    expect(body).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: en["components.remove"]({ name: "붙임" }) }));
    expect(preset).toHaveProperty("disabled", false);
    expect(body).toHaveProperty("disabled", false);

    fireEvent.click(preset);
    fireEvent.change(body, { target: { value: "본문 문단" } });
    fireEvent.click(screen.getByRole("button", { name: en["compose.submit"] }));

    const blocks = engine.calls.compose[0]!.spec.document.sections[0]!.blocks;
    expect(blocks.map(paragraphText)).toEqual(["본문 문단"]);
    expect(engine.calls.compose[0]!.spec.document.styles?.["결재란 셀"]).toBeUndefined();
  });

  it("offers the host's catalogue instead of the starters", async () => {
    const custom: Component = {
      name: "시험 상자",
      description: "시험용 구성 요소",
      params: { 값: "기본" },
      blocks: [{ type: "paragraph", runs: [{ type: "text", text: "{{값}}" }] }],
    };
    const engine = createMockEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} components={[custom]} />);
    await screen.findByRole("button", { name: "Page 1" });

    fireEvent.click(screen.getByRole("tab", { name: en["tabs.components"] }));
    expect(
      await screen.findByRole("button", { name: en["components.insert"]({ name: "시험 상자" }) }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: en["components.insert"]({ name: "결재란" }) }),
    ).toBeNull();

    ref.current!.openCompose();
    await screen.findByRole("dialog", { name: en["compose.title"] });
    const picker = screen.getByLabelText(en["compose.componentPicker"]) as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value)).toEqual(["시험 상자"]);

    add("시험 상자");
    fireEvent.change(screen.getByLabelText(en["compose.paramAria"]({ component: "시험 상자", param: "값" })), {
      target: { value: "고친 값" },
    });
    fireEvent.click(screen.getByRole("button", { name: en["compose.submit"] }));

    const blocks = engine.calls.compose[0]!.spec.document.sections[0]!.blocks;
    expect(blocks.map(paragraphText)).toEqual(["고친 값"]);
  });

  it("moves the picker to the new library when the host swaps it", async () => {
    // A host that loads its own folder swaps `components` after the dialog is
    // already open; a picker left on the starters would offer a component the
    // host no longer provides, and compose it.
    const first: Component = {
      name: "첫 묶음",
      description: "처음 카탈로그",
      params: {},
      blocks: [{ type: "paragraph", runs: [{ type: "text", text: "첫" }] }],
    };
    const second: Component = {
      name: "둘째 묶음",
      description: "바뀐 카탈로그",
      params: {},
      blocks: [{ type: "paragraph", runs: [{ type: "text", text: "둘" }] }],
    };
    const engine = createMockEngine();
    const { rerender } = render(<HwpEditor engine={engine} file={null} components={[first]} />);
    fireEvent.click(screen.getByRole("button", { name: en["canvas.createCta"] }));
    await screen.findByRole("dialog", { name: en["compose.title"] });
    expect((screen.getByLabelText(en["compose.componentPicker"]) as HTMLSelectElement).value).toBe("첫 묶음");

    rerender(<HwpEditor engine={engine} file={null} components={[second]} />);
    const picker = screen.getByLabelText(en["compose.componentPicker"]) as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value)).toEqual(["둘째 묶음"]);
    expect(picker.value).toBe("둘째 묶음");
  });
});
