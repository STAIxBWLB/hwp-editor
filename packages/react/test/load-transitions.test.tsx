/**
 * Load-transition correctness (#58 items 21, 22 and 24, plus #53 follow-ups 1,
 * 3 and 4): no transition acts on, or reports about, a document the host has
 * already left, and no load path leaves stale state behind.
 *
 * The subject of every test here is a WINDOW rather than a steady state: a
 * load that has started and not landed, a press that outlives the file it was
 * pressed on, a failure that leaves the previous document on screen. The
 * engine harness therefore holds a named document's read open — that gate is
 * what reaches the window — and the assertions are written against what the
 * user sees during it (the notice line, the toolbar's counts, a tab's rows),
 * never against an internal ref.
 *
 * Selectors come from the `en` table. The Korean literals that remain are
 * document content: the fixture envelope's heading and the `바탕글` style row,
 * which no locale translates.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import type { RefObject } from "react";
import type {
  CatEnvelope,
  DocumentHandle,
  EditReport,
  HwpEngine,
  StyleTable,
  TemplateMethod,
} from "@hwp-editor/core";
import { TEMPLATE_METHODS } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import type { HwpEditorHandle } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import type { MessageTable } from "../src/messages.js";
import { clientYForPara, createMockEngine, makeEnvelope } from "./mock-engine.js";
import type { MockEngine } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = { name: "minutes.hwpx", data: new TextEncoder().encode("original") };
const switched: DocumentHandle = { name: "plan.hwpx", data: new TextEncoder().encode("plan") };
const broken: DocumentHandle = { name: "broken.hwpx", data: new TextEncoder().encode("broken") };

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

const ATTRS = {
  char: {
    bold: false,
    italic: false,
    size_pt: 12,
    color: "#000000",
    faces: ["함초롬바탕", null, null, null, null, null, null],
    face_ids: [1, 0, 0, 0, 0, 0, 0],
  },
  para: { alignment: "justify", indent: 0, line_spacing: 160, line_spacing_type: 0 },
  char_shape_id: 0,
  para_shape_id: 0,
};

/** One paragraph style, whose `used_by` joins the fixture envelope's ids. */
const TABLE: StyleTable = {
  version: "1.0",
  styles: [
    { id: 0, name: "바탕글", english_name: "Normal", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p2", "p3"] },
    { id: 1, name: "개요 1", english_name: "Outline 1", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p1"] },
  ],
};

/** The shared envelope with the ids `used_by` joins on. */
function envelopeWithIds(): CatEnvelope {
  const base = makeEnvelope();
  return {
    ...base,
    segments: base.segments.map((segment, at) => ({ ...segment, id: `p${at}` })),
  };
}

/**
 * What an edited document answers with: the same envelope with the heading
 * changed, in the same number of scalars so every segment range still
 * addresses the text it did.
 */
function editedEnvelope(): CatEnvelope {
  const base = envelopeWithIds();
  return { ...base, markdown: base.markdown.replace("1. 회의록", "개정된 안건") };
}

/**
 * What a RE-READ of the open document answers with: the same envelope with the
 * heading changed, again in the same number of scalars, so an install is
 * visible on the page and no segment range moves.
 */
function reReadEnvelope(): CatEnvelope {
  const base = envelopeWithIds();
  return { ...base, markdown: base.markdown.replace("1. 회의록", "1. 재조회") };
}

/** A preset batch the engine measured as changing nothing: already in place. */
function unchangedReport(): EditReport {
  return {
    schema_version: "1.0",
    contract: "hwp-edit-report-v1",
    output: "x.hwpx",
    dry_run: false,
    ops: [
      { index: 0, op: "update_style", status: "applied", pieces_touched: 0, changed: [], reason: null },
      { index: 1, op: "style_tables", status: "applied", pieces_touched: 0, changed: [], reason: null },
    ],
    applied_count: 2,
    failed_count: 0,
  };
}

interface EngineOptions {
  /** Advertise `styles: "v1"` and answer `styles()` with `table` (or TABLE). */
  styles?: boolean;
  table?: StyleTable;
  version?: string;
  templateMethods?: TemplateMethod[];
  /** Answer `compose`/`create` and the embedded-template picker. */
  templates?: boolean;
  /** The report every `edit` returns, so a preset's outcome can be pinned. */
  report?: EditReport;
  /** Throw on a read of this document, so the load of it fails. */
  failRead?: (document: DocumentHandle, call: number) => boolean;
  /** Hold a read of this document until `releaseRead()`. */
  holdRead?: (document: DocumentHandle, call: number) => boolean;
  /** A held read that REJECTS when released, so a failure can land late. */
  failWhenReleased?: (document: DocumentHandle, call: number) => boolean;
  /** Hold the engine edit until `releaseEdit()`. */
  holdEdit?: boolean;
  /** Answer this document's read with its own envelope, so an install is visible. */
  envelopeFor?: (document: DocumentHandle, call: number) => CatEnvelope | undefined;
}

/**
 * The mock engine with the three gates these tests need: a document read that
 * does not answer, a read that fails, and an edit that does not answer. Each
 * gate is opened by the test, never by a timeout.
 */
function editorEngine(opts: EngineOptions = {}) {
  const base = createMockEngine({ envelope: envelopeWithIds() });
  const reads: DocumentHandle[] = [];
  const styleReads: DocumentHandle[] = [];
  // Reads are released in the order they started, so a test can hold two and
  // open them one at a time.
  const readGates: Array<() => void> = [];
  let releaseEdit: (() => void) | undefined;
  const engine: MockEngine = {
    ...base,
    read: async (document) => {
      reads.push(document);
      const call = reads.length;
      if (opts.failRead?.(document, call) === true) throw new Error(`read failed: ${document.name}`);
      if (opts.holdRead?.(document, call) === true) {
        const fails = opts.failWhenReleased?.(document, call) === true;
        await new Promise<void>((resolve, reject) => {
          readGates.push(fails
            ? () => reject(new Error(`read failed: ${document.name}`))
            : resolve);
        });
      }
      return opts.envelopeFor?.(document, call) ?? base.read(document);
    },
    edit: async (document, ops) => {
      if (opts.holdEdit === true) {
        await new Promise<void>((resolve) => { releaseEdit = resolve; });
      }
      const edited = await base.edit(document, ops);
      return opts.report === undefined ? edited : { ...edited, report: opts.report };
    },
    capabilities: async () => {
      const caps = await base.capabilities();
      return {
        ...caps,
        ...(opts.version === undefined ? {} : { version: opts.version }),
        ...(opts.styles === true ? { styles: "v1" as const } : {}),
        ...(opts.templateMethods === undefined ? {} : { templateMethods: opts.templateMethods }),
      };
    },
    ...(opts.styles === true
      ? {
        styles: async (document: DocumentHandle) => {
          styleReads.push(document);
          return opts.table ?? TABLE;
        },
      }
      : {}),
    ...(opts.templates === true
      ? {
        listTemplates: async () => [{ id: "gongmun", label: "공문" }],
        create: async (_id: string, name: string) => ({ name, data: new TextEncoder().encode(name) }),
      }
      : {}),
  };
  return {
    engine,
    reads,
    styleReads,
    readGates,
    readStarted: () => readGates.length > 0,
    editStarted: () => releaseEdit !== undefined,
    releaseRead: () => readGates.shift()?.(),
    releaseEdit: () => releaseEdit?.(),
  };
}

const pending = (t: MessageTable, count: number): string => t["toolbar.pendingEdits"]({ count });

/** Click the page so the paragraph at `para` becomes the selection. */
async function selectPara(t: MessageTable, para: number): Promise<void> {
  const page = await screen.findByRole("button", { name: t["page.label"]({ page: 1 }) });
  fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), para) });
}

