/**
 * Host driving surface: the imperative `HwpEditorHandle`, the
 * `onReady`/`onError` callback pair, the forcing `readOnly` prop, and undo's
 * validation refresh (BUG-02).
 *
 * These tests run at the DEFAULT locale (`en`) — unlike editor.test.tsx,
 * which pins `locale="ko"` for its pre-i18n selectors. Chrome strings are
 * read from the `en` table rather than hardcoded so a copy change moves the
 * selector with it. As of 03-04 the panel and canvas selectors are `en` too;
 * the remaining Korean literals here are DOCUMENT content from the fixture
 * envelope ("1. 회의록"), which no locale changes.
 *
 * Host callbacks are NON-REACTIVE by contract: `onReady`, `onError`,
 * `onChange` and `onDirtyChange` never appear in a dependency array inside
 * HwpEditor.tsx, so a host may pass inline arrows without turning its own
 * re-renders into engine round trips (API-02). Every other callback test here
 * passes a `vi.fn()` whose identity never changes and therefore cannot see
 * that regression; `describe("host callback identity")` is its regression net.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { RefObject } from "react";
import type { CatEnvelope, DocumentHandle } from "@hwp-editor/core";
import { HwpEngineError } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import type { HwpEditorHandle } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { COMPOSE_PRESETS } from "../src/presets.js";
import { clientYForPara, createMockEngine, makeEnvelope } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = {
  name: "minutes.hwpx",
  data: new TextEncoder().encode("original"),
};

const other: DocumentHandle = {
  name: "plan.hwpx",
  data: new TextEncoder().encode("other"),
};

beforeAll(() => {
  // jsdom reports zero-size boxes; give pages the render's 595x842 rect.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("hwped-page")) {
      return {
        top: 0, left: 0, right: 595, bottom: 842, width: 595, height: 842,
        x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

const pending = (count: number): string =>
  en["toolbar.pendingEdits"]({ count });

/** Click the heading, type a replacement, queue the op. */
async function queueReplace(envelope: CatEnvelope = makeEnvelope()): Promise<void> {
  const page = await screen.findByRole("button", { name: "Page 1" });
  fireEvent.click(page, { clientY: clientYForPara(envelope, 0) });
  await screen.findByText("1. 회의록");
  fireEvent.change(screen.getByLabelText("Replace text"), {
    target: { value: "2. 회의록" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  await screen.findByText(pending(1));
}

function handle(ref: RefObject<HwpEditorHandle | null>): HwpEditorHandle {
  const value = ref.current;
  if (value === null) throw new Error("handle not attached");
  return value;
}

describe("HwpEditorHandle", () => {
  it("exposes exactly apply, revert, refresh and openCompose", async () => {
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={createMockEngine()} file={file} />);
    await screen.findByRole("button", { name: "Page 1" });

    expect(Object.keys(handle(ref)).sort()).toEqual([
      "apply",
      "openCompose",
      "refresh",
      "revert",
    ]);
  });

  it("resolves apply() as a quiet no-op when nothing is queued", async () => {
    const engine = createMockEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} />);
    await screen.findByRole("button", { name: "Page 1" });

    await act(async () => {
      await handle(ref).apply();
    });
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("resolves revert() as a quiet no-op when the snapshot stack is empty", async () => {
    const engine = createMockEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} />);
    await screen.findByRole("button", { name: "Page 1" });
    const readsBefore = engine.calls.read.length;

    await act(async () => {
      await handle(ref).revert();
    });
    expect(engine.calls.read).toHaveLength(readsBefore);
  });

  it("opens the compose dialog from openCompose() and returns undefined", async () => {
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={createMockEngine()} file={file} />);
    await screen.findByRole("button", { name: "Page 1" });

    let result: void | undefined;
    act(() => {
      result = handle(ref).openCompose();
    });
    expect(result).toBeUndefined();
    await screen.findByRole("dialog");
  });

  it("refuses a second apply() while one is in flight", async () => {
    const engine = createMockEngine();
    let edits = 0;
    let release!: (document: DocumentHandle) => void;
    engine.edit = () => {
      edits += 1;
      return new Promise<DocumentHandle>((resolve) => {
        release = resolve;
      });
    };
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} />);
    await queueReplace();

    let inFlight!: Promise<void>;
    act(() => {
      inFlight = handle(ref).apply();
    });
    await act(async () => {
      await handle(ref).apply();
    });
    expect(edits).toBe(1);

    await act(async () => {
      release({ name: "edited-1.hwpx", data: new TextEncoder().encode("x") });
      await inFlight;
    });
    expect(edits).toBe(1);
  });
});

