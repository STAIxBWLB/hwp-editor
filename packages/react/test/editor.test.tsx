/**
 * Editor flow tests, parameterized over both locales.
 *
 * Every string-dependent suite runs under `describe.each(LOCALES)` and
 * derives its selectors from `tables[locale]`, so the same body proves the
 * flow works in English and in Korean and a copy change can never silently
 * break a selector. Suites whose subject is an op payload or an engine call
 * count are locale-independent by nature: they stay single-locale and take
 * their incidental selectors from `en`.
 *
 * The remaining Korean literals below are document CONTENT (fixture
 * paragraph text, typed input values) or engine-authored prose, which no UI
 * locale translates.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DocumentHandle } from "@hwp-editor/core";
import { HwpEngineError } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import type { Locale, MessageTable } from "../src/messages.js";
import { clientYForPara, createMockEngine, makeEnvelope } from "./mock-engine.js";

afterEach(cleanup);

/**
 * The paragraph's plain text is shown in the inspector quote and, once run
 * metadata exists, again in the whole-run range textarea. Assert on the quote
 * so "the inspector shows this paragraph" stays one element.
 */
function findByQuote(text: string | RegExp): Promise<HTMLElement> {
  return screen.findByText((content, element) => element?.classList.contains("hwped-quote") === true &&
    (typeof text === "string" ? content === text : text.test(content)));
}

const tables: Record<Locale, MessageTable> = { en, ko };
const LOCALES = ["en", "ko"] as const;

const file: DocumentHandle = {
  name: "minutes.hwpx",
  data: new TextEncoder().encode("original"),
};

beforeAll(() => {
  // jsdom reports zero-size boxes; give pages the render's 595x842 rect.
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
    return {
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

/** Click the page so the paragraph at `para` becomes the selection. */
async function selectPara(t: MessageTable, para: number): Promise<void> {
  const page = await screen.findByRole("button", {
    name: t["page.label"]({ page: 1 }),
  });
  fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), para) });
}

/** Select the heading paragraph and queue one replace op against it. */
async function selectAndQueueReplace(t: MessageTable): Promise<void> {
  await selectPara(t, 0);
  await screen.findByText("1. 회의록");
  fireEvent.change(screen.getByLabelText(t["segment.replaceLabel"]), {
    target: { value: "수정됨" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: t["segment.replaceSubmit"] }),
  );
}

/** Click the toolbar Apply while exactly one op is queued. */
async function applyOne(t: MessageTable): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", {
      name: t["toolbar.applyWithCount"]({ count: 1 }),
    }),
  );
}

describe("HwpEditor edit flow", () => {
  // Locale-independent: the subject is the op payload and the callbacks.
  it("render → click → select → queue op → Apply calls engine.edit", async () => {
    const engine = createMockEngine();
    const onChange = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <HwpEditor
        engine={engine}
        file={file}
        onChange={onChange}
        onDirtyChange={onDirtyChange}
      />,
    );

    const page = await screen.findByRole("button", {
      name: en["page.label"]({ page: 1 }),
    });
    // Click near the top of the page selects the heading segment (para 0).
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });

    // The inspector shows the segment's plain text.
    await screen.findByText("1. 회의록");

    const input = screen.getByLabelText(en["segment.replaceLabel"]);
    fireEvent.change(input, { target: { value: "2. 회의록" } });
    fireEvent.click(
      screen.getByRole("button", { name: en["segment.replaceSubmit"] }),
    );

    // Pending count appears; dirty callback fires.
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(
      screen.getByRole("button", {
        name: en["toolbar.applyWithCount"]({ count: 1 }),
      }),
    );

    await screen.findByText(en["toolbar.pendingEdits"]({ count: 0 }));
    expect(engine.calls.edit).toHaveLength(1);
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", address: { at: { section: 0, paragraph: 0 } }, find: "1. 회의록", replace: "2. 회의록" },
    ]);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "edited-1.hwpx" }),
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