/** Select the heading paragraph and queue one replace op against it. */
async function selectAndQueueReplace(t: MessageTable): Promise<void> {
  await selectPara(t, 0);
  await screen.findByText("1. 회의록");
  fireEvent.change(screen.getByLabelText(t["segment.replaceLabel"]), {
    target: { value: "수정됨" },
  });
  fireEvent.click(screen.getByRole("button", { name: t["segment.replaceSubmit"] }));
}

/** Click the toolbar Apply while exactly one op is queued. */
async function applyOne(t: MessageTable): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: t["toolbar.applyWithCount"]({ count: 1 }) }),
  );
}

function handle(ref: RefObject<HwpEditorHandle | null>): HwpEditorHandle {
  const value = ref.current;
  if (value === null) throw new Error("handle not attached");
  return value;
}

/** The selected style row, whose name is document content, not chrome. */
const styleRow = (): HTMLElement => screen.getByRole("button", { name: /바탕글/ });

/** Let every pending microtask and one macrotask settle inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

/**
 * #58 item 22: the host can choose no document. The store is what Apply, the
 * template panel and Styles read, so it must follow the host there — the
 * generation counter alone leaves the closed document editable.
 */
describe("#58 item 22: a closed document leaves nothing behind", () => {
  it("empties the store, so Apply, Styles and the template panel act on nothing", async () => {
    const h = editorEngine({ styles: true });
    const onChange = vi.fn();
    const view = render(<HwpEditor engine={h.engine} file={file} onChange={onChange} />);
    await selectAndQueueReplace(en);
    await screen.findByText(pending(en, 1));
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("true"));

    view.rerender(<HwpEditor engine={h.engine} file={null} onChange={onChange} />);

    // The document is gone from the store: not its name, not the ops staged
    // against it, not the table read from it.
    expect(await screen.findByText("hwp-editor")).toBeTruthy();
    expect(view.container.firstElementChild?.getAttribute("data-status")).toBe("clean");
    expect(screen.queryByText(pending(en, 1))).toBeNull();
    expect(screen.queryByRole("button", { name: /바탕글/ })).toBeNull();
    // Apply has nothing to send, and the closed document is not edited.
    const apply = screen.getByRole("button", {
      name: en["toolbar.applyWithCount"]({ count: 0 }),
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(h.engine.calls.edit).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    // The template panel needs a document and says so, instead of filling the
    // one the host closed.
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.templates"] }));
    expect(await screen.findByText(en["templates.openDocument"])).toBeTruthy();
  });
});

/**
 * #58 item 21: every snapshot, page and envelope the editor holds was read
 * from the document in the store. While a load is in flight the host has
 * already left that document, so neither a revert nor a refresh may act on it,
 * and neither may report about it once its result lands.
 */
describe("#58 item 21: revert and refresh belong to one load generation", () => {
  it("refuses a revert while a load is replacing the document", async () => {
    const h = editorEngine({ holdRead: (document) => document.name === switched.name });
    const onError = vi.fn();
    const view = render(<HwpEditor engine={h.engine} file={file} onError={onError} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    // The apply has LANDED, not merely reached the engine: the snapshot it
    // staged is what Revert undoes, and it exists only once the edit settled.
    await screen.findByText(pending(en, 0));

    view.rerender(<HwpEditor engine={h.engine} file={switched} onError={onError} />);
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));
    const readsBefore = h.reads.length;
    const revert = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    expect(revert.disabled).toBe(false);
    fireEvent.click(revert);

    // Said out loud, because the toolbar button stays enabled: a press that
    // silently did nothing is the bug this refusal exists to prevent.
    expect(await screen.findByText(en["error.loadingReplacement"])).toBeTruthy();
    // Refused before the engine saw the undo's read.
    expect(h.reads).toHaveLength(readsBefore);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(en["error.loadingReplacement"]);

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());
  });

  it("drops a revert whose read a load overtook", async () => {
    // Two reads are held: the undo's read of the document being restored (the
    // second read of it; the first is the load that put it in the store), and
    // the switched-to file's. Opening the undo first is the window that
    // matters — the store still holds the document and the snapshot stack the
    // undo would restore, so only the generation can tell it has been left.
    const h = editorEngine({
      holdRead: (document, call) =>
        document.name === switched.name || (document.name === file.name && call > 1),
    });
    const onChange = vi.fn();
    const view = render(<HwpEditor engine={h.engine} file={file} onChange={onChange} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await screen.findByText(pending(en, 0));
    const changes = onChange.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.revert"] }));
    await vi.waitFor(() => expect(h.readGates).toHaveLength(1));
    view.rerender(<HwpEditor engine={h.engine} file={switched} onChange={onChange} />);
    await vi.waitFor(() => expect(h.readGates).toHaveLength(2));

    // The undo read answers against the document the host has left. Its result
    // is dropped whole: the snapshot stays where it was, and nothing reaches
    // the host as if the undo had landed on the new document. The refusal is a
    // sentence because nothing else would explain why the press did nothing:
    // the load that took over has not landed, so it dispatched no transition.
    await act(async () => { h.releaseRead(); });
    await settle();
    expect(onChange.mock.calls.length).toBe(changes);
    expect(screen.getByText(en["error.staleRevert"])).toBeTruthy();
    const revert = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    expect(revert.disabled).toBe(false);

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());
    // The document that landed starts with no snapshots, so the sentence's own
    // next step — undo again on it — is a button this editor has disabled. The
    // sentence goes with the document it described.
    await vi.waitFor(() => expect(screen.queryByText(en["error.staleRevert"])).toBeNull());
    const landed = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    expect(landed.disabled).toBe(true);
  });

  it("retires the discarded-undo sentence when a composed document lands", async () => {
    // The other landing path. The composed read is held open, so the dropped
    // undo resolves while the store still holds the old document (which is
    // what makes the sentence be posted at all), and the composition then
    // lands over it.
    const composed = "composed.hwpx";
    const h = editorEngine({
      styles: true,
      holdRead: (document, call) =>
        document.name === composed || (document.name === file.name && call > 1),
    });
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await screen.findByText(pending(en, 0));

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.revert"] }));
    await vi.waitFor(() => expect(h.readGates).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    fireEvent.change(within(dialog).getByLabelText(en["compose.titleLabel"]), {
      target: { value: "composed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));
    await vi.waitFor(() => expect(h.readGates).toHaveLength(2));

    // The undo answers against the document still in the store.
    await act(async () => { h.releaseRead(); });
    expect(await screen.findByText(en["error.staleRevert"])).toBeTruthy();

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.queryByText(file.name)).toBeNull());
    await vi.waitFor(() => expect(screen.queryByText(en["error.staleRevert"])).toBeNull());
    expect(view.container.firstElementChild?.getAttribute("data-status")).toBe("clean");
  });

  it("keeps the discarded-undo sentence when the load that followed it failed", async () => {
    // The other half of the rule. The sentence is on the line BEFORE the load
    // ends, so a clear placed where a load ends would take it: both reads are
    // open at once, and the failing one is released last.
    const h = editorEngine({
      holdRead: (document, call) =>
        document.name === broken.name || (document.name === file.name && call > 1),
      failWhenReleased: (document) => document.name === broken.name,
    });
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await screen.findByText(pending(en, 0));

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.revert"] }));
    await vi.waitFor(() => expect(h.readGates).toHaveLength(1));
    view.rerender(<HwpEditor engine={h.engine} file={broken} />);
    await vi.waitFor(() => expect(h.readGates).toHaveLength(2));

    // The undo answers against the document still in the store, while the
    // load that took over is still running.
    await act(async () => { h.releaseRead(); });
    expect(await screen.findByText(en["error.staleRevert"])).toBeTruthy();

    // The load then fails, which keeps both the document and its snapshots:
    // undoing again on it is still possible, so the sentence still holds.
    await act(async () => { h.releaseRead(); });
    expect((await screen.findByRole("alert")).textContent).toContain(en["error.prefix.load"]);
    expect(screen.getByText(en["error.staleRevert"])).toBeTruthy();
    const revert = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    expect(revert.disabled).toBe(false);
  });

  it("keeps a failed undo off the document a newer load put on screen", async () => {
    // The undo's read fails AFTER the switched-to file has landed: the error
    // belongs to the document the host left, so it must not take the error
    // line of the one now on screen. Only the generation can tell — the store
    // has already moved, and the snapshot stack with it.
    const h = editorEngine({
      holdRead: (document, call) => document.name === file.name && call > 1,
      failWhenReleased: (document, call) => document.name === file.name && call > 1,
    });
    const onError = vi.fn();
    const view = render(<HwpEditor engine={h.engine} file={file} onError={onError} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await screen.findByText(pending(en, 0));

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.revert"] }));
    await vi.waitFor(() => expect(h.readGates).toHaveLength(1));
    view.rerender(<HwpEditor engine={h.engine} file={switched} onError={onError} />);
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());

    await act(async () => { h.releaseRead(); });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(switched.name)).toBeTruthy();
    // The host still hears the engine's failure, as it arrived.
    expect(onError.mock.calls.some(([error]) => String((error as Error).message).includes("read failed"))).toBe(true);
  });

  it("refuses a refresh while a load is replacing the document", async () => {
    const h = editorEngine({ holdRead: (document) => document.name === switched.name });
    const ref = createRef<HwpEditorHandle>();
    const onError = vi.fn();
    const view = render(<HwpEditor ref={ref} engine={h.engine} file={file} onError={onError} />);
    await screen.findByText(file.name);

    view.rerender(<HwpEditor ref={ref} engine={h.engine} file={switched} onError={onError} />);
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));
    const readsBefore = h.reads.length;
    await act(async () => {
      await expect(handle(ref).refresh()).rejects.toThrow(en["error.loadingReplacement"]);
    });
    expect(h.reads).toHaveLength(readsBefore);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(en["error.loadingReplacement"]);

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());
  });

  it("rejects a refresh a load overtook, without painting it on the new document", async () => {
    const h = editorEngine({
      holdRead: (document, call) => document.name === file.name && call > 1,
    });
    const ref = createRef<HwpEditorHandle>();
    const view = render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await screen.findByText(file.name);

    let settled: Promise<unknown> = Promise.resolve();
    act(() => {
      settled = handle(ref).refresh().then(() => "resolved", (error: unknown) => error);
    });
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));

    view.rerender(<HwpEditor ref={ref} engine={h.engine} file={switched} />);
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());

    await act(async () => { h.releaseRead(); });
    let outcome: unknown;
    await act(async () => { outcome = await settled; });
    // A reading of a document the editor has left is not a re-read of the one
    // on screen: the caller is told, rather than handed a promise that says
    // the surface was refreshed.
    expect((outcome as Error).message).toBe(en["error.staleRefresh"]);
    // The load owns the error line, so the superseded reading is not painted
    // on the document it never saw.
    expect(screen.queryByText(en["error.staleRefresh"])).toBeNull();
    expect(screen.getByText(switched.name)).toBeTruthy();
  });
});

