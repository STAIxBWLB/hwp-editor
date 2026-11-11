import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatEnvelope, DirectChar, DocumentHandle } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import type { MessageTable } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = { name: "range.hwpx", data: new Uint8Array([1]) };
const markdown = "**Bold**😀!";

/**
 * The direct character properties a run publishes, in the seven Hangul face
 * slots a v2 host reports. A run's `*`/`**` marker is believed only when these
 * agree with it, so a run that omits them is refused rather than guessed at.
 */
function runChar(bold = false, italic = false): DirectChar {
  return {
    bold,
    italic,
    size_pt: 10,
    color: "#000000",
    faces: [null, null, null, null, null, null, null],
    face_ids: [0, 0, 0, 0, 0, 0, 0],
  };
}

function rangeEnvelope(): CatEnvelope {
  const secondStart = [...markdown].length + 2;
  return {
    markdown: `${markdown}\n\n${markdown}`,
    segments: [
      { id: "para-first", indices: [0], start: 0, end: 10, kind: "para", section: 0, para: 0 },
      { id: "run-bold", indices: [0, 0], start: 0, end: 8, kind: "run", section: 0, para: 0, directChar: runChar(true) },
      { id: "run-emoji", indices: [0, 1], start: 8, end: 10, kind: "run", section: 0, para: 0, directChar: runChar() },
      { id: "para-duplicate", indices: [1], start: secondStart, end: secondStart + 10, kind: "para", section: 0, para: 1 },
      { id: "duplicate-bold", indices: [1, 0], start: secondStart, end: secondStart + 8, kind: "run", section: 0, para: 1, directChar: runChar(true) },
      { id: "duplicate-emoji", indices: [1, 1], start: secondStart + 8, end: secondStart + 10, kind: "run", section: 0, para: 1, directChar: runChar() },
    ],
  };
}

/**
 * One paragraph whose two runs spell the same word, which is the shape an
 * addressed `replace` cannot express: its find text matches every occurrence.
 */
function repeatedEnvelope(): CatEnvelope {
  const text = "aa aa";
  return {
    markdown: text,
    segments: [
      { id: "para-repeat", indices: [0], start: 0, end: 5, kind: "para", section: 0, para: 0 },
      { id: "run-first", indices: [0, 0], start: 0, end: 2, kind: "run", section: 0, para: 0, directChar: runChar() },
      { id: "run-second", indices: [0, 1], start: 2, end: 5, kind: "run", section: 0, para: 0, directChar: runChar() },
    ],
  };
}

/**
 * One paragraph of `markdown` split into the given runs, all in section 0.
 * The runs must tile the markdown, which is what the projection promises, and
 * `chars` overrides the formatting of a run whose markers are under test.
 */
function sentenceEnvelope(
  markdown: string,
  runs: Array<[number, number]>,
  chars: Array<{ bold?: boolean; italic?: boolean }> = [],
): CatEnvelope {
  const end = [...markdown].length;
  return {
    markdown,
    segments: [
      { id: "para-one", indices: [0], start: 0, end, kind: "para", section: 0, para: 0 },
      ...runs.map(([start, runEnd], at) => ({
        id: `run-${at}`, indices: [0, at], start, end: runEnd, kind: "run" as const, section: 0, para: 0,
        directChar: runChar(chars[at]?.bold, chars[at]?.italic),
      })),
    ],
  };
}

function noRunEnvelope(): CatEnvelope {
  return {
    markdown,
    segments: [{ id: "para-no-runs", indices: [0], start: 0, end: 10, kind: "para", section: 0, para: 0 }],
  };
}

/** A plain body paragraph beside one that holds an `{{owner}}` slot. */
function slotEnvelope(): CatEnvelope {
  const body = "Bold text";
  const slot = "Owner: {{owner}}";
  const slotStart = [...body].length + 2;
  return {
    markdown: `${body}\n\n${slot}\n\n`,
    segments: [
      { id: "para-body", indices: [0], start: 0, end: body.length, kind: "para", section: 0, para: 0 },
      { id: "run-body", indices: [0, 0], start: 0, end: body.length, kind: "run", section: 0, para: 0, directChar: runChar() },
      { id: "para-slot", indices: [1], start: slotStart, end: slotStart + slot.length, kind: "para", section: 0, para: 1 },
      { id: "run-slot", indices: [1, 0], start: slotStart, end: slotStart + slot.length, kind: "run", section: 0, para: 1, directChar: runChar() },
    ],
  };
}