describe.each(LOCALES)("HwpEditor keyboard shortcuts — locale=%s", (locale) => {
  const t = tables[locale];

  it("applies queued ops on Cmd/Ctrl+Enter and clears selection on Escape", async () => {
    const engine = createMockEngine();
    const { container } = render(
      <HwpEditor locale={locale} engine={engine} file={file} />,
    );

    const page = await screen.findByRole("button", {
      name: t["page.label"]({ page: 1 }),
    });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 1) });
    await findByQuote("2026년 8월 정기 회의");

    fireEvent.change(screen.getByLabelText(t["segment.replaceLabel"]), {
      target: { value: "2026년 9월 정기 회의" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: t["segment.replaceSubmit"] }),
    );
    await screen.findByText(t["toolbar.pendingEdits"]({ count: 1 }));

    const root = container.firstElementChild;
    if (root === null) throw new Error("no root");
    fireEvent.keyDown(root, { key: "Enter", ctrlKey: true });
    await screen.findByText(t["toolbar.pendingEdits"]({ count: 0 }));
    expect(engine.calls.edit).toHaveLength(1);

    // Select again, then Escape clears the inspector back to the hint.
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 1) });
    await findByQuote("2026년 8월 정기 회의");
    fireEvent.keyDown(root, { key: "Escape" });
    await screen.findByText(t["segment.hint"]);
  });
});

describe.each(LOCALES)("HwpEditor protected documents — locale=%s", (locale) => {
  const t = tables[locale];

  it("shows a read-only notice and disables editing", async () => {
    const engine = createMockEngine({
      editable: false,
      // Engine-authored prose: shown verbatim under either locale.
      reason: "배포용 문서",
    });
    render(<HwpEditor locale={locale} engine={engine} file={file} />);

    await screen.findByText(`${t["toolbar.readOnly"]}: 배포용 문서`);
    await selectPara(t, 0);
    await screen.findByText("1. 회의록");

    expect(
      screen.getByLabelText(t["segment.replaceLabel"]),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: t["segment.replaceSubmit"] }),
    ).toHaveProperty("disabled", true);
    // The counted toolbar CTA, not the inspector's "apply format" button.
    expect(
      screen.getByRole("button", {
        name: t["toolbar.applyWithCount"]({ count: 0 }),
      }),
    ).toHaveProperty("disabled", true);
  });
});

describe.each(LOCALES)("HwpEditor engine error states — locale=%s", (locale) => {
  const t = tables[locale];

  function failingEngine(message: string): ReturnType<typeof createMockEngine> {
    const engine = createMockEngine();
    engine.capabilities = async () => ({
      version: "0.16.0-test",
      editable: true,
      formats: ["hwp", "hwpx"],
    });
    engine.read = async () => {
      throw new Error(message);
    };
    engine.render = async () => {
      throw new Error(message);
    };
    return engine;
  }

  it("renders a timeout badge distinctly from other load failures", async () => {
    render(
      <HwpEditor
        locale={locale}
        engine={failingEngine("hwp-engine HTTP 504: hwp render timed out after 60000ms")}
        file={file}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t["error.prefix.load"]);
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(alert.textContent).toContain(t["error.kind.timeout"]);
  });

  it("renders a binary-missing badge distinctly", async () => {
    render(
      <HwpEditor
        locale={locale}
        engine={failingEngine("hwp-engine HTTP 503: hwp binary not found: hwp")}
        file={file}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("unavailable");
    expect(alert.textContent).toContain(t["error.kind.unavailable"]);
  });

  it("renders an edit-time protected refusal distinctly", async () => {
    const engine = createMockEngine();
    engine.edit = async () => {
      throw new Error(
        "hwp-engine HTTP 422: hwp edit failed: distribution (배포용) document",
      );
    };
    render(<HwpEditor locale={locale} engine={engine} file={file} />);

    await selectAndQueueReplace(t);
    await applyOne(t);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t["error.prefix.apply"]);
    expect(alert.getAttribute("data-error-kind")).toBe("protected");
    expect(alert.textContent).toContain(t["error.kind.protected"]);
  });

  it("renders unknown failures without a kind badge", async () => {
    render(
      <HwpEditor
        locale={locale}
        engine={failingEngine("hwp-engine HTTP 500: boom")}
        file={file}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("generic");
    expect(alert.querySelector(".hwped-error-kind")).toBeNull();
  });

  it("selects the edit badge from the code when the prose has no marker", async () => {
    // Contains none of distribution / encrypted / protected / 배포용, so a
    // "protected" badge here can only have come from the code.
    const engine = createMockEngine();
    engine.edit = async () => {
      throw new HwpEngineError("protected", "이 문서는 편집할 수 없습니다");
    };
    render(<HwpEditor locale={locale} engine={engine} file={file} />);

    await selectAndQueueReplace(t);
    await applyOne(t);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t["error.prefix.apply"]);
    expect(alert.getAttribute("data-error-kind")).toBe("protected");
  });

  it("issues exactly one render call when the load render rejects", async () => {
    // The deleted client-side SVG->PNG catch-all turned any render failure
    // into a second full CLI render and hid which error occurred (BUG-01).
    const engine = createMockEngine();
    let renders = 0;
    engine.render = async () => {
      renders += 1;
      throw new HwpEngineError("timeout", "hwp render timed out after 60000ms");
    };
    render(<HwpEditor locale={locale} engine={engine} file={file} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t["error.prefix.load"]);
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(renders).toBe(1);
  });

  it("selects the badge from the error code, not from the message prose", async () => {
    // The message deliberately contains none of the classifyEngineError
    // substring markers: a "timeout" badge here can only come from the code.
    const engine = createMockEngine();
    engine.capabilities = async () => {
      throw new HwpEngineError("timeout", "무언가 잘못되었습니다");
    };
    render(<HwpEditor locale={locale} engine={engine} file={file} />);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(alert.textContent).toContain(t["error.kind.timeout"]);
  });
});