/**
 * #58 item 27: a re-read belongs to the document it started from, not only to
 * the load generation. An apply, an undo or a template replacement keeps both
 * generation refs where they are and swaps the document under the read, so the
 * pair cannot see it and a reading of the pre-edit bytes would be installed
 * over the document that replaced its own subject.
 */
describe("#58 item 27: a refresh keeps its reading only for the document it started from", () => {
  it("drops a re-read an apply overtook inside one generation", async () => {
    const edited = editedEnvelope();
    const h = editorEngine({
      // Only an edited document answers with different text, so installing the
      // pre-edit reading where it does not belong is visible on the page.
      envelopeFor: (document) => (document.name.startsWith("edited-") ? edited : undefined),
      // The first read is the load; the second is the refresh's.
      holdRead: (document, call) => document.name === file.name && call > 1,
    });
    const ref = createRef<HwpEditorHandle>();
    const onError = vi.fn();
    render(<HwpEditor ref={ref} engine={h.engine} file={file} onError={onError} />);
    await screen.findByText(file.name);
    await selectAndQueueReplace(en);

    let settled: Promise<unknown> = Promise.resolve();
    act(() => {
      settled = handle(ref).refresh().then(() => "resolved", (error: unknown) => error);
    });
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));

    // The edit lands while the re-read is held, and no generation moves.
    await applyOne(en);
    await screen.findByText("edited-1.hwpx");

    await act(async () => { h.releaseRead(); });
    let outcome: unknown;
    await act(async () => { outcome = await settled; });

    // Rejected rather than resolved: the host asked for a re-read of what is on
    // screen and did not get one.
    expect((outcome as Error).message).toBe(en["error.staleRefreshEdit"]);
    // The host is told, because it is the only party that asked for the read.
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(en["error.staleRefreshEdit"]);
    // The edit's own envelope is still the one installed: the heading the page
    // carries is the edited one, not the pre-edit text the held read returned.
    await selectPara(en, 0);
    expect(await screen.findByText("개정된 안건")).toBeTruthy();
    expect(screen.queryByText("1. 회의록")).toBeNull();
    // The edit that overtook the read landed and installed its own envelope and
    // pages, so nothing on screen is wrong: no alert line is painted.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("installs a re-read that spanned an apply which failed, and resolves", async () => {
    const reRead = reReadEnvelope();
    const h = editorEngine({
      // The edit runs, and the READ OF ITS OWN RESULT fails: the store keeps
      // the document it started from, which is the case this guard must not
      // refuse. `applyStarted` staged a snapshot and `applyFailed` popped it,
      // so the stack moved twice and the document never did.
      failRead: (document) => document.name.startsWith("edited-"),
      // The apply holds its result until the test opens the gate, so the
      // re-read can start while the snapshot it staged is still on the stack.
      holdEdit: true,
      // The first read is the load; the next one of the open document is the
      // refresh's, and it is held past the apply's failure.
      holdRead: (document, call) => document.name === file.name && call > 1,
      // Only that re-read answers with different text, so its install is
      // visible on the page.
      envelopeFor: (document, call) => (document.name === file.name && call > 1 ? reRead : undefined),
    });
    const ref = createRef<HwpEditorHandle>();
    const view = render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await screen.findByText(file.name);
    await selectAndQueueReplace(en);

    // The apply is in flight - its snapshot is staged, its result read is not
    // answered yet - when the re-read starts.
    await applyOne(en);
    await vi.waitFor(() => expect(h.editStarted()).toBe(true));
    let settled: Promise<unknown> = Promise.resolve();
    act(() => {
      settled = handle(ref).refresh().then(() => "resolved", (error: unknown) => error);
    });
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));

    // The apply then fails, and its snapshot is popped: the document on screen
    // is still the one the re-read started from.
    await act(async () => { h.releaseEdit(); });
    await vi.waitFor(() => expect(view.container.firstElementChild?.getAttribute("data-status")).toBe("error"));

    await act(async () => { h.releaseRead(); });
    let outcome: unknown;
    await act(async () => { outcome = await settled; });

    // Nothing landed, so the reading describes the document still on screen:
    // installed, and the caller is told the surface was re-read.
    expect(outcome).toBe("resolved");
    await selectPara(en, 0);
    expect(await screen.findByText("1. 재조회")).toBeTruthy();
    expect(screen.queryByText("1. 회의록")).toBeNull();
  });
});