describe("onReady", () => {
  it("fires once with the loaded document after read and render resolve", async () => {
    const onReady = vi.fn();
    render(<HwpEditor engine={createMockEngine()} file={file} onReady={onReady} />);
    await screen.findByRole("button", { name: "Page 1" });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(file);
  });

  it("fires again when the file prop changes", async () => {
    const onReady = vi.fn();
    const engine = createMockEngine();
    const { rerender } = render(
      <HwpEditor engine={engine} file={file} onReady={onReady} />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

    rerender(<HwpEditor engine={engine} file={other} onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
    expect(onReady).toHaveBeenLastCalledWith(other);
  });

  it("never fires for file={null}", async () => {
    const onReady = vi.fn();
    render(<HwpEditor engine={createMockEngine()} file={null} onReady={onReady} />);
    await screen.findByText(en["canvas.empty"]);

    expect(onReady).not.toHaveBeenCalled();
  });

  it("never fires when the load is cancelled by unmount", async () => {
    const onReady = vi.fn();
    const engine = createMockEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.read = async () => {
      await gate;
      return makeEnvelope();
    };
    const { unmount } = render(
      <HwpEditor engine={engine} file={file} onReady={onReady} />,
    );
    await waitFor(() => expect(engine.calls.render).toBe(1));
    unmount();

    await act(async () => {
      release();
      await gate;
    });
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe("host callback identity", () => {
  /**
   * Let every already-scheduled effect, microtask and load pipeline settle.
   * A re-render that (wrongly) re-fires the load effect needs a full
   * capabilities → Promise.all round trip to bump the call counts, so a bare
   * microtask flush would let the regression through.
   */
  const settle = (): Promise<void> =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("does not reload the document for a new inline onReady arrow", async () => {
    const engine = createMockEngine();
    const ready = vi.fn();
    const { rerender } = render(
      <HwpEditor engine={engine} file={file} onReady={(d) => ready(d)} />,
    );
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));

    // Same engine, same file, brand-new arrow: the ordinary host idiom.
    rerender(<HwpEditor engine={engine} file={file} onReady={(d) => ready(d)} />);
    await settle();

    expect(ready).toHaveBeenCalledTimes(1);
    expect(engine.calls.read).toHaveLength(1);
  });

  it("does not reload the document for a new inline onError arrow alone", async () => {
    const engine = createMockEngine();
    const { rerender } = render(
      <HwpEditor engine={engine} file={file} onError={() => {}} />,
    );
    await screen.findByRole("button", { name: "Page 1" });

    rerender(<HwpEditor engine={engine} file={file} onError={() => {}} />);
    await settle();

    expect(engine.calls.read).toHaveLength(1);
    expect(engine.calls.render).toBe(1);
  });

  it("delivers a mid-load completion to the replacement, not the mount-time identity", async () => {
    const engine = createMockEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.read = async () => {
      await gate;
      return makeEnvelope();
    };
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <HwpEditor engine={engine} file={file} onReady={(d) => first(d)} />,
    );
    await waitFor(() => expect(engine.calls.render).toBe(1));

    // Swap the handler while the read is still gated, then let it finish.
    rerender(<HwpEditor engine={engine} file={file} onReady={(d) => second(d)} />);
    await act(async () => {
      release();
      await gate;
    });

    // Freeze-at-mount would call `first` here and pass every count assertion.
    expect(first).not.toHaveBeenCalled();
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(second).toHaveBeenCalledWith(file);
  });

  it("does not re-emit onDirtyChange for a new inline arrow with no dirty change", async () => {
    const engine = createMockEngine();
    const dirty = vi.fn();
    const { rerender } = render(
      <HwpEditor engine={engine} file={file} onDirtyChange={(d) => dirty(d)} />,
    );
    await screen.findByRole("button", { name: "Page 1" });
    const before = dirty.mock.calls.length;

    rerender(
      <HwpEditor engine={engine} file={file} onDirtyChange={(d) => dirty(d)} />,
    );
    await settle();

    expect(dirty).toHaveBeenCalledTimes(before);
  });

  it("keeps the imperative handle identity across new inline host callbacks", async () => {
    const engine = createMockEngine();
    const ref = createRef<HwpEditorHandle>();
    const { rerender } = render(
      <HwpEditor
        ref={ref}
        engine={engine}
        file={file}
        onReady={() => {}}
        onError={() => {}}
        onChange={() => {}}
        onDirtyChange={() => {}}
      />,
    );
    // Capture AFTER the load: `editable` settles once capabilities resolve,
    // which legitimately re-creates applyPendingOps once.
    await screen.findByRole("button", { name: "Page 1" });
    const before = handle(ref);

    rerender(
      <HwpEditor
        ref={ref}
        engine={engine}
        file={file}
        onReady={() => {}}
        onError={() => {}}
        onChange={() => {}}
        onDirtyChange={() => {}}
      />,
    );

    // The single assertion proving no host callback reaches ANY dependency
    // array in HwpEditor.tsx.
    expect(handle(ref)).toBe(before);
  });
});

describe("onError", () => {
  it("fires with the caught value verbatim when the load fails", async () => {
    const boom = new HwpEngineError("timeout", "hwp render timed out after 60000ms");
    const engine = createMockEngine();
    engine.read = async () => {
      throw boom;
    };
    const onError = vi.fn();
    render(<HwpEditor engine={engine} file={file} onError={onError} />);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(boom);
  });

  it("fires with the caught value verbatim when apply fails", async () => {
    const boom = new HwpEngineError("protected", "document is a distribution copy");
    const engine = createMockEngine();
    engine.edit = async () => {
      throw boom;
    };
    const onError = vi.fn();
    render(<HwpEditor engine={engine} file={file} onError={onError} />);
    await queueReplace();

    fireEvent.click(screen.getByRole("button", { name: /^Apply \(/ }));
    await screen.findByRole("alert");
    expect(onError.mock.calls[0]?.[0]).toBe(boom);
  });

  it("fires with the caught value verbatim when revert fails", async () => {
    const boom = new HwpEngineError("failed", "hwp cat failed");
    const engine = createMockEngine();
    const onError = vi.fn();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} onError={onError} />);
    await queueReplace();
    await act(async () => {
      await handle(ref).apply();
    });
    await screen.findByText(pending(0));

    engine.read = async () => {
      throw boom;
    };
    await act(async () => {
      await handle(ref).revert();
    });
    await screen.findByRole("alert");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(boom);
  });

  it("rejects refresh(), fires onError and still shows the alert", async () => {
    const boom = new HwpEngineError("unavailable", "hwp binary not found: hwp");
    const engine = createMockEngine();
    const onError = vi.fn();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} onError={onError} />);
    await screen.findByRole("button", { name: "Page 1" });

    engine.read = async () => {
      throw boom;
    };
    await act(async () => {
      await expect(handle(ref).refresh()).rejects.toBe(boom);
    });

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("unavailable");
    expect(onError.mock.calls[0]?.[0]).toBe(boom);
  });

  it("fires when opening a freshly composed document fails", async () => {
    const boom = new HwpEngineError("failed", "hwp cat failed");
    const engine = createMockEngine();
    engine.read = async () => {
      throw boom;
    };
    const onError = vi.fn();
    render(<HwpEditor engine={engine} file={null} onError={onError} />);

    fireEvent.click(screen.getByRole("button", { name: en["canvas.createCta"] }));
    const dialog = await screen.findByRole("dialog");
    // Submit by class, not by label: ComposePanel is not localized until
    // Task 3, and this test is about the post-compose open path.
    const submit = dialog.querySelector(".hwped-btn-primary");
    if (submit === null) throw new Error("no submit button");
    fireEvent.click(submit);

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[0]).toBe(boom);
  });
});

