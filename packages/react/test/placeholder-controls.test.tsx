/**
 * #119 item 3: Make placeholder refuses a selection that covers a schema 1.2
 * run control (tab, hyphen, nb_space, fw_space), before anything is queued.
 * The tab case is real ahwp 2.0.0 output (core fixture
 * cat-segments-controls.json); the other kinds use envelopes in the 1.2 shape.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope, DirectChar, DocumentHandle, RunControl } from "@hwp-editor/core";
import { parseCatEnvelope } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import type { MessageKey, MessageTable } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = { name: "controls.hwpx", data: new Uint8Array([1]) };
const here = dirname(fileURLToPath(import.meta.url));
const realTab = (): CatEnvelope =>
  parseCatEnvelope(readFileSync(join(here, "..", "..", "core", "test", "fixtures", "cat-segments-controls.json"), "utf8"));

const plain: DirectChar = { bold: false, italic: false, size_pt: 10, color: "#000000",
  faces: [null, null, null, null, null, null, null], face_ids: [0, 0, 0, 0, 0, 0, 0] };

/** "Alpha" + control + "Beta": runs [0,5) [5,6) [6,10), the control at 5. */
function controlEnvelope(kind: RunControl["kind"]): CatEnvelope {
  return {
    markdown: "Alpha Beta",
    segments: [
      { id: "para-one", indices: [0], start: 0, end: 10, kind: "para", section: 0, para: 0 },
      { id: "run-0", indices: [0, 0], start: 0, end: 5, kind: "run", section: 0, para: 0, directChar: plain, sourceChars: { start: 0, end: 5 } },
      { id: "run-1", indices: [0, 1], start: 5, end: 6, kind: "run", section: 0, para: 0, directChar: plain, sourceChars: { start: 5, end: 13 },
        controls: [{ kind, at: 5, source: 5 }] },
      { id: "run-2", indices: [0, 2], start: 6, end: 10, kind: "run", section: 0, para: 0, directChar: plain, sourceChars: { start: 13, end: 17 } },
    ],
  };
}

const MESSAGE: Record<RunControl["kind"], MessageKey> = {
  tab: "segment.placeholderControlTab",
  hyphen: "segment.placeholderControlHyphen",
  nb_space: "segment.placeholderControlNbSpace",
  fw_space: "segment.placeholderControlFwSpace",
};

async function select(messages: MessageTable, start: number, end: number): Promise<void> {
  fireEvent.click((await screen.findAllByRole("option"))[0]!);
  const textarea = await screen.findByRole("textbox", { name: messages["segment.rangeTextAria"] }) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.disabled).toBe(false));
  textarea.focus();
  textarea.setSelectionRange(start, end);
  fireEvent.select(textarea);
  fireEvent.keyUp(textarea, { key: "ArrowRight" });
  fireEvent.mouseUp(textarea);
  fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value: "owner" } });
}

const makeButton = (messages: MessageTable): HTMLButtonElement =>
  screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement;

describe.each([["en", en], ["ko", ko]] as const)("Make placeholder across run controls (%s)", (locale, messages) => {
  it("refuses a selection across the real 2.0.0 tab control, queuing nothing", async () => {
    const engine = createMockEngine({ envelope: realTab() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    await select(messages, 0, 6);
    expect(makeButton(messages).disabled).toBe(true);
    expect(await screen.findByText(messages["segment.placeholderControlTab"])).toBeTruthy();
    fireEvent.click(makeButton(messages));
    expect(screen.queryByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) })).toBeNull();
  });

  it("does not blame the tab for a near-miss selection in the real fixture", async () => {
    const engine = createMockEngine({ envelope: realTab() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    await select(messages, 6, 12);
    expect(screen.queryByText(messages["segment.placeholderControlTab"])).toBeNull();
  });

  it.each(["tab", "hyphen", "nb_space", "fw_space"] as const)("refuses a selection across a %s control", async (kind) => {
    const engine = createMockEngine({ envelope: controlEnvelope(kind) });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    await select(messages, 0, 10);
    expect(makeButton(messages).disabled).toBe(true);
    expect(await screen.findByText(messages[MESSAGE[kind]])).toBeTruthy();
    expect(screen.queryByText(messages["segment.placeholderRefused"])).toBeNull();
  });

  it.each(["tab", "hyphen", "nb_space", "fw_space"] as const)("allows the text beside a %s control (near miss)", async (kind) => {
    const engine = createMockEngine({ envelope: controlEnvelope(kind) });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    await select(messages, 0, 5);
    expect(screen.queryByText(messages[MESSAGE[kind]])).toBeNull();
    expect(makeButton(messages).disabled).toBe(false);
    fireEvent.click(makeButton(messages));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "Alpha", replace: "{{owner}}" },
    ]);
  });

  it("keeps today's behavior for an envelope without controls", async () => {
    const bare = controlEnvelope("tab");
    bare.segments = bare.segments.map(({ controls: _, ...rest }) => rest);
    const engine = createMockEngine({ envelope: bare });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    await select(messages, 0, 10);
    for (const key of Object.values(MESSAGE)) expect(screen.queryByText(messages[key])).toBeNull();
    expect(makeButton(messages).disabled).toBe(false);
  });
});