/**
 * #58 item 24: a created document replaces the open one, and while a load is
 * in flight the open one is the file the host has just left. The dialog is
 * disabled with the reason rather than allowed to compose onto a document that
 * is about to disappear.
 */
describe("#58 item 24: creating a document waits for a load in flight", () => {
  it("disables compose and create-from-template until the load lands", async () => {
    const h = editorEngine({
      templates: true,
      version: "1.4.0",
      templateMethods: [...TEMPLATE_METHODS],
      holdRead: (document) => document.name === switched.name,
    });
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    await screen.findByText(file.name);

    view.rerender(<HwpEditor engine={h.engine} file={switched} />);
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });

    // The cause and the next step, not a dead button.
    expect(within(dialog).getByText(en["compose.loadingInFlight"])).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: en["compose.submit"] }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const create = await within(dialog).findByRole("button", {
      name: en["templates.createEmbedded"],
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    expect(create.disabled).toBe(false);
    expect(within(dialog).queryByText(en["compose.loadingInFlight"])).toBeNull();
  });

  it("refuses a press while an earlier composition is still being read", async () => {
    // The composed path raises no hint at all: `onComposed` moves the
    // generation and reads the document without touching `loadInFlight`, so
    // the dialog reopens ENABLED while the editor is still taking the previous
    // composition on. The generations are the only guard there, and the
    // refusal has to be a sentence — nothing on this surface says a read is
    // running.
    const composed = "composed.hwpx";
    const h = editorEngine({ styles: true, holdRead: (document) => document.name === composed });
    const onError = vi.fn();
    render(<HwpEditor engine={h.engine} file={file} onError={onError} />);
    await screen.findByText(file.name);

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    let dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    fireEvent.change(within(dialog).getByLabelText(en["compose.titleLabel"]), {
      target: { value: "composed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    const submit = within(dialog).getByRole("button", { name: en["compose.submit"] }) as HTMLButtonElement;
    // Enabled, and no hint: this is the window the flag cannot cover.
    expect(submit.disabled).toBe(false);
    expect(within(dialog).queryByText(en["compose.loadingInFlight"])).toBeNull();

    fireEvent.change(within(dialog).getByLabelText(en["compose.titleLabel"]), {
      target: { value: "second" },
    });
    fireEvent.click(submit);

    // Refused on the generations, and said out loud: the composition is not
    // spent against a document this editor is still leaving.
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(en["error.loadingReplacement"]);
    // The host hears it too: every refusal in this editor reaches onError, so
    // a caller is never left with a press that did nothing.
    expect(onError.mock.calls.some(
      ([error]) => (error as Error).message === en["error.loadingReplacement"],
    )).toBe(true);
    expect(h.engine.calls.compose).toHaveLength(1);
    expect(screen.getByText(file.name)).toBeTruthy();

    // The composition being read is the one that lands, and the press is
    // offered again once it has.
    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.queryByText(file.name)).toBeNull());
    fireEvent.click(submit);
    await vi.waitFor(() => expect(h.engine.calls.compose).toHaveLength(2));
    await vi.waitFor(() => expect(screen.queryByText(composed)).toBeNull());
  });
});