describe.each(LOCALES)("HwpEditor revert — locale=%s", (locale) => {
  const t = tables[locale];

  it("restores the snapshot taken before the applied edit", async () => {
    const engine = createMockEngine();
    const onChange = vi.fn();
    render(
      <HwpEditor locale={locale} engine={engine} file={file} onChange={onChange} />,
    );

    await selectAndQueueReplace(t);
    await applyOne(t);
    await screen.findByText(t["toolbar.pendingEdits"]({ count: 0 }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "edited-1.hwpx" }),
    );

    fireEvent.click(screen.getByRole("button", { name: t["toolbar.revert"] }));
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(file);
    });
  });

  it("leaves the store untouched when the undo read/render fails", async () => {
    const engine = createMockEngine();
    render(<HwpEditor locale={locale} engine={engine} file={file} />);

    await selectAndQueueReplace(t);
    await applyOne(t);
    await screen.findByText("edited-1.hwpx");

    // A mid-undo engine failure must not half-apply the undo: the store
    // keeps the applied document AND its snapshot (the button stays
    // enabled), and the failure surfaces as an alert.
    engine.read = async () => {
      throw new HwpEngineError("timeout", "hwp read timed out after 60000ms");
    };
    fireEvent.click(screen.getByRole("button", { name: t["toolbar.revert"] }));

    const alert = await screen.findByRole("alert");
    // #58 item 30: the undo reads the document it would restore, so this is a
    // re-read failure. The document on screen is open, and the load line would
    // say it was not.
    expect(alert.textContent).toContain(t["error.prefix.refresh"]);
    expect(alert.textContent).not.toContain(t["error.prefix.load"]);
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(screen.getByText("edited-1.hwpx")).toBeDefined();
    expect(
      screen.getByRole("button", { name: t["toolbar.revert"] }),
    ).toHaveProperty("disabled", false);
  });
});

