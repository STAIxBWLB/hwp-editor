import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope, DocumentHandle } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import type { MessageTable } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = { name: "range.hwpx", data: new Uint8Array([1]) };
const markdown = "**Bold**😀!";

function rangeEnvelope(): CatEnvelope {
  const secondStart = [...markdown].length + 2;
  return {
    markdown: `${markdown}\n\n${markdown}`,
    segments: [
      { id: "para-first", indices: [0], start: 0, end: 10, kind: "para", section: 0, para: 0 },
      { id: "run-bold", indices: [0, 0], start: 0, end: 8, kind: "run", section: 0, para: 0 },
      { id: "run-emoji", indices: [0, 1], start: 8, end: 10, kind: "run", section: 0, para: 0 },
      { id: "para-duplicate", indices: [1], start: secondStart, end: secondStart + 10, kind: "para", section: 0, para: 1 },
      { id: "duplicate-bold", indices: [1, 0], start: secondStart, end: secondStart + 8, kind: "run", section: 0, para: 1 },
      { id: "duplicate-emoji", indices: [1, 1], start: secondStart + 8, end: secondStart + 10, kind: "run", section: 0, para: 1 },
    ],
  };
}

function noRunEnvelope(): CatEnvelope {
  return {
    markdown,
    segments: [{ id: "para-no-runs", indices: [0], start: 0, end: 10, kind: "para", section: 0, para: 0 }],
  };
}

function unaddressableRunEnvelope(): CatEnvelope {
  // A nested paragraph whose run carries no id: the range exists, but this
  // client has no address for it, which is the metadata case, not an empty one.
  return {
    markdown,
    segments: [
      { id: "cell-para", indices: [0, 0, 0, 0], start: 0, end: 10, kind: "para", section: 0, para: 0 },
      { indices: [0, 0, 0, 0, 0], start: 0, end: 10, kind: "run", section: 0, para: 0 },
    ],
  };
}

async function selectRange(textarea: HTMLTextAreaElement, start: number, end: number): Promise<void> {
  textarea.focus();
  textarea.setSelectionRange(start, end);
  fireEvent.select(textarea);
  fireEvent.keyUp(textarea, { key: "ArrowRight" });
  fireEvent.mouseUp(textarea);
}

async function selectFirstParagraph(messages: MessageTable): Promise<HTMLTextAreaElement> {
  const options = await screen.findAllByRole("option");
  fireEvent.click(options[0]!);
  const textarea = await screen.findByRole("textbox", { name: messages["segment.rangeTextAria"] }) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.disabled).toBe(false));
  return textarea;
}

describe.each([["en", en], ["ko", ko]] as const)("Markdown run range selection (%s)", (locale, messages) => {
  it("maps UTF-16 selection across two runs to exactly two ID-addressed format ops", async () => {
    const engine = createMockEngine({ envelope: rangeEnvelope() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    expect(textarea.value).toBe(markdown);

    // The textarea length is 11 UTF-16 code units; the Markdown range ends at scalar 10.
    await selectRange(textarea, 0, markdown.length);
    expect(await screen.findByText(messages["segment.rangeRunCount"]({ count: 2 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(messages["segment.bold"]));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.formatSubmit"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 2 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));

    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-format", address: { id: "run-bold" }, props: { bold: "on" } },
      { kind: "set-format", address: { id: "run-emoji" }, props: { bold: "on" } },
    ]);
    expect(JSON.stringify(engine.calls.edit[0]?.ops)).not.toContain('"chars"');
    expect(JSON.stringify(engine.calls.edit[0]?.ops)).not.toContain('"ir"');
  });

  it("maps an emoji-only UTF-16 range to its whole run and rejects a half-surrogate", async () => {
    const engine = createMockEngine({ envelope: rangeEnvelope() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);

    await selectRange(textarea, 8, 10);
    expect(await screen.findByText(messages["segment.rangeRunCount"]({ count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(messages["segment.bold"]));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.formatSubmit"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-format", address: { id: "run-emoji" }, props: { bold: "on" } },
    ]);
    expect(engine.calls.edit[0]?.ops.some((op) => "address" in op && "id" in op.address && op.address.id === "duplicate-emoji")).toBe(false);

    cleanup();
    const halfEngine = createMockEngine({ envelope: rangeEnvelope() });
    render(<HwpEditor engine={halfEngine} file={file} locale={locale} />);
    const halfTextarea = await selectFirstParagraph(messages);
    await selectRange(halfTextarea, 8, 9);
    expect((await screen.findByRole("alert")).textContent).toContain(messages["segment.rangeInvalid"]);
    expect((screen.getByRole("button", { name: messages["segment.formatSubmit"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(halfEngine.calls.edit).toHaveLength(0);
  });

  it("explains in the active locale why a range is off, without blaming the host for an empty paragraph", async () => {
    render(<HwpEditor engine={createMockEngine({ envelope: noRunEnvelope() })} file={file} locale={locale} />);
    fireEvent.click(await screen.findByRole("option"));
    const textarea = await screen.findByRole("textbox", { name: messages["segment.rangeTextAria"] }) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    // A paragraph without runs needs no host upgrade: it has no text range to
    // select inside it, and the host-upgrade remedy would be wrong advice.
    expect(screen.getByText(messages["segment.rangeUnavailableNoRuns"])).toBeTruthy();
    expect(screen.queryByText(messages["segment.rangeUnavailable"])).toBeNull();

    cleanup();
    render(<HwpEditor engine={createMockEngine({ envelope: unaddressableRunEnvelope() })} file={file} locale={locale} />);
    fireEvent.click(await screen.findByRole("option"));
    // A run that exists but has no address is the metadata case.
    expect(await screen.findByText(messages["segment.rangeUnavailable"])).toBeTruthy();
    expect(screen.queryByText(messages["segment.rangeUnavailableNoRuns"])).toBeNull();
  });
});