describe("readOnly", () => {
  it("forces read-only over an editable engine and shows no reason suffix", async () => {
    const engine = createMockEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} readOnly />);

    const notice = await screen.findByRole("note");
    expect(notice.textContent).toBe(en["toolbar.readOnly"]);
    expect(notice.getAttribute("title")).toBeNull();

    const page = await screen.findByRole("button", { name: "Page 1" });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });
    await screen.findByText("1. 회의록");
    expect(screen.getByLabelText("Replace text")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /^Apply \(/ })).toHaveProperty(
      "disabled",
      true,
    );

    await act(async () => {
      await handle(ref).apply();
    });
    expect(engine.calls.edit).toHaveLength(0);
  });

  it("keeps the engine's reason as the suffix and as a hover title", async () => {
    const engine = createMockEngine({ editable: false, reason: "배포용 문서" });
    render(<HwpEditor engine={engine} file={file} />);

    const notice = await screen.findByRole("note");
    expect(notice.textContent).toBe(`${en["toolbar.readOnly"]}: 배포용 문서`);
    expect(notice.getAttribute("title")).toBe("배포용 문서");
  });
});

describe("undo re-validates the restored document (BUG-02)", () => {
  it("validates the restored document and updates the badge", async () => {
    const engine = createMockEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} />);
    await queueReplace();
    await act(async () => {
      await handle(ref).apply();
    });
    await screen.findByText(en["validation.valid"]);

    engine.report = { valid: false, errors: [{ code: "E1", message: "broken" }] };
    await act(async () => {
      await handle(ref).revert();
    });

    await screen.findByText(en["validation.errors"]({ count: 1 }));
    expect(engine.calls.validated.at(-1)).toBe(file);
  });

  it("leaves the badge unchanged when the revert validate rejects", async () => {
    const engine = createMockEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={engine} file={file} />);
    await queueReplace();
    await act(async () => {
      await handle(ref).apply();
    });
    await screen.findByText(en["validation.valid"]);

    engine.validate = async () => {
      throw new Error("validator exploded");
    };
    await act(async () => {
      await handle(ref).revert();
    });

    expect(screen.getByText(en["validation.valid"])).toBeDefined();
  });
});