describe.each(LOCALES)("HwpEditor compose flow — locale=%s", (locale) => {
  const t = tables[locale];

  it("preset picker + guided form builds DocumentSpec v2 and opens the result", async () => {
    const engine = createMockEngine();
    const onChange = vi.fn();
    render(
      <HwpEditor locale={locale} engine={engine} file={null} onChange={onChange} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: t["canvas.createCta"] }),
    );
    const dialog = await screen.findByRole("dialog", { name: t["compose.title"] });

    fireEvent.click(
      await screen.findByRole("radio", { name: t["presets.report"] }),
    );
    fireEvent.change(screen.getByLabelText(t["compose.titleLabel"]), {
      target: { value: "테스트 보고서" },
    });
    fireEvent.change(screen.getByLabelText(t["compose.authorLabel"]), {
      target: { value: "이영준" },
    });
    fireEvent.change(screen.getByLabelText(t["compose.bodyLabel"]), {
      target: { value: "# 1. 개요\n\n본문 내용입니다." },
    });
    fireEvent.click(screen.getByRole("button", { name: t["compose.submit"] }));

    await vi.waitFor(() => {
      expect(engine.calls.compose).toHaveLength(1);
    });
    const call = engine.calls.compose[0]!;
    expect(call.name).toBe("테스트 보고서.hwpx");
    expect(call.spec.version).toBe("2.0");
    expect(call.spec.document.metadata?.title).toBe("테스트 보고서");
    expect(call.spec.document.sections[0]?.page_number).toBeDefined();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "테스트 보고서.hwpx" }),
    );

    // The composed document is opened: dialog closed, title in the toolbar.
    await vi.waitFor(() => {
      expect(dialog.isConnected).toBe(false);
    });
    await screen.findByText("테스트 보고서.hwpx");
    cleanup();
  });

  /** Drive the dialog to a compose() call on `engine`; returns the dialog. */
  async function driveCompose(
    engine: ReturnType<typeof createMockEngine>,
  ): Promise<HTMLElement> {
    render(<HwpEditor locale={locale} engine={engine} file={null} />);
    fireEvent.click(
      await screen.findByRole("button", { name: t["canvas.createCta"] }),
    );
    const dialog = await screen.findByRole("dialog", { name: t["compose.title"] });
    fireEvent.change(screen.getByLabelText(t["compose.titleLabel"]), {
      target: { value: "테스트" },
    });
    fireEvent.click(screen.getByRole("button", { name: t["compose.submit"] }));
    return dialog;
  }

  it("badges a protected compose refusal from its code", async () => {
    const engine = createMockEngine();
    engine.compose = async () => {
      throw new HwpEngineError("protected", "이 문서는 생성할 수 없습니다");
    };
    const dialog = await driveCompose(engine);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(t["error.prefix.compose"]);
    expect(alert.getAttribute("data-error-kind")).toBe("protected");
    cleanup();
  });

  it("degrades a codeless compose failure to the generic kind", async () => {
    const engine = createMockEngine();
    engine.compose = async () => {
      throw new Error("boom");
    };
    const dialog = await driveCompose(engine);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(`${t["error.prefix.compose"]}: boom`);
    expect(alert.getAttribute("data-error-kind")).toBe("generic");
    expect(alert.querySelector(".hwped-error-kind")).toBeNull();
    cleanup();
  });

  /** Open the compose dialog from the empty state; returns the dialog. */
  async function openDialog(
    engine: ReturnType<typeof createMockEngine>,
  ): Promise<HTMLElement> {
    render(<HwpEditor locale={locale} engine={engine} file={null} />);
    fireEvent.click(
      await screen.findByRole("button", { name: t["canvas.createCta"] }),
    );
    return screen.findByRole("dialog", { name: t["compose.title"] });
  }

  it("keeps the file the host switched to when a compose resolves late (t18-1)", async () => {
    // The reload of the newly selected file is held open, so the store still
    // holds the old document when the compose lands: only the load generation
    // says the result is stale, and a compose that checked the document alone
    // would replace the file the host had just picked.
    const composed: DocumentHandle = { name: "composed.hwpx", data: new TextEncoder().encode("composed") };
    const other: DocumentHandle = { name: "other.hwpx", data: new TextEncoder().encode("other") };
    let release!: () => void;
    let releaseReload!: () => void;
    let started = false;
    const engine = createMockEngine();
    const readDocument = engine.read.bind(engine);
    engine.read = async (document) => {
      if (document.name === other.name) {
        await new Promise<void>((resolve) => { releaseReload = resolve; });
      }
      return readDocument(document);
    };
    engine.compose = () => {
      started = true;
      return new Promise((resolve) => {
        release = () => resolve({ document: composed });
      });
    };
    const onError = vi.fn();
    const { rerender } = render(
      <HwpEditor locale={locale} engine={engine} file={file} onError={onError} />,
    );
    await screen.findByRole("button", { name: t["page.label"]({ page: 1 }) });

    fireEvent.click(screen.getByRole("button", { name: t["toolbar.newDocument"] }));
    await screen.findByRole("dialog", { name: t["compose.title"] });
    fireEvent.change(screen.getByLabelText(t["compose.titleLabel"]), { target: { value: "테스트" } });
    fireEvent.click(screen.getByRole("button", { name: t["compose.submit"] }));
    await vi.waitFor(() => expect(started).toBe(true));

    rerender(<HwpEditor locale={locale} engine={engine} file={other} onError={onError} />);
    await vi.waitFor(() => expect(releaseReload).toBeDefined());
    release();

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(t["error.staleCompose"]);
    // The host's own load was left to finish, and the composed file was never read.
    releaseReload();
    await vi.waitFor(() => expect(engine.calls.read.at(-1)?.name).toBe(other.name));
    expect(engine.calls.read.some((document) => document.name === composed.name)).toBe(false);
  });

  it("closes on Escape even while focus is still on the trigger", async () => {
    const dialog = await openDialog(createMockEngine());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog.isConnected).toBe(false);
    cleanup();
  });

  it("closes on Escape pressed inside a field", async () => {
    const dialog = await openDialog(createMockEngine());
    fireEvent.keyDown(screen.getByLabelText(t["compose.titleLabel"]), {
      key: "Escape",
    });
    expect(dialog.isConnected).toBe(false);
    cleanup();
  });

  it("keeps the dialog for an Escape that ends an IME composition", async () => {
    const dialog = await openDialog(createMockEngine());
    fireEvent.keyDown(screen.getByLabelText(t["compose.titleLabel"]), {
      key: "Escape",
      isComposing: true,
    });
    expect(dialog.isConnected).toBe(true);
    cleanup();
  });

  it("closing the dialog with Escape keeps the page selection", async () => {
    render(<HwpEditor locale={locale} engine={createMockEngine()} file={file} />);
    await selectPara(t, 1);
    fireEvent.click(screen.getByRole("button", { name: t["toolbar.newDocument"] }));
    const dialog = await screen.findByRole("dialog", { name: t["compose.title"] });
    const title = screen.getByLabelText(t["compose.titleLabel"]);
    fireEvent.keyDown(title, { key: "Escape" });
    expect(dialog.isConnected).toBe(false);
    // Still selected: the inspector shows the paragraph's replace field.
    expect(screen.getByLabelText(t["segment.replaceLabel"])).toBeTruthy();
    cleanup();
  });

  it("ignores Escape while a compose is in flight, like the disabled Cancel", async () => {
    const engine = createMockEngine();
    engine.compose = () => new Promise(() => {});
    const dialog = await openDialog(engine);
    fireEvent.click(screen.getByRole("button", { name: t["compose.submit"] }));
    await screen.findByRole("button", { name: t["compose.submitting"] });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog.isConnected).toBe(true);
    cleanup();
  });
});