/**
 * #58 item 28: "a document is still loading" describes a window, so it is
 * retired when that window closes. The dialog kept it until the next press, so
 * it went on claiming a load was running after the read that caused it had
 * landed or failed.
 */
describe("#58 item 28: the loading refusal is retired when the load settles", () => {
  /**
   * Compose once (which starts the held read), then reopen and press again:
   * the composed read raises no in-flight hint, so the press reaches the
   * generations and is refused on them.
   */
  async function refuseSecondPress(h: ReturnType<typeof editorEngine>): Promise<HTMLElement> {
    const openDialog = async (title: string): Promise<HTMLElement> => {
      fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
      const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
      fireEvent.change(within(dialog).getByLabelText(en["compose.titleLabel"]), {
        target: { value: title },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));
      return dialog;
    };

    await openDialog("composed");
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));
    const dialog = await openDialog("second");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(en["error.loadingReplacement"]);
    return dialog;
  }

  const refusalGone = async (): Promise<void> => {
    await vi.waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: en["compose.title"] })).queryByRole("alert"),
      ).toBeNull(),
    );
  };

  it("clears the refusal once the load it named lands", async () => {
    const h = editorEngine({ holdRead: (document) => document.name === "composed.hwpx" });
    render(<HwpEditor engine={h.engine} file={file} />);
    await screen.findByText(file.name);

    await refuseSecondPress(h);
    await act(async () => { h.releaseRead(); });
    await refusalGone();
  });

  it("clears it when that load fails", async () => {
    const h = editorEngine({
      holdRead: (document) => document.name === "composed.hwpx",
      failWhenReleased: (document) => document.name === "composed.hwpx",
    });
    render(<HwpEditor engine={h.engine} file={file} />);
    await screen.findByText(file.name);

    await refuseSecondPress(h);
    await act(async () => { h.releaseRead(); });
    await refusalGone();
  });
});

/**
 * #53 follow-up 1: `documentOrigin` moves when the editor takes on a NEW
 * document — where a load LANDS, not where it starts. A load that fails leaves
 * the previous document on screen and keeps editing it, so a choice made in
 * that document is still a choice in the document the user is working on.
 */