/** A table cell's own paragraph, nested four indices deep inside the table. */
function cellEnvelope(): CatEnvelope {
  const table = "| ab |\n| --- |";
  const tableStart = 6;
  const cellStart = tableStart + 2;
  return {
    markdown: `body\n\n${table}\n\n`,
    segments: [
      { id: "para-body", indices: [1], start: 0, end: 4, kind: "para", section: 0, para: 0 },
      { id: "run-body", indices: [1, 0], start: 0, end: 4, kind: "run", section: 0, para: 0, directChar: runChar() },
      { id: "para-table", indices: [2], start: tableStart, end: tableStart + table.length, kind: "para", section: 0, para: 1 },
      { id: "table", indices: [2, 0], start: tableStart, end: tableStart + table.length, kind: "table", section: 0, para: 1 },
      { id: "cell", indices: [2, 0, 0], start: cellStart, end: cellStart + 2, kind: "cell", section: 0, para: 1 },
      { id: "para-cell", indices: [2, 0, 0, 0], start: cellStart, end: cellStart + 2, kind: "para", section: 0, para: 1 },
      { id: "run-cell", indices: [2, 0, 0, 0, 0], start: cellStart, end: cellStart + 2, kind: "run", section: 0, para: 1, directChar: runChar() },
    ],
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

  it("addresses characters inside one run with the run id and its source window", async () => {
    // A schema 1.1 host publishes where the run's characters are, so three of
    // six are addressed as a window instead of widening to the whole run.
    const text = "동일문 안내";
    const envelope: CatEnvelope = {
      markdown: `${text}\n\n`,
      segments: [
        { id: "para-one", indices: [0], start: 0, end: 6, kind: "para", section: 0, para: 0 },
        { id: "run-one", indices: [0, 0], start: 0, end: 6, kind: "run", section: 0, para: 0,
          directChar: runChar(), sourceChars: { start: 0, end: 6 } },
      ],
    };
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, 3);
    expect(await screen.findByText(messages["segment.rangeRunCount"]({ count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(messages["segment.bold"]));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.formatSubmit"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-format", address: { id: "run-one", chars: [0, 3] }, props: { bold: "on" } },
    ]);
    // A mapped window is not a whole-run target, so the row does not say it is.
    expect(screen.queryByText(messages["segment.rangeWholeRunTargets"]({ count: 1 }))).toBeNull();
  });

  it("labels a widened target as the whole run in the pending row", async () => {
    // The published span is not the text this run shows, which puts it outside
    // the allow-list: the selection widens to the whole run, and the row says
    // so before anything is applied rather than leaving the count to imply a
    // character-level edit.
    const text = "abcdef";
    const envelope: CatEnvelope = {
      markdown: `${text}\n\n`,
      segments: [
        { id: "para-one", indices: [0], start: 0, end: 6, kind: "para", section: 0, para: 0 },
        { id: "run-one", indices: [0, 0], start: 0, end: 6, kind: "run", section: 0, para: 0,
          directChar: runChar(), sourceChars: { start: 0, end: 4 } },
      ],
    };
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, 3);
    expect(await screen.findByText(messages["segment.rangeWholeRunTargets"]({ count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(messages["segment.bold"]));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.formatSubmit"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([{ kind: "set-format", address: { id: "run-one" }, props: { bold: "on" } }]);
  });

  it("names no target when a drag stops on a run's opening marker", async () => {
    // The AC2 shape: a plain run, a bold " / " and an italic copy of the first
    // word. A drag that ends on the italic run's `*` touches the run and
    // covers none of its characters, so that run is not a target at all -
    // widening it would reformat the second occurrence.
    const markdown = "동일문 안내 **/** *동일문*";
    const envelope: CatEnvelope = {
      markdown: `${markdown}\n\n`,
      segments: [
        { id: "para-one", indices: [0], start: 0, end: 18, kind: "para", section: 0, para: 0 },
        { id: "run-plain", indices: [0, 0], start: 0, end: 6, kind: "run", section: 0, para: 0,
          directChar: runChar(), sourceChars: { start: 0, end: 6 } },
        { id: "run-slash", indices: [0, 1], start: 6, end: 13, kind: "run", section: 0, para: 0,
          directChar: runChar(true), sourceChars: { start: 6, end: 9 } },
        { id: "run-italic", indices: [0, 2], start: 13, end: 18, kind: "run", section: 0, para: 0,
          directChar: runChar(false, true), sourceChars: { start: 9, end: 12 } },
      ],
    };
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 13, 14);
    expect((await screen.findByRole("alert")).textContent).toContain(messages["segment.rangeInvalid"]);
    expect(screen.queryByText(messages["segment.rangeRunCount"]({ count: 1 }))).toBeNull();
    expect((screen.getByRole("button", { name: messages["segment.formatSubmit"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(engine.calls.edit).toHaveLength(0);
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
    // Half of a surrogate pair has no scalar boundary to land on, which is a
    // different mistake from a selection that lands on characters and covers
    // none of a run, so it gets its own sentence.
    expect((await screen.findByRole("alert")).textContent).toContain(messages["segment.rangeSplit"]);
    expect((await screen.findByRole("alert")).textContent).not.toContain(messages["segment.rangeInvalid"]);
    expect((screen.getByRole("button", { name: messages["segment.formatSubmit"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(halfEngine.calls.edit).toHaveLength(0);
  });

  it("reads the range against the document's own format (t30-c1)", async () => {
    // Measured on ahwp 1.6.1: "동일문 안내" publishes source_chars (0, 7) for
    // six characters as an HWP5 last run (its stored break), and an HWPX run
    // whose edge space was trimmed publishes the same numbers. Only the file
    // name tells the two apart, so the name is what the panel reads.
    const envelope: CatEnvelope = {
      markdown: "동일문 안내\n\n",
      segments: [
        { id: "para-one", indices: [0], start: 0, end: 6, kind: "para", section: 0, para: 0 },
        { id: "run-one", indices: [0, 0], start: 0, end: 6, kind: "run", section: 0, para: 0,
          directChar: runChar(), sourceChars: { start: 0, end: 7 } },
      ],
    };
    const hwpFile: DocumentHandle = { name: "break.hwp", data: new Uint8Array([1]) };
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={hwpFile} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, 3);
    expect(screen.queryByText(messages["segment.rangeWholeRunTargets"]({ count: 1 }))).toBeNull();
    fireEvent.click(screen.getByLabelText(messages["segment.bold"]));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.formatSubmit"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-format", address: { id: "run-one", chars: [0, 3] }, props: { bold: "on" } },
    ]);

    cleanup();
    // The same numbers under an HWPX name: no allowance, so the run is named
    // whole - and the panel says so before anything is queued, rather than
    // counting a target the user thinks is three characters wide.
    const hwpxEngine = createMockEngine({ envelope });
    render(<HwpEditor engine={hwpxEngine} file={file} locale={locale} />);
    const hwpxTextarea = await selectFirstParagraph(messages);
    await selectRange(hwpxTextarea, 0, 3);
    expect(await screen.findByText(messages["segment.rangeWholeRunTargets"]({ count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(messages["segment.bold"]));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.formatSubmit"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(hwpxEngine.calls.edit).toHaveLength(1));
    expect(hwpxEngine.calls.edit[0]?.ops).toEqual([
      { kind: "set-format", address: { id: "run-one" }, props: { bold: "on" } },
    ]);
  });

  it("labels a widened target that still carries a window (t30-c3)", async () => {
    // A split run emits every piece with its own source window, because an op
    // carrying the id alone would format both pieces. So a piece the range was
    // widened to looks exactly like one it mapped, and the label has to come
    // from the coverage answer. This piece holds an ampersand, which the
    // client never maps character for character (t30-c5).
    const envelope: CatEnvelope = {
      markdown: "a&b|c\n\n",
      segments: [
        { id: "para-one", indices: [0], start: 0, end: 5, kind: "para", section: 0, para: 0 },
        { id: "amp", indices: [0, 0], start: 0, end: 3, kind: "run", section: 0, para: 0,
          directChar: runChar(), sourceChars: { start: 0, end: 3 } },
        { id: "amp", indices: [0, 1], start: 4, end: 5, kind: "run", section: 0, para: 0,
          directChar: runChar(), sourceChars: { start: 3, end: 4 } },
      ],
    };
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, 1);
    expect(await screen.findByText(messages["segment.rangeRunCount"]({ count: 1 }))).toBeTruthy();
    expect(screen.getByText(messages["segment.rangeWholeRunTargets"]({ count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(messages["segment.bold"]));
    fireEvent.click(screen.getByRole("button", { name: messages["segment.formatSubmit"] }));
    // The queued row names the window it will edit, so the count and the row
    // agree about which characters go with the op.
    const pending = await screen.findByRole("list", { name: messages["toolbar.pendingList"] });
    expect(pending.textContent).toContain(messages["pending.target.chars"]({
      range: messages["pending.target.id"]({ id: "amp" }), start: 0, end: 3,
    }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-format", address: { id: "amp", chars: [0, 3] }, props: { bold: "on" } },
    ]);
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

  it("names the range, not a missing paragraph, as the reason the text controls are off", async () => {
    render(<HwpEditor engine={createMockEngine({ envelope: rangeEnvelope() })} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, markdown.length);
    // The paragraph is selected and one paragraph is what the ops need, so the
    // remedy is the whole paragraph, which is the button beside the range.
    expect((screen.getByLabelText(messages["segment.replaceLabel"]) as HTMLInputElement).disabled).toBe(true);
    expect(await screen.findByText(messages["segment.rangeTextEditHint"])).toBeTruthy();
    expect(screen.queryByText(messages["segment.runTextEditHint"])).toBeNull();
    expect(screen.queryByText(messages["segment.multiTextEditHint"])).toBeNull();
  });
});

describe.each([["en", en], ["ko", ko]] as const)("Making a placeholder from a range (%s)", (locale, messages) => {
  it("queues one addressed replace of the covered runs, with plain text as the find", async () => {
    const engine = createMockEngine({ envelope: sentenceEnvelope("Bold text", [[0, 4], [4, 9]]) });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, 4);
    fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value: "owner" } });
    const make = screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement;
    expect(make.disabled).toBe(false);
    fireEvent.click(make);
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "Bold", replace: "{{owner}}" },
    ]);
  });

  it("joins the covered runs into one find, so a two-run selection is one replace", async () => {
    const engine = createMockEngine({ envelope: sentenceEnvelope("Bold text", [[0, 4], [4, 9]]) });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, 9);
    fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value: "owner" } });
    fireEvent.click(screen.getByRole("button", { name: messages["segment.placeholderCreate"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "Bold text", replace: "{{owner}}" },
    ]);
  });

  it("refuses a range that starts or ends inside a run instead of replacing the rest of it", async () => {
    const engine = createMockEngine({ envelope: sentenceEnvelope("Bold text", [[0, 4], [4, 9]]) });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    // 0..2 ends inside run-0 (0..4), so the op would replace text the user did
    // not select.
    await selectRange(textarea, 0, 2);
    fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value: "owner" } });
    expect((screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses a find text the paragraph repeats, because the engine replaces every match", async () => {
    const engine = createMockEngine({ envelope: repeatedEnvelope() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    fireEvent.click((await screen.findAllByRole("option"))[0]!);
    const textarea = await screen.findByRole("textbox", { name: messages["segment.rangeTextAria"] }) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
    // "aa" is the whole of run-a and occurs twice in the paragraph.
    await selectRange(textarea, 0, 2);
    fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value: "owner" } });
    expect((screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("offers no placeholder until a range exists", async () => {
    render(<HwpEditor engine={createMockEngine({ envelope: rangeEnvelope() })} file={file} locale={locale} />);
    await selectFirstParagraph(messages);
    expect((screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
  });
});

/**
 * The guard is fail-closed: the control is offered only when the client can
 * prove its find text is the engine's own paragraph text. Each case is one
 * way that proof fails, named by the review finding that found it.
 */
describe.each([["en", en], ["ko", ko]] as const)("Placeholder guards (%s)", (locale, messages) => {
  /** Render one paragraph, then select the given scalar range inside it. */
  async function openRange(
    markdown: string,
    runs: Array<[number, number]>,
    from: number,
    to: number,
    extra: CatEnvelope["segments"] = [],
    chars: Array<{ bold?: boolean; italic?: boolean }> = [],
  ) {
    const envelope = sentenceEnvelope(markdown, runs, chars);
    envelope.segments.push(...extra);
    const engine = createMockEngine({ envelope });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, from, to);
    return engine;
  }
  const make = (): HTMLButtonElement =>
    screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement;
  const typeName = (value: string): void => {
    fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value } });
  };

  it("refuses a paragraph whose Markdown hides a second occurrence (t14-g1)", async () => {
    // `~~a~~` and `<u>a</u>` render to the same text the engine holds as `a`,
    // so a find cut from the visible runs reads as unique while the paragraph's
    // own text holds it twice: applying would rewrite the second one too.
    for (const markdown of ["**ab** / ~~a~~b", "<u>a</u>ab"]) {
      const end = [...markdown].length;
      const engine = await openRange(markdown, [[0, end]], 0, end);
      typeName("x");
      expect(make().disabled).toBe(true);
      expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
      expect(engine.calls.edit).toHaveLength(0);
      cleanup();
    }
  });

  it("refuses an underscore or a stray asterisk, which hwp-cli does not escape (t14-g2)", async () => {
    // The emphasis stripper can pair markers the engine never treated as
    // markers, so the paragraph's text becomes a guess: refuse it instead.
    for (const markdown of ["a_x_y_b", "2 * 3"]) {
      const end = [...markdown].length;
      const engine = await openRange(markdown, [[0, end]], 0, end);
      typeName("x");
      expect(make().disabled).toBe(true);
      expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
      expect(engine.calls.edit).toHaveLength(0);
      cleanup();
    }
  });

  it("counts overlapping matches, so a match ahead of the range is not unique (t14-g3)", async () => {
    // "00" occurs at 1 and at 2 in "1000". Counting without overlap would
    // report one match, at the selection, and let the engine rewrite index 1.
    const engine = await openRange("1000", [[0, 2], [2, 4]], 2, 4);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses a range whose outer bounds are whole but that spans a field gap (t14-g4)", async () => {
    // The whole-run check compares the outer bounds only, so a field sitting
    // between the runs would otherwise read as one contiguous stretch of text.
    const engine = await openRange("abcdef", [[0, 3], [3, 6]], 0, 6, [
      { id: "field-mid", indices: [0, 2], start: 3, end: 5, kind: "field", section: 0, para: 0 },
    ]);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("maps a zero-match refusal on Apply to a localized sentence (t14-g4)", async () => {
    const engine = createMockEngine({ envelope: sentenceEnvelope("hello", [[0, 5]]) });
    engine.edit = async () => {
      throw new Error("hwped_edit failed: failed: edit refused: unmatched_replace");
    };
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, 5);
    typeName("owner");
    fireEvent.click(make());
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    // The engine's own line for this names staged paths in Korean, so the
    // client shows the table's sentence instead: neither that prose nor the
    // classification marker may reach the user.
    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert").map(alert => alert.textContent ?? "");
      expect(alerts.some(text => text.includes(messages["error.unmatchedReplace"]))).toBe(true);
    });
    const shown = screen.queryAllByRole("alert").map(alert => alert.textContent ?? "").join(" ");
    expect(shown).not.toContain("unmatched_replace");
  });

  it("refuses to cut a placeholder from text a queued edit will change (t14-g5)", async () => {
    const engine = createMockEngine({ envelope: sentenceEnvelope("name", [[0, 4]]) });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    // A paragraph-level replace of the same text queues first: the placeholder
    // would take its find from a paragraph an apply is about to rewrite.
    fireEvent.change(screen.getByLabelText(messages["segment.replaceLabel"]), { target: { value: "label" } });
    fireEvent.click(screen.getByRole("button", { name: messages["segment.replaceSubmit"] }));
    await waitFor(() => expect(textarea.disabled).toBe(false));
    await selectRange(textarea, 0, 4);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses a whitespace-only selection with its own reason", async () => {
    // The space between the words is a run of its own, so the range is whole;
    // it still has no text to turn into a placeholder.
    const engine = await openRange("aa bb", [[0, 2], [2, 3], [3, 5]], 2, 3);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("gives the empty name its own hint instead of the braces message", async () => {
    const engine = await openRange("hello", [[0, 5]], 0, 5);
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderNameEmpty"])).toBeTruthy();
    expect(screen.queryByText(messages["segment.placeholderNameInvalid"])).toBeNull();
    expect(screen.queryByText(messages["segment.placeholderRefused"])).toBeNull();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses control characters in the name, C1 included", async () => {
    // A tab is C0 and U+0085 is C1: hwp's own field-name check refuses both,
    // so the client must not send either.
    for (const name of ["own\ter", "own\u0085er"]) {
      const engine = await openRange("hello", [[0, 5]], 0, 5);
      typeName(name);
      expect(make().disabled).toBe(true);
      expect(screen.getByText(messages["segment.placeholderNameInvalid"])).toBeTruthy();
      expect(engine.calls.edit).toHaveLength(0);
      cleanup();
    }
  });

  it("replaces the non-space core of a paragraph with an edge space (#72 WP2, t14-g6)", async () => {
    // hwp-cli trims each fragment's edges, so the projection may hide a space
    // the engine's text holds. A find that starts and ends on a non-space never
    // spans such a space, so the core is safe to replace; the edge space stays
    // in the paragraph instead of riding inside the find.
    for (const markdown of [" ab", "ab "]) {
      const end = [...markdown].length;
      const engine = await openRange(markdown, [[0, end]], 0, end);
      typeName("x");
      expect(make().disabled).toBe(false);
      fireEvent.click(make());
      fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
      await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
      expect(engine.calls.edit[0]?.ops).toEqual([
        { kind: "replace", address: { id: "para-one" }, find: "ab", replace: "{{x}}" },
      ]);
      cleanup();
    }
  });

  it("keeps a selected run's edge space out of the find (#72 WP2)", async () => {
    // Run 1 is " bb": selecting it whole must not swallow the separator, or
    // the slot would glue onto "aa" once filled.
    const engine = await openRange("aa bb", [[0, 2], [2, 5]], 2, 5);
    typeName("x");
    expect(make().disabled).toBe(false);
    fireEvent.click(make());
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "bb", replace: "{{x}}" },
    ]);
  });

  it("accepts bold runs that differ only in colour, size or face (#72 WP2)", async () => {
    // The projection writes one `**...**` over runs that share an emphasis, so
    // the markers sit in the first and last run of the group.
    const engine = await openRange("x **ab cd** y", [[0, 2], [2, 6], [6, 11], [11, 13]], 2, 11, [],
      [{}, { bold: true }, { bold: true }, {}]);
    typeName("x");
    expect(make().disabled).toBe(false);
    fireEvent.click(make());
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "ab cd", replace: "{{x}}" },
    ]);
  });

  it("accepts a bold or italic run whose edge space hwp-cli moved outside the markers (t28-a1)", async () => {
    // close_span writes bold "ab " as `**ab** ` and italic " ab" as ` *ab*`:
    // the space is the run's own engine text, outside the marker pair.
    const bold = await openRange("x **ab** y", [[0, 2], [2, 9], [9, 10]], 2, 9, [], [{}, { bold: true }, {}]);
    typeName("x");
    expect(make().disabled).toBe(false);
    fireEvent.click(make());
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(bold.calls.edit).toHaveLength(1));
    expect(bold.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "ab", replace: "{{x}}" },
    ]);
    cleanup();

    const italic = await openRange("x *ab*", [[0, 1], [1, 6]], 1, 6, [], [{}, { italic: true }]);
    typeName("x");
    expect(make().disabled).toBe(false);
    fireEvent.click(make());
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(italic.calls.edit).toHaveLength(1));
    expect(italic.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "ab", replace: "{{x}}" },
    ]);
  });

  it("reads a same-emphasis group as one span, not up to the first closing marker (t28-a2)", async () => {
    // Bold "ab", "c**", "**d" project as `**abc****d**`. Stopping at the
    // first parse would read "c" for run 1 and leave a literal `**` behind;
    // the whole span holds `*` the allow list refuses.
    const engine = await openRange("**abc****d**", [[0, 4], [4, 7], [7, 12]], 4, 7, [],
      [{ bold: true }, { bold: true }, { bold: true }]);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("still refuses a marker group whose runs disagree on emphasis (#72 WP2)", async () => {
    const engine = await openRange("**ab cd**", [[0, 4], [4, 9]], 0, 9, [], [{ bold: true }, {}]);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses while a field edit is queued, whichever paragraph it touches (t14-g7)", async () => {
    const engine = createMockEngine({ envelope: slotEnvelope() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    // A `set-field` writes its value into a paragraph's text, so the queue has
    // to be empty — not merely free of `replace` and its siblings.
    fireEvent.click(await screen.findByRole("tab", { name: messages["tabs.fields"] }));
    fireEvent.change(await screen.findByLabelText(messages["fields.fieldValueAria"]({ name: "owner" })), { target: { value: "Kim" } });
    fireEvent.click(screen.getByRole("button", { name: messages["fields.setValue"] }));
    fireEvent.click(await screen.findByRole("tab", { name: messages["tabs.para"] }));
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[0]!);
    const textarea = await screen.findByRole("textbox", { name: messages["segment.rangeTextAria"] }) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
    // The whole run, so the only thing left that can hold the control off is
    // the queued field edit.
    await selectRange(textarea, 0, 9);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses link syntax but accepts a whole-run bold marker (t14-g9)", async () => {
    // `[b](a)` is stripped to its label, so a find of "a" would match the target
    // the projection never shows. A whole-run `**...**` is the one marker the
    // guard strips, and what it wraps is exactly the engine's run.
    const linked = await openRange("[b](a)", [[0, 6]], 0, 6);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(linked.calls.edit).toHaveLength(0);
    cleanup();

    const bold = await openRange("2**3**4", [[0, 1], [1, 6], [6, 7]], 1, 6, [], [{}, { bold: true }, {}]);
    typeName("x");
    expect(make().disabled).toBe(false);
    fireEvent.click(make());
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(bold.calls.edit).toHaveLength(1));
    expect(bold.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "3", replace: "{{x}}" },
    ]);
  });

  it("believes a marker only when the run's own formatting agrees (t14-g12)", async () => {
    // hwp-cli does not escape `*`, so a plain run whose text is literally
    // `*Note*` projects exactly like an italic one, and stripping it would
    // leave a find the engine's text never holds. The published directChar is
    // the only thing that separates them, and it says plain: refuse.
    const literal = await openRange("*Note*", [[0, 6]], 0, 6);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(literal.calls.edit).toHaveLength(0);
    cleanup();

    // The marked run the projection does describe (italic, not bold) is
    // stripped, and the find is the text inside its markers.
    const italic = await openRange("a*b*c", [[0, 1], [1, 4], [4, 5]], 1, 4, [], [{}, { italic: true }, {}]);
    typeName("x");
    expect(make().disabled).toBe(false);
    fireEvent.click(make());
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(italic.calls.edit).toHaveLength(1));
    expect(italic.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-one" }, find: "b", replace: "{{x}}" },
    ]);
  });

  it("refuses a table cell's own paragraph (t14-g10)", async () => {
    // A cell's projection escapes `&` and `<`, and its path is four levels
    // deep: the paragraph is not body text, so the control stays off.
    const engine = createMockEngine({ envelope: cellEnvelope() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[2]!);
    const textarea = await screen.findByRole("textbox", { name: messages["segment.rangeTextAria"] }) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
    await selectRange(textarea, 0, 2);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderRefused"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("offers one reason that names only what it checks (t14-g11)", async () => {
    // Every refusal shows the same sentence, so it cannot name a cause the
    // guard does not test: it states the precondition and the two next steps.
    const engine = await openRange("a ~~b~~ c", [[0, 9]], 0, 9);
    typeName("x");
    const reason = screen.getByText(messages["segment.placeholderRefused"]);
    expect(reason.textContent).toBe(messages["segment.placeholderRefused"]);
    expect(reason.textContent).not.toContain("link");
    expect(reason.textContent).not.toContain("underline");
    expect(engine.calls.edit).toHaveLength(0);
  });
});

describe.each([["en", en], ["ko", ko]] as const)("Classified engine refusals on Apply (#76, %s)", (locale, messages) => {
  it.each([
    ["run_range_conflict", "error.runRangeConflict"],
    ["range_tag", "error.rangeTagRefused"],
  ] as const)("shows %s as its own sentence, not the engine's line", async (marker, key) => {
    const engine = createMockEngine({ envelope: sentenceEnvelope("hello", [[0, 5]]) });
    engine.edit = async () => {
      throw new Error(`hwped_edit failed: failed: edit refused: ${marker}`);
    };
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    await selectFirstParagraph(messages);
    fireEvent.change(screen.getByLabelText(messages["segment.replaceLabel"]), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: messages["segment.replaceSubmit"] }));
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert").map(alert => alert.textContent ?? "");
      expect(alerts.some(text => text.includes(messages[key]))).toBe(true);
    });
    const shown = screen.queryAllByRole("alert").map(alert => alert.textContent ?? "").join(" ");
    expect(shown).not.toContain(marker);
  });
});