describe("HwpEditor table flow", () => {
  // Locale-independent: the subject is the set-cell op's CLI coordinates.
  it("selecting a table segment opens the grid; set-cell queues the CLI coords", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={file} />);

    const page = await screen.findByRole("button", {
      name: en["page.label"]({ page: 1 }),
    });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 2) });

    // Auto-switched to the table tab with the parsed grid.
    const cell = await screen.findByRole("button", { name: "예산" });
    fireEvent.click(cell);

    fireEvent.change(
      screen.getByLabelText(en["table.cellLabel"]({ row: 1, col: 0 })),
      { target: { value: "예산안" } },
    );
    fireEvent.click(screen.getByRole("button", { name: en["table.setCell"] }));

    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));
    fireEvent.click(
      screen.getByRole("button", {
        name: en["toolbar.applyWithCount"]({ count: 1 }),
      }),
    );
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 0 }));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-cell", table: 0, row: 1, col: 0, value: "예산안" },
    ]);
  });
});

describe("HwpEditor fields flow", () => {
  // Locale-independent: the subject is the set-field op payload.
  it("lists {{field}} slots, jumps to the segment, and queues set-field", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={file} />);

    await screen.findByRole("button", { name: en["page.label"]({ page: 1 }) });
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.fields"] }));

    // Jump-to selects the containing segment.
    fireEvent.click(await screen.findByRole("button", { name: "date" }));
    await findByQuote(/다음 회의는/);

    fireEvent.click(screen.getByRole("tab", { name: en["tabs.fields"] }));
    fireEvent.change(
      screen.getByLabelText(en["fields.fieldValueAria"]({ name: "date" })),
      { target: { value: "9월 1일" } },
    );
    fireEvent.click(screen.getByRole("button", { name: en["fields.setValue"] }));

    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));
    fireEvent.click(
      screen.getByRole("button", {
        name: en["toolbar.applyWithCount"]({ count: 1 }),
      }),
    );
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 0 }));
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-field", name: "date", value: "9월 1일" },
    ]);
  });
});