describe("ComposePanel localization", () => {
  /** Open the dialog from the empty state and submit it. */
  async function composeUntitled(locale: "en" | "ko"): Promise<void> {
    const cta = locale === "en" ? en["canvas.createCta"] : ko["canvas.createCta"];
    fireEvent.click(screen.getByRole("button", { name: cta }));
    await screen.findByRole("dialog");
    const submit = locale === "en" ? en["compose.submit"] : ko["compose.submit"];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: submit }));
    });
  }

  it("renders the dialog and preset labels from the en table", async () => {
    render(<HwpEditor engine={createMockEngine()} file={null} />);
    fireEvent.click(screen.getByRole("button", { name: en["canvas.createCta"] }));

    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    expect(dialog.textContent).toContain(en["compose.docType"]);
    for (const key of COMPOSE_PRESETS) {
      expect(
        screen.getByRole("radio", { name: en[`presets.${key}`] }),
      ).toBeDefined();
    }
    expect(screen.getByPlaceholderText(en["compose.titlePlaceholder"])).toBeDefined();
  });

  it("names an untitled document with the en default stem", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={null} />);
    await composeUntitled("en");

    expect(engine.calls.compose[0]?.name).toBe(`${en["compose.defaultFileStem"]}.hwpx`);
    expect(engine.calls.compose[0]?.name).toBe("New document.hwpx");
  });

  it("names an untitled document with the ko default stem", async () => {
    const engine = createMockEngine();
    render(<HwpEditor locale="ko" engine={engine} file={null} />);
    await composeUntitled("ko");

    expect(engine.calls.compose[0]?.name).toBe("새 문서.hwpx");
  });

  it("still prefers a typed title over the default stem", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={null} />);
    fireEvent.click(screen.getByRole("button", { name: en["canvas.createCta"] }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByPlaceholderText(en["compose.titlePlaceholder"]), {
      target: { value: "Q3 plan" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en["compose.submit"] }));
    });

    expect(engine.calls.compose[0]?.name).toBe("Q3 plan.hwpx");
  });

  it("passes a compose failure to onError verbatim and keeps its own alert", async () => {
    const boom = new HwpEngineError("protected", "template is a distribution copy");
    const engine = createMockEngine();
    engine.compose = async () => {
      throw boom;
    };
    const onError = vi.fn();
    render(<HwpEditor engine={engine} file={null} onError={onError} />);
    await composeUntitled("en");

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("protected");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(boom);
  });
});