describe("#53 follow-up 1: documentOrigin moves where the load lands", () => {
  it("keeps the Styles choice across a failed load and retires it across a landed one", async () => {
    const h = editorEngine({ styles: true, failRead: (document) => document.name === broken.name });
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("true"));

    view.rerender(<HwpEditor engine={h.engine} file={broken} />);
    expect((await screen.findByRole("alert")).textContent).toContain(en["error.prefix.load"]);
    expect(styleRow().getAttribute("aria-pressed")).toBe("true");

    view.rerender(<HwpEditor engine={h.engine} file={switched} />);
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("false"));
  });

  it("retires the Styles choice when a composed document lands", async () => {
    const h = editorEngine({ styles: true });
    render(<HwpEditor engine={h.engine} file={file} />);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));

    // A composed document replaces the stored one without changing the host's
    // file, so the panel's counter — not the file name — is what retires it.
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("false"));
  });

  it("retires a choice made while the composed document is being read", async () => {
    // The counter moves where the composed document is TAKEN, not where its
    // read starts. A press made during that read belongs to the document on
    // screen, so it must be retired when the composed one lands — exactly as a
    // choice made before the press is. Bumping at the start of the compose
    // would count this press against the new document and keep it highlighted
    // on the next document's row with the same id.
    const composed = "composed.hwpx";
    const h = editorEngine({ styles: true, holdRead: (document) => document.name === composed });
    render(<HwpEditor engine={h.engine} file={file} />);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    await screen.findByRole("button", { name: /바탕글/ });

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    fireEvent.change(within(dialog).getByLabelText(en["compose.titleLabel"]), {
      target: { value: "composed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));

    // Made against the document the store still holds — the read has not
    // landed, so this is a choice in the old document.
    fireEvent.click(styleRow());
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("true"));

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("false"));
    // The composed document is the one open now, so the choice was made in a
    // document that is gone rather than in the one that arrived.
    expect(screen.queryByText(file.name)).toBeNull();
  });

  it("keeps the Styles choice when the composed read fails", async () => {
    // The mirror image: a composed read that fails leaves the previous
    // document on screen and editable, so a choice in it is still a choice in
    // the document the user is working on. Only the landing retires it.
    const composed = "composed.hwpx";
    const h = editorEngine({ styles: true, failRead: (document) => document.name === composed });
    render(<HwpEditor engine={h.engine} file={file} />);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(await screen.findByRole("button", { name: /바탕글/ }));
    await vi.waitFor(() => expect(styleRow().getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(screen.getByRole("button", { name: en["toolbar.newDocument"] }));
    const dialog = await screen.findByRole("dialog", { name: en["compose.title"] });
    fireEvent.change(within(dialog).getByLabelText(en["compose.titleLabel"]), {
      target: { value: "composed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: en["compose.submit"] }));

    // The failure reached the surface, so the old document really is what is
    // being edited — otherwise the surviving highlight would prove nothing.
    expect((await screen.findByRole("alert")).textContent).toContain(en["error.prefix.load"]);
    expect(screen.getByText(file.name)).toBeTruthy();
    expect(styleRow().getAttribute("aria-pressed")).toBe("true");
  });
});

/**
 * #53 follow-up 4: a preset press belongs to the document it was pressed in.
 * Its outcome sentence says what happened to THAT document, so a press that
 * resolves after the host switched file has nothing to say about the one on
 * screen — and the load that took over ends the condition the sentence would
 * describe.
 */
describe("#53 follow-up 4: a preset press outlived by its document", () => {
  it("posts no notice when the press resolves after a file switch", async () => {
    const h = editorEngine({
      styles: true,
      holdEdit: true,
      report: unchangedReport(),
      holdRead: (document) => document.name === switched.name,
    });
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    fireEvent.click(await screen.findByRole("tab", { name: en["tabs.styles"] }));
    fireEvent.click(await screen.findByRole("button", { name: en["styles.presetSubmit"] }));
    await vi.waitFor(() => expect(h.editStarted()).toBe(true));

    view.rerender(<HwpEditor engine={h.engine} file={switched} />);
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));

    // "This preset is already in place" is a sentence about the document the
    // host has left, so the press's own generation keeps it off the line even
    // before the next document has finished loading.
    await act(async () => {
      h.releaseEdit();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    expect(screen.queryByText(en["styles.presetUnchanged"])).toBeNull();

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());
    expect(screen.queryByText(en["styles.presetUnchanged"])).toBeNull();
  });
});

/** Every alert line's text, so a sentence can be found wherever it is painted. */
const alertTexts = (): string[] =>
  screen.queryAllByRole("alert").map((node) => node.textContent ?? "");

/**
 * #58 item 23a: an apply dropped by a load is recorded with "a new document is
 * still loading; wait for it to finish". When that load FAILS, the next step
 * it names has become impossible, and the line says the stale thing it now is.
 * Only the line carrying that exact sentence is restated: any other reason is
 * left where it is.
 */
describe("#58 item 23a: a dropped apply's sentence when the load that dropped it fails", () => {
  it("restates its still-loading sentence as the stale one", async () => {
    const h = editorEngine({
      holdEdit: true,
      holdRead: (document) => document.name === broken.name,
      failWhenReleased: (document) => document.name === broken.name,
    });
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await vi.waitFor(() => expect(h.editStarted()).toBe(true));

    // The switch starts a load; the edit then answers, and its result belongs
    // to the document the host has left, so it is dropped onto the store's
    // line — in the sentence that expects the load to finish.
    view.rerender(<HwpEditor engine={h.engine} file={broken} />);
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));
    await act(async () => { h.releaseEdit(); });

    // The order the swap depends on: the dropped apply's line is there BEFORE
    // the load ends, and it is the loading sentence it was recorded with.
    await vi.waitFor(() => expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.apply"]) && text.includes(en["error.loadingReplacement"]),
    )).toBe(true));

    await act(async () => { h.releaseRead(); });

    // The load has failed, so nothing is coming to finish: the line says the
    // edit's result was discarded, and the load's own line names the file.
    await vi.waitFor(() => expect(alertTexts().some(
      (text) => text.includes(en["error.staleApply"]),
    )).toBe(true));
    expect(alertTexts().some((text) => text.includes(en["error.loadingReplacement"]))).toBe(false);
    expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.apply"]) && text.includes(en["error.staleApply"]),
    )).toBe(true);
    expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.load"]) && text.includes("read failed: broken.hwpx"),
    )).toBe(true);
  });

  it("leaves a line that carries a different reason alone", async () => {
    const h = editorEngine({ failRead: (document) => document.name === broken.name });
    // An edit that FAILS, so the store's line carries the engine's own reason
    // rather than the loading sentence. Restating it would overwrite the one
    // cause the user can act on.
    h.engine.edit = async () => { throw new Error("edit failed"); };
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await vi.waitFor(() => expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.apply"]) && text.includes("edit failed"),
    )).toBe(true));

    view.rerender(<HwpEditor engine={h.engine} file={broken} />);
    await vi.waitFor(() => expect(alertTexts().length).toBe(2));

    expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.apply"]) && text.includes("edit failed"),
    )).toBe(true);
    expect(alertTexts().some((text) => text.includes(en["error.prefix.load"]))).toBe(true);
    expect(alertTexts().some((text) => text.includes(en["error.staleApply"]))).toBe(false);
  });
});

/**
 * #58 item 23b: the loading notice is posted in the locale of the press. A
 * load that ends after the host switched language holds the OLD locale's
 * sentence, so a retirement keyed on the current locale's spelling leaves it
 * on the line forever.
 */
