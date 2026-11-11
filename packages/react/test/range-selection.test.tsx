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
      { id: "run-first", indices: [0, 0], start: 0, end: 2, kind: "run", section: 0, para: 0 },
      { id: "run-second", indices: [0, 1], start: 2, end: 5, kind: "run", section: 0, para: 0 },
    ],
  };
}

/**
 * One paragraph of `markdown` split into the given runs, all in section 0.
 * The runs must tile the markdown, which is what the projection promises.
 */
function sentenceEnvelope(markdown: string, runs: Array<[number, number]>): CatEnvelope {
  const end = [...markdown].length;
  return {
    markdown,
    segments: [
      { id: "para-one", indices: [0], start: 0, end, kind: "para", section: 0, para: 0 },
      ...runs.map(([start, runEnd], at) => ({
        id: `run-${at}`, indices: [0, at], start, end: runEnd, kind: "run" as const, section: 0, para: 0,
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
    const engine = createMockEngine({ envelope: rangeEnvelope() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    await selectRange(textarea, 0, markdown.length);
    fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value: "owner" } });
    const make = screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement;
    expect(make.disabled).toBe(false);
    fireEvent.click(make);
    fireEvent.click(await screen.findByRole("button", { name: messages["toolbar.applyWithCount"]({ count: 1 }) }));
    await waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    // The find is the paragraph's TEXT, not its Markdown: `hwp edit` matches
    // document text, so the markers around the selected runs are stripped.
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { id: "para-first" }, find: "Bold😀!", replace: "{{owner}}" },
    ]);
  });

  it("refuses a range that starts or ends inside a run instead of replacing the rest of it", async () => {
    const engine = createMockEngine({ envelope: rangeEnvelope() });
    render(<HwpEditor engine={engine} file={file} locale={locale} />);
    const textarea = await selectFirstParagraph(messages);
    // Scalars 0..4 end inside run-bold (0..8), so the op would replace text
    // the user did not select.
    await selectRange(textarea, 0, 4);
    fireEvent.change(screen.getByLabelText(messages["segment.placeholderNameAria"]), { target: { value: "owner" } });
    expect((screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderWholeRuns"])).toBeTruthy();
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
    expect(screen.getByText(messages["segment.placeholderAmbiguous"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("offers no placeholder until a range exists", async () => {
    render(<HwpEditor engine={createMockEngine({ envelope: rangeEnvelope() })} file={file} locale={locale} />);
    await selectFirstParagraph(messages);
    expect((screen.getByRole("button", { name: messages["segment.placeholderCreate"] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderNoRange"])).toBeTruthy();
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
  ) {
    const envelope = sentenceEnvelope(markdown, runs);
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
      expect(screen.getByText(messages["segment.placeholderRiskyMarkup"])).toBeTruthy();
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
      expect(screen.getByText(messages["segment.placeholderRiskyMarkup"])).toBeTruthy();
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
    expect(screen.getByText(messages["segment.placeholderAmbiguous"])).toBeTruthy();
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
    expect(screen.getByText(messages["segment.placeholderGap"])).toBeTruthy();
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
    expect(screen.getByText(messages["segment.placeholderPendingEdits"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses a whitespace-only selection with its own reason", async () => {
    // The space between the words is a run of its own, so the range is whole;
    // it still has no text to turn into a placeholder.
    const engine = await openRange("aa bb", [[0, 2], [2, 3], [3, 5]], 2, 3);
    typeName("x");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderEmptySelection"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("gives the empty name its own hint instead of the braces message", async () => {
    const engine = await openRange("hello", [[0, 5]], 0, 5);
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderNameEmpty"])).toBeTruthy();
    expect(screen.queryByText(messages["segment.placeholderNameInvalid"])).toBeNull();
    expect(screen.queryByText(messages["segment.placeholderRiskyMarkup"])).toBeNull();
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("refuses control characters in the name", async () => {
    const engine = await openRange("hello", [[0, 5]], 0, 5);
    typeName("own\ter");
    expect(make().disabled).toBe(true);
    expect(screen.getByText(messages["segment.placeholderNameInvalid"])).toBeTruthy();
    expect(engine.calls.edit).toHaveLength(0);
  });
});