describe("HwpEditor refuses work against a document a load is replacing (t25)", () => {
  /** A file switch whose read never resolves until `release()` is called. */
  function heldSwitch() {
    const other: DocumentHandle = { name: "other.hwpx", data: new TextEncoder().encode("other") };
    const engine = createMockEngine();
    const readDocument = engine.read.bind(engine);
    let releaseReload: (() => void) | undefined;
    engine.read = async (document) => {
      if (document.name === other.name) {
        await new Promise<void>((resolve) => { releaseReload = resolve; });
      }
      return readDocument(document);
    };
    return { other, engine, release: () => releaseReload?.(), started: () => releaseReload !== undefined };
  }

  it("does not apply queued edits while the switched-to file is still loading", async () => {
    // The store still holds the old document, and the queued ops were staged
    // against it. Applying now edits the file the host has already left, and
    // the result would land on the new one.
    const { other, engine, release, started } = heldSwitch();
    const onChange = vi.fn();
    const { container, rerender } = render(<HwpEditor engine={engine} file={file} onChange={onChange} />);
    await selectAndQueueReplace(en);
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));

    rerender(<HwpEditor engine={engine} file={other} onChange={onChange} />);
    await vi.waitFor(() => expect(started()).toBe(true));

    // Both doors: the chord and the toolbar button.
    const root = container.firstElementChild;
    if (root === null) throw new Error("no root");
    fireEvent.keyDown(root, { key: "Enter", ctrlKey: true });
    fireEvent.click(
      screen.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }) }),
    );
    expect(engine.calls.edit).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    // The refusal is a sentence, not a press that did nothing: the toolbar
    // Apply stays enabled while the load runs.
    const notice = await screen.findByText(en["error.loadingReplacement"]);
    expect(notice.getAttribute("role")).toBe("status");
    // The ops are still staged: nothing was consumed by the refusal.
    expect(screen.getByText(en["toolbar.pendingEdits"]({ count: 1 }))).toBeTruthy();

    release();
    await vi.waitFor(() => expect(engine.calls.read.at(-1)?.name).toBe(other.name));
    expect(engine.calls.edit).toHaveLength(0);
    // The sentence described a load, so the load that lands takes it away.
    await vi.waitFor(() => expect(screen.queryByText(en["error.loadingReplacement"])).toBeNull());
  });

  it("drops an apply that a load overtook while the engine was working", async () => {
    // The check at the head cannot see a load that starts mid-apply: the edit
    // is in flight against the old document when the host switches file, so
    // the result must not be dispatched over the newly loaded one.
    const { other, engine, release, started } = heldSwitch();
    const onChange = vi.fn();
    let releaseEdit: (() => void) | undefined;
    const edit = engine.edit.bind(engine);
    engine.edit = async (...args) => {
      await new Promise<void>((resolve) => { releaseEdit = resolve; });
      return edit(...args);
    };
    const { rerender } = render(<HwpEditor engine={engine} file={file} onChange={onChange} />);
    await selectAndQueueReplace(en);
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));
    fireEvent.click(
      screen.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }) }),
    );
    await vi.waitFor(() => expect(releaseEdit).toBeDefined());

    rerender(<HwpEditor engine={engine} file={other} onChange={onChange} />);
    await vi.waitFor(() => expect(started()).toBe(true));
    releaseEdit?.();
    // The edit itself ran, but its result belongs to the document the host
    // left: no change reaches the host. The drop is recorded against the
    // document still in the store, so the editor says why nothing happened —
    // and the load that follows resets that state with the document.
    await vi.waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(onChange).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain(
      en["error.loadingReplacement"],
    );
    release();
    await vi.waitFor(() => expect(engine.calls.read.at(-1)?.name).toBe(other.name));
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("leaves applying when the load that overtook the apply failed", async () => {
    // A failed load, a null file and a refused compose read all move the
    // generation without dispatching `load`, so nothing would reset
    // "applying" — where the reducer refuses queue, undo and apply. The drop
    // is recorded against the document and the snapshot stack this attempt
    // staged, which unlocks the editor and names the reason.
    const other: DocumentHandle = { name: "broken.hwpx", data: new TextEncoder().encode("broken") };
    const engine = createMockEngine();
    const readDocument = engine.read.bind(engine);
    engine.read = async (document) => {
      if (document.name === other.name) throw new Error("read failed");
      return readDocument(document);
    };
    const releases: Array<() => void> = [];
    const edit = engine.edit.bind(engine);
    engine.edit = async (...args) => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return edit(...args);
    };
    const onChange = vi.fn();
    const { container, rerender } = render(
      <HwpEditor engine={engine} file={file} onChange={onChange} />,
    );
    await selectAndQueueReplace(en);
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));
    await applyOne(en);
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    rerender(<HwpEditor engine={engine} file={other} onChange={onChange} />);
    // The switched-to read fails, so no `load` follows this generation bump.
    expect((await screen.findByRole("alert")).textContent).toContain(en["error.prefix.load"]);
    releases[0]?.();

    await vi.waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    const alerts = () =>
      screen.getAllByRole("alert").map((node) => node.textContent ?? "").join("\n");
    // Nothing is loading any more, so the drop must not tell the user to wait
    // for a load that will never finish, and must not borrow the sentence that
    // describes one.
    await vi.waitFor(() => expect(alerts()).toContain(en["error.staleApply"]));
    expect(alerts()).not.toContain(en["error.loadingReplacement"]);
    expect(container.firstElementChild?.getAttribute("data-status")).toBe("error");
    expect(onChange).not.toHaveBeenCalled();

    // Usable again: the ops are still staged, and a second Apply starts rather
    // than being refused by a reducer still holding "applying".
    await applyOne(en);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await vi.waitFor(() => expect(engine.calls.edit).toHaveLength(2));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it("opens the replacement guard when the surface goes read-only during a compose read", async () => {
    // `onComposed` bumps the load generation and then reads the composed
    // file. A host that turns the surface read-only during that read leaves no
    // load to finish the job, so the guard must open there: it otherwise
    // stayed armed with nothing loading, and every later apply or replacement
    // was refused as if a load were still running.
    const engine = createMockEngine();
    const composed: DocumentHandle = {
      name: "composed.hwpx",
      data: new TextEncoder().encode("composed"),
    };
    engine.compose = async () => ({ document: composed });
    const readDocument = engine.read.bind(engine);
    let releaseComposed: (() => void) | undefined;
    engine.read = async (document) => {
      if (document.name === composed.name) {
        await new Promise<void>((resolve) => { releaseComposed = resolve; });
      }
      return readDocument(document);
    };
    const onChange = vi.fn();
    const view = render(<HwpEditor engine={engine} file={file} onChange={onChange} />);
    await selectAndQueueReplace(en);
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));
    await vi.waitFor(() => expect(releaseComposed).toBeDefined());

    view.rerender(<HwpEditor engine={engine} file={file} onChange={onChange} readOnly />);
    releaseComposed?.();
    await vi.waitFor(() => expect(engine.calls.read.at(-1)?.name).toBe(composed.name));
    view.rerender(<HwpEditor engine={engine} file={file} onChange={onChange} />);

    // Nothing is loading now, so the staged op applies instead of being told
    // to wait for a load that will never finish.
    await applyOne(en);
    await vi.waitFor(() => expect(engine.calls.edit).toHaveLength(1));
    expect(screen.queryByText(en["error.loadingReplacement"])).toBeNull();
  });

  it("does not start an apply from Cmd/Ctrl+Enter while the compose dialog is open", async () => {
    // The chord is handled at the root, so a press inside the modal used to
    // apply the queued edits: that rewrites the document the compose is about
    // to replace, and the result lands on the composed file. Focus stays on
    // the toolbar trigger when the dialog opens, so the root has to refuse it.
    const engine = createMockEngine();
    const composed: DocumentHandle = { name: "composed.hwpx", data: new TextEncoder().encode("composed") };
    engine.compose = async () => ({ document: composed });
    const onChange = vi.fn();
    render(<HwpEditor engine={engine} file={file} onChange={onChange} />);
    await selectAndQueueReplace(en);
    await screen.findByText(en["toolbar.pendingEdits"]({ count: 1 }));

    const trigger = screen.getByRole("button", { name: en["toolbar.newDocument"] });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    // The press a dialog-level handler cannot see: the trigger still has focus.
    fireEvent.keyDown(trigger, { key: "Enter", ctrlKey: true });
    expect(engine.calls.edit).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    // And one inside the dialog, which must not start an apply either.
    const title = within(dialog).getByLabelText(en["compose.titleLabel"]);
    fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
    expect(engine.calls.edit).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();

    // The dialog still composes on its own button, and the composed file is
    // what reaches the host.
    fireEvent.change(title, { target: { value: "새 문서" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(composed));
    expect(engine.calls.edit).toHaveLength(0);
  });
});