describe("#58 item 23b: the loading notice survives a locale switch only until the load ends", () => {
  it("retires a notice posted before the locale switched mid-load", async () => {
    const h = editorEngine({ holdRead: (document) => document.name === switched.name });
    const view = render(<HwpEditor engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await screen.findByText(pending(en, 1));

    view.rerender(<HwpEditor engine={h.engine} file={switched} />);
    await vi.waitFor(() => expect(h.readStarted()).toBe(true));
    // Refused while the load runs, so the notice is the English sentence.
    await applyOne(en);
    expect(await screen.findByText(en["error.loadingReplacement"])).toBeTruthy();

    // The load is still running when the host switches language: the notice
    // keeps the text it was posted with, which is the point.
    view.rerender(<HwpEditor locale="ko" engine={h.engine} file={switched} />);
    await vi.waitFor(() => expect(screen.getByText(en["error.loadingReplacement"])).toBeTruthy());

    await act(async () => { h.releaseRead(); });
    await vi.waitFor(() => expect(screen.getByText(switched.name)).toBeTruthy());

    // Nothing is loading any more, so neither locale's sentence may remain.
    expect(screen.queryByText(en["error.loadingReplacement"])).toBeNull();
    expect(screen.queryByText(ko["error.loadingReplacement"])).toBeNull();
  });
});

/**
 * #58 item 29: a re-read has its own subject. The document the host chose is
 * still open, so a re-read failure cannot say "failed to open document", the
 * line it paints belongs to the next refresh rather than the next load, and no
 * refresh may retire a real load failure.
 */
describe("#58 item 29: a re-read failure has its own line", () => {
  it("paints the refresh prefix, never the load one, in the locale on screen", async () => {
    const h = editorEngine();
    const ref = createRef<HwpEditorHandle>();
    const view = render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await screen.findByText(file.name);
    // Only the re-read fails; the load has already succeeded.
    h.engine.render = async () => { throw new Error("render failed"); };

    await act(async () => {
      await expect(handle(ref).refresh()).rejects.toThrow("render failed");
    });

    const line = screen.getByRole("alert").textContent ?? "";
    expect(line).toContain(en["error.prefix.refresh"]);
    expect(line).toContain("render failed");
    // The document the host chose is open: it was not opened again.
    expect(line).not.toContain(en["error.prefix.load"]);

    // The prefix is chrome, so it follows the locale like every other line.
    view.rerender(<HwpEditor ref={ref} locale="ko" engine={h.engine} file={file} />);
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain(ko["error.prefix.refresh"]));
    expect(screen.getByRole("alert").textContent).not.toContain(ko["error.prefix.load"]);
  });

  it("retires that line when a later refresh succeeds", async () => {
    const h = editorEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await screen.findByText(file.name);
    const renderPages = h.engine.render.bind(h.engine);
    h.engine.render = async () => { throw new Error("render failed"); };
    await act(async () => {
      await expect(handle(ref).refresh()).rejects.toThrow("render failed");
    });
    expect(screen.getByRole("alert").textContent).toContain(en["error.prefix.refresh"]);

    // The next refresh reads the same bytes and succeeds, so the failure it
    // replaces describes nothing on screen any more.
    h.engine.render = renderPages;
    await act(async () => { await handle(ref).refresh(); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(file.name)).toBeTruthy();
  });

  it("never clears or replaces a real load failure", async () => {
    const h = editorEngine({ failRead: (document) => document.name === broken.name });
    const ref = createRef<HwpEditorHandle>();
    const view = render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await screen.findByText(file.name);

    view.rerender(<HwpEditor ref={ref} engine={h.engine} file={broken} />);
    const loadLine = await screen.findByRole("alert");
    expect(loadLine.textContent).toContain(en["error.prefix.load"]);
    expect(loadLine.textContent).toContain("read failed: broken.hwpx");

    // A refresh of the document still open SUCCEEDS, and cannot answer for the
    // file the host asked for: that failure is still the one thing to fix.
    await act(async () => { await handle(ref).refresh(); });
    expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.load"]) && text.includes("read failed: broken.hwpx"),
    )).toBe(true);

    // A refresh that fails is a SECOND line, because it names a different
    // document: the store line would otherwise lose the load's reason.
    h.engine.render = async () => { throw new Error("render failed"); };
    await act(async () => {
      await expect(handle(ref).refresh()).rejects.toThrow("render failed");
    });
    expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.load"]) && text.includes("read failed: broken.hwpx"),
    )).toBe(true);
    expect(alertTexts().some(
      (text) => text.includes(en["error.prefix.refresh"]) && text.includes("render failed"),
    )).toBe(true);
  });
});

/**
 * #58 item 30: the undo reads the document it would restore, so its failure is
 * the same kind of failure a refresh has and belongs on the same line, while a
 * load failure keeps the reason it was painted with. And a re-read failure is
 * retired by any transition that reads and installs the document, not only by
 * the next refresh.
 */
describe("#58 item 30: undo's read failure and the re-read line", () => {
  const lineHas = (prefix: string, reason: string): boolean =>
    alertTexts().some((text) => text.includes(prefix) && text.includes(reason));

  it("keeps a failed load's reason when the undo that follows also fails", async () => {
    const h = editorEngine({ failRead: (document) => document.name === broken.name });
    const ref = createRef<HwpEditorHandle>();
    const view = render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    // The snapshot exists only once the edit settled, and that is what the
    // undo below restores. A load that FAILS does not drop it: the previous
    // document stays open.
    await screen.findByText(pending(en, 0));

    view.rerender(<HwpEditor ref={ref} engine={h.engine} file={broken} />);
    await vi.waitFor(() => expect(
      lineHas(en["error.prefix.load"], "read failed: broken.hwpx"),
    ).toBe(true));

    // Undo is still offered on the document that remains open, and now its own
    // read is the one that fails.
    h.engine.read = async () => { throw new Error("undo read failed"); };
    const revert = screen.getByRole("button", { name: en["toolbar.revert"] }) as HTMLButtonElement;
    expect(revert.disabled).toBe(false);
    fireEvent.click(revert);
    await vi.waitFor(() => expect(
      lineHas(en["error.prefix.refresh"], "undo read failed"),
    ).toBe(true));

    // The open document is still open, so nothing claims it could not be
    // opened, and the file the host asked for keeps its own reason.
    expect(lineHas(en["error.prefix.load"], "undo read failed")).toBe(false);
    expect(lineHas(en["error.prefix.load"], "read failed: broken.hwpx")).toBe(true);

    // The prefix is chrome, so it follows the locale like every other line.
    view.rerender(<HwpEditor ref={ref} locale="ko" engine={h.engine} file={broken} />);
    await vi.waitFor(() => expect(
      lineHas(ko["error.prefix.refresh"], "undo read failed"),
    ).toBe(true));
  });

  it("retires the re-read line when an apply lands", async () => {
    const h = editorEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await screen.findByText(file.name);
    const renderPages = h.engine.render.bind(h.engine);
    h.engine.render = async () => { throw new Error("render failed"); };
    await act(async () => {
      await expect(handle(ref).refresh()).rejects.toThrow("render failed");
    });
    expect(screen.getByRole("alert").textContent).toContain(en["error.prefix.refresh"]);

    // The apply reads the edited bytes and installs them, so the failed
    // reading describes nothing on screen any more.
    h.engine.render = renderPages;
    await selectAndQueueReplace(en);
    await applyOne(en);
    await screen.findByText(pending(en, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retires the re-read line when an undo lands", async () => {
    const h = editorEngine();
    const ref = createRef<HwpEditorHandle>();
    render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await screen.findByText(pending(en, 0));

    const renderPages = h.engine.render.bind(h.engine);
    h.engine.render = async () => { throw new Error("render failed"); };
    await act(async () => {
      await expect(handle(ref).refresh()).rejects.toThrow("render failed");
    });
    expect(screen.getByRole("alert").textContent).toContain(en["error.prefix.refresh"]);

    h.engine.render = renderPages;
    fireEvent.click(screen.getByRole("button", { name: en["toolbar.revert"] }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText(file.name)).toBeTruthy();
  });

  /**
   * t43-a1: after a failed undo this line is the only answer to the press, so
   * its next step has to be one the reader can take. The editor ships no
   * Refresh control (refresh lives on `HwpEditorHandle`), and what a failed
   * undo asks for is the undo again - so the sentence says nothing changed and
   * names the repeated action, in both locales.
   */
  it("asks for the same action again instead of a refresh the page does not offer", async () => {
    const h = editorEngine();
    const ref = createRef<HwpEditorHandle>();
    const view = render(<HwpEditor ref={ref} engine={h.engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);
    await screen.findByText(pending(en, 0));

    // Only the undo's read fails, so the re-read line is the whole answer.
    h.engine.read = async () => { throw new Error("undo read failed"); };
    fireEvent.click(screen.getByRole("button", { name: en["toolbar.revert"] }));
    await vi.waitFor(() => expect(lineHas(en["error.prefix.refresh"], "undo read failed")).toBe(true));

    const english = alertTexts().find((text) => text.includes("undo read failed")) ?? "";
    expect(english).toContain("so nothing changed");
    expect(english).toContain("try the same action again");
    expect(english.toLowerCase()).not.toContain("refresh");

    view.rerender(<HwpEditor ref={ref} locale="ko" engine={h.engine} file={file} />);
    await vi.waitFor(() => expect(lineHas(ko["error.prefix.refresh"], "undo read failed")).toBe(true));

    const korean = alertTexts().find((text) => text.includes("undo read failed")) ?? "";
    expect(korean).toContain("아무것도 바뀌지 않았습니다");
    expect(korean).toContain("같은 작업을 다시 시도하세요");
    expect(korean).not.toContain("새로 고치");
  });
});

/**
 * #58 item 19d: a host's own `HwpEngine` hands back a decoded envelope, and
 * nothing held it to the contract before render did - `segmentText` throws
 * from inside a component, where no boundary catches it, so the surface broke
 * instead of saying what was wrong. Every read the editor performs now projects
 * the result first, and a refusal names the cause and the next step.
 */
describe("#58 item 19d: a read result this editor cannot render", () => {
  /** A paragraph whose range runs past the markdown it publishes. */
  const brokenEnvelope = (): CatEnvelope => ({
    markdown: "가나다",
    segments: [{ id: "past-end", start: 0, end: 9, kind: "para", section: 0, para: 0 }],
  });

  /**
   * The localized clause of the sentence, up to the cause core supplies after
   * its ": ". The cause is core's own problem phrase, and pinning it whole here
   * would make this test a copy of that wording.
   */
  const sentenceLead = (t: MessageTable): string =>
    t["error.badEnvelope"]({ detail: "" }).split(": ")[0] ?? "";

  it("refuses a load whose read result names an offset past its markdown", async () => {
    const engine = createMockEngine({ envelope: makeEnvelope() });
    engine.read = async () => brokenEnvelope();
    render(<HwpEditor engine={engine} file={file} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en["error.prefix.load"]);
    // The localized sentence leads and the core cause rides inside it, so the
    // reader gets both the reason and what to do about it.
    expect(alert.textContent).toContain(sentenceLead(en));
    expect(alert.textContent).toContain("character range exceeds markdown");
    // Only the cause half of core's message travels: core's own text ends with
    // a next step of its own, and carrying it here would put two instructions
    // and a "(... reload.)." sequence in one line (t71-1).
    expect(alert.textContent).not.toContain("upgrade the host adapter");
    expect(alert.textContent).not.toContain(".).");
    // Nothing reached render: no page was drawn, and the panel is the empty
    // state rather than a crash over a segment it cannot read.
    expect(screen.queryByRole("button", { name: en["page.label"]({ page: 1 }) })).toBeNull();
    expect(screen.getByText(en["segment.hint"])).toBeTruthy();
  });

  it("says the same thing in Korean", async () => {
    const engine = createMockEngine({ envelope: makeEnvelope() });
    engine.read = async () => brokenEnvelope();
    render(<HwpEditor locale="ko" engine={engine} file={file} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ko["error.prefix.load"]);
    expect(alert.textContent).toContain(sentenceLead(ko));
  });

  it("refuses a load whose read result carries a nesting path that is not a list", async () => {
    // The selection fields are the part of the envelope nothing held before:
    // the published type says `indices` is there, a host's own projection may
    // have put anything in it, and `resolveSelection` reads it one frame above
    // the boundary that can report it (#147).
    const engine = createMockEngine({ envelope: makeEnvelope() });
    engine.read = async () => ({
      markdown: "가나다",
      segments: [{ id: "bad-indices", start: 0, end: 3, kind: "para", section: 0, para: 0, indices: "0.0" }],
    }) as unknown as CatEnvelope;
    render(<HwpEditor engine={engine} file={file} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en["error.prefix.load"]);
    expect(alert.textContent).toContain(sentenceLead(en));
    expect(alert.textContent).toContain("segment indices is not a non-empty array of non-negative integers");
    expect(alert.textContent).not.toContain("upgrade the host adapter");
    // Nothing reached render: no page was drawn over a segment whose nesting
    // path cannot be walked.
    expect(screen.queryByRole("button", { name: en["page.label"]({ page: 1 }) })).toBeNull();
  });

  it("refuses a malformed envelope on an apply's re-read and keeps the queued op", async () => {
    // The apply re-reads the document it just wrote, which is the read a user
    // reaches without any host change: the envelope the engine hands back
    // after an edit is held to the same contract as the one at load.
    const envelope = makeEnvelope();
    const engine = createMockEngine({ envelope });
    let reads = 0;
    engine.read = async () => (reads++ === 0 ? envelope : brokenEnvelope());
    render(<HwpEditor engine={engine} file={file} />);
    await selectAndQueueReplace(en);
    await applyOne(en);

    await vi.waitFor(() =>
      expect(alertTexts().some((text) => text.includes(sentenceLead(en)))).toBe(true));
    expect(alertTexts().some((text) => text.includes("character range exceeds markdown"))).toBe(true);
    // Nothing was replaced: the document on screen is the one the apply
    // started from, and the op it could not settle is still queued.
    expect(await screen.findByText(pending(en, 1))).toBeTruthy();
  });
});
