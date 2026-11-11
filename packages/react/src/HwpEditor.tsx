import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, JSX, KeyboardEvent } from "react";
import type {
  Capabilities,
  CatEnvelope,
  Component,
  DocumentHandle,
  EditReport,
  HwpEngine,
  EditOp,
  ImageAsset,
  ParagraphAddress,
  Segment,
  StyleTable,
  ValidationReport,
} from "@hwp-editor/core";
import type { AddressedEditOp } from "@hwp-editor/core";
import { compareSegments, componentStyleMap, createStore, insertedParagraphIds, isSectionDefinitionParagraph, resolveSelection, segmentAtRef, segmentRef, substituteParams, validateImageAssets, HwpEngineError, MAX_IMAGE_ASSETS, MAX_IMAGE_ASSETS_TOTAL_BYTES, STARTER_COMPONENTS } from "@hwp-editor/core";
import type { EditorError, EditorState, EditorStore } from "@hwp-editor/core";
import { HwpEditorContext } from "./context.js";
import type { HwpEditorContextValue, StylesStatus } from "./context.js";
import { PageCanvas } from "./PageCanvas.js";
import { SegmentInspector } from "./SegmentInspector.js";
import { StylesPanel } from "./StylesPanel.js";
import { TableGrid } from "./TableGrid.js";
import { FieldsPanel } from "./FieldsPanel.js";
import { TemplatePanel } from "./TemplatePanel.js";
import { LintPanel } from "./LintPanel.js";
import { DocumentPanel } from "./DocumentPanel.js";
import { ImagePanel } from "./ImagePanel.js";
import { ComposePanel } from "./ComposePanel.js";
import { ComponentsPanel } from "./ComponentsPanel.js";
import { componentsSupportReason } from "./ComponentsPanel.js";
import type { InsertPosition } from "./ComponentsPanel.js";
import { componentFailure, insertionFailure, insertionPreflight } from "./components-support.js";
import { isTableSlice } from "./tables.js";
import { ErrorLine } from "./ErrorLine.js";
import { isUnmatchedReplaceRefusal, toEditorError } from "./errors.js";
import { createT } from "./messages.js";
import type { HwpEditorMessages, Locale } from "./messages.js";
import { segmentText } from "@hwp-editor/core";

export interface HwpEditorProps {
  /** Engine implementation (HTTP client, local adapter, mock in tests). */
  engine: HwpEngine;
  /** Document to open; null shows the empty state with the new-doc entry. */
  file: DocumentHandle | null;
  /**
   * UI language for the editor chrome. Defaults to `"en"`. Read at mount and
   * on change; also drives the root `lang` attribute. Document content and
   * engine-authored error prose are never translated.
   */
  locale?: Locale;
  /**
   * Per-key overrides applied on top of the locale table. A key not listed
   * keeps its locale default; unknown keys are a compile error.
   */
  messages?: HwpEditorMessages;
  /**
   * Force the editor read-only regardless of what the engine reports. A UI
   * affordance, NOT an authorization boundary: a host that must actually
   * prevent writes enforces that server-side (see the server package's
   * `authorize` hook). Wins over an editable engine; never re-enables a
   * document the engine reports as protected.
   */
  readOnly?: boolean;
  /**
   * Component catalogue the palette offers and the new-document assembly
   * composes from. Defaults to the shipped starters; a host with its own
   * library passes what `loadComponents` returned.
   */
  components?: readonly Component[];
  /**
   * Called once per completed document load, after both the read and the
   * render resolve, with the document that was loaded. Fires again on every
   * `file` change; never fires for `file={null}` or a load cancelled by
   * unmount.
   */
  onReady?: (document: DocumentHandle) => void;
  /**
   * Called for every engine failure — load, apply, undo, refresh, and
   * compose — with the caught value verbatim, so a host can branch on the
   * stable `code` of a `HwpEngineError`. The inline alert renders either
   * way; this is an addition to it, not a replacement.
   */
  onError?: (error: unknown) => void;
  /** Called whenever the document bytes change (applied edit, undo, compose). */
  onChange?: (document: DocumentHandle) => void;
  /** Called when the dirty flag (pending ops queued) changes. */
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * Imperative surface a host reaches through `ref`. Exactly four methods at
 * 1.0.0 and no state getters: hosts observe state through `onChange` /
 * `onDirtyChange` / `onReady` / `onError`, which stay in sync with React
 * rendering in a way a getter read from outside the render cycle cannot.
 */
export interface HwpEditorHandle {
  /**
   * Apply the queued edit ops. Resolves without touching the engine when the
   * queue is empty, no document is loaded, an apply is already in flight, or
   * the editor is read-only.
   */
  apply(): Promise<void>;
  /**
   * Undo the last applied edit. Resolves without touching the engine when the
   * snapshot stack is empty.
   */
  revert(): Promise<void>;
  /**
   * Re-read and re-render the current document after an external change.
   * Rejects if the engine fails (after firing `onError` and showing the alert).
   */
  refresh(): Promise<void>;
  /** Open the new-document compose dialog. */
  openCompose(): void;
}

type SideTab = "para" | "styles" | "table" | "fields" | "templates" | "components" | "lint" | "document" | "images";

/**
 * Every paragraph the current selection covers, in document order.
 *
 * A selection is a list of refs, not one: a component that inserts several
 * paragraphs leaves its whole run selected, and `state.selection` is only the
 * primary (first) paragraph of that run. Resolving the primary alone is what
 * used to make a second insertion land between the first component's heading
 * and its items.
 *
 * Each unit resolves through `resolveSelection`, so a cell contributes the
 * paragraphs inside it and a table, image, field or bookmark contributes none.
 */
function selectionParagraphs(envelope: CatEnvelope, state: EditorState): Segment[] {
  const refs = state.selections !== undefined && state.selections.length > 0
    ? state.selections
    : state.selection === null ? [] : [state.selection];
  const seen = new Set<string>();
  const paragraphs: Segment[] = [];
  for (const ref of refs) {
    const segment = segmentAtRef(envelope, ref);
    if (segment === undefined) continue;
    for (const paragraph of resolveSelection(envelope, segment).paragraphs) {
      const key = paragraph.id ?? `${paragraph.section}:${paragraph.para}:${paragraph.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      paragraphs.push(paragraph);
    }
  }
  return paragraphs.sort(compareSegments);
}

/**
 * Where a component goes: the edge of the paragraphs the same selection
 * resolves to for an edit, never a guess about the segment's kind.
 *
 * `covered` is in document order, so "after" addresses its last paragraph and
 * "before" its first: a box inserted before a cell's text does not land between
 * the cell's own paragraphs, and a component inserted after a run of paragraphs
 * goes below all of them rather than inside them. With nothing covered there is
 * no anchor, and a paragraph with no id cannot be addressed at all.
 */
function insertAnchor(covered: readonly Segment[], position: InsertPosition): ParagraphAddress | null {
  const paragraph = position === "before" ? covered[0] : covered[covered.length - 1];
  return paragraph?.id === undefined ? null : { id: paragraph.id };
}

/** Whatever a refusal path threw, as the `Error` the error line renders. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Every render goes straight to the engine. The former client-side
 * SVG-to-PNG catch-all turned a timeout, a missing binary, or a network
 * error into a second full CLI render and masked which one it was
 * (BUG-01). The one legitimate retry lives in the engine, gated on a real
 * format failure: CliEngine at cli-engine.ts:445-451 (`reason === "failed"`)
 * and maru at hwped.rs:485-486 (the `hwp_failed:` prefix).
 */
const RENDER_SVG = { format: "svg" } as const;

/**
 * Top-level embeddable editor. Layout: toolbar (apply/revert/validation
 * badge/pending-ops count/protected notice) | PageCanvas | side panel
 * (SegmentInspector / TableGrid / FieldsPanel tabs). The new-document entry
 * point opens ComposePanel.
 */
export const HwpEditor = forwardRef<HwpEditorHandle, HwpEditorProps>(
  function HwpEditor(props, ref): JSX.Element {
    const {
      engine,
      file,
      locale = "en",
      messages,
      readOnly = false,
      components,
      onReady,
      onError,
      onChange,
      onDirtyChange,
      className,
      style,
    } = props;

    // One catalogue for both surfaces: the palette and the new-document
    // assembly must offer the same components.
    const catalogue = components ?? STARTER_COMPONENTS;

    /**
     * Host callbacks are deliberately NON-REACTIVE. They live in this one
     * bundle ref and reach the component only through the stable dispatchers
     * below. Putting any of them back into a dependency array turns an
     * ordinary host re-render — the inline-arrow idiom every React host
     * writes — into a full engine round trip (capabilities + read + render +
     * validate) against the same document, which is worst on exactly the
     * multi-megabyte documents BUG-06's chunked codec was added to serve.
     */
    const cbRef = useRef({ onReady, onError, onChange, onDirtyChange });
    // No dependency array on purpose: this runs after EVERY render, so a
    // dispatcher fired later always reaches the host's latest identity rather
    // than a mount-time closure. Declared above the load effect because React
    // runs a component's effects in declaration order.
    useEffect(() => {
      cbRef.current = { onReady, onError, onChange, onDirtyChange };
    });

    // Forward-only dispatchers, stable for the component's lifetime. They
    // pass the argument by reference and return nothing: no wrapping, no
    // re-throwing, no synthesized code (03-CONTEXT D-09).
    const emitReady = useCallback((document: DocumentHandle): void => {
      cbRef.current.onReady?.(document);
    }, []);
    const emitError = useCallback((error: unknown): void => {
      cbRef.current.onError?.(error);
    }, []);
    const emitChange = useCallback((document: DocumentHandle): void => {
      cbRef.current.onChange?.(document);
    }, []);
    const emitDirty = useCallback((dirty: boolean): void => {
      cbRef.current.onDirtyChange?.(dirty);
    }, []);

    const t = useMemo(() => createT(locale, messages), [locale, messages]);

    const [store] = useState<EditorStore>(() => createStore());
    // getServerSnapshot is required for SSR hosts (Next.js); a fresh store's
    // state is always initialState server-side.
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

    const [envelope, setEnvelope] = useState<CatEnvelope | null>(null);
    const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
    const [validation, setValidation] = useState<ValidationReport | null>(null);
    // `code` is deliberately optional: a host-supplied engine, a mock, or a
    // React-internal throw legitimately has none, and synthesizing `internal`
    // would be indistinguishable from a real `internal`.
    const [loadError, setLoadError] = useState<EditorError | null>(null);
    /**
     * A sentence about an operation the editor finished differently than the
     * document did: an insertion whose report names no usable ids, so nothing
     * can be selected, or one the editor refuses to send at all. Neither is a
     * failure line, so it is shown here and still reaches the host through
     * `onError`. A new document load clears it.
     */
    const [notice, setNotice] = useState<string | null>(null);
    /**
     * Bumped when a load starts. A flow that captured it before awaiting can
     * tell that a newer load superseded its result.
     */
    const loadGeneration = useRef(0);
    /**
     * The generation of the last load that finished, successfully or not.
     * While it differs from `loadGeneration.current` a load is in flight, and
     * the store still holds the document the flow started from: replacing the
     * document then would overwrite the file the host just chose.
     */
    const loadedGeneration = useRef(0);
    /**
     * A counter that moves whenever the editor takes on a NEW document: a load,
     * or a composed document handed back. An applied edit and an undo keep it,
     * because they move within the document the user is working on.
     *
     * Panels that hold a choice tied to the document read this rather than the
     * host's file: a compose replaces the document without changing it, and two
     * different files can share a name, so neither the name nor the document
     * handle answers "is this still the document I chose in".
     */
    const [documentOrigin, setDocumentOrigin] = useState(0);
    const [tab, setTab] = useState<SideTab>("para");
    const [composing, setComposing] = useState(false);
    /**
     * The current document's named styles, read once per document. The Styles
     * panel and the direct-format indicator both read this one table: two
     * independent reads would let the indicator name a style the panel's list
     * no longer carries.
     *
     * The answer is stored WITH the document it describes, and handed out only
     * while that document is still the one on screen. A read that lands after
     * the file changed describes paragraphs this document does not have —
     * segment ids are content checksums — so the pairing is the guard, not the
     * effect's cancellation flag.
     */
    const [stylesLoad, setStylesLoad] = useState<{ document: DocumentHandle; table: StyleTable | null; failed: boolean } | null>(null);
    const styles = state.document !== null && stylesLoad !== null && stylesLoad.document === state.document
      ? stylesLoad.table
      : null;
    /**
     * Why the styles table is what it is. A host can advertise the capability
     * and still hand over an engine object with no `styles` to call: that is
     * `unsupported`, not a read in flight, and leaving it at `loading`
     * promised an answer that never comes.
     */
    const stylesStatus: StylesStatus = (() => {
      if (state.document === null || capabilities?.styles !== "v1") return "idle";
      if (engine.styles === undefined) return "unsupported";
      if (stylesLoad === null || stylesLoad.document !== state.document) return "loading";
      return stylesLoad.failed ? "failed" : "ready";
    })();
    /**
     * Ids one insertion reported, held until the re-read envelope carries them.
     * The paragraphs do not exist in the envelope the op was sent with, so the
     * selection is built from the envelope that reads them back, in real paths
     * rather than guessed ones. They are the only record of an insertion: a
     * row list would keep ids that describe the document as it was written.
     */
    const [pendingInserted, setPendingInserted] = useState<string[]>([]);
    /**
     * Show a notice, and hand a failure to the host.
     *
     * A palette refusal is not an engine failure of the document, so it does
     * not take the error line; it is shown here (role="status") and `onError`
     * still hears it, with the error as it came so a host that branches on a
     * `code` keeps the code. A caller with no error to hand over is reporting
     * an OUTCOME, not a failure — a preset whose document has no table to
     * style — and that must not reach `onError`, which promises the work went
     * wrong.
     */
    const noteNotice = useCallback((text: string, error?: unknown): void => {
      setNotice(text);
      if (error !== undefined) emitError(error);
    }, [emitError]);
    /**
     * Report a refusal: an edit the user asked for that did not happen. The
     * host hears it even though the engine never answered, so the sentence is
     * carried as an `Error` when there is no engine failure to carry instead.
     */
    const noteRefusal = useCallback((text: string, error?: unknown): void => {
      noteNotice(text, error ?? new Error(text));
    }, [noteNotice]);
    /**
     * The sentence a refusal made during a load puts on the notice line. Kept
     * as a ref so a load that ends can retire exactly that sentence — and no
     * other notice — without the load effect depending on the locale.
     */
    const loadingSentence = useRef("");
    loadingSentence.current = t("error.loadingReplacement");
    /**
     * Mark a load complete, which opens the replacement guard, and drop the
     * "still loading" sentence it has just made untrue: that notice is set
     * while a load runs, so nothing else would ever take it down.
     */
    const markLoaded = useCallback((generation: number): void => {
      loadedGeneration.current = generation;
      setNotice((current) => (current === loadingSentence.current ? null : current));
    }, []);
    /** The envelope an attempt has already been made against, so none repeats. */
    const insertedTriedFor = useRef<CatEnvelope | null>(null);
    const imageAssets = useRef(new Map<EditOp, ImageAsset>());
    useEffect(() => {
      const active = new Set(state.pendingOps);
      for (const op of imageAssets.current.keys()) if (!active.has(op)) imageAssets.current.delete(op);
    }, [state.pendingOps]);

    // Select the paragraphs an insertion created. `insert_blocks` names them
    // only in the edit report, so a ref for one can be built only against the
    // envelope that reads the new document back, whose paths are the engine's.
    // One attempt per envelope: a host whose ids no paragraph carries leaves
    // nothing to select, and the ids are dropped rather than retried forever.
    useEffect(() => {
      if (pendingInserted.length === 0 || envelope === null) return;
      if (insertedTriedFor.current === envelope) return;
      insertedTriedFor.current = envelope;
      const paragraphs = pendingInserted.flatMap((id) => {
        const segment = segmentAtRef(envelope, { id, section: 0, para: 0 });
        return segment === undefined || segment.kind !== "para" ? [] : [segment];
      });
      setPendingInserted([]);
      if (paragraphs.length === 0) return;
      store.dispatch({
        type: "selectMany",
        selections: paragraphs.map(segmentRef),
        primary: segmentRef(paragraphs[0]!),
        anchor: segmentRef(paragraphs[0]!),
      });
    }, [envelope, pendingInserted, store]);

    // Load the document whenever the engine/file pair changes.
    useEffect(() => {
      const generation = ++loadGeneration.current;
      // Every load is a new document, even one whose file has the name of the
      // document it replaces: a panel's choice of row belongs to the one before.
      setDocumentOrigin((count) => count + 1);
      let cancelled = false;
      // A notice describes one attempt against the document that is going
      // away, so a load retires it along with that document's ids.
      setNotice(null);
      if (file === null) {
        setEnvelope(null);
        setCapabilities(null);
        setValidation(null);
        setLoadError(null);
        // Nothing loads here, and no store transition follows: the store keeps
        // the previous document, so marking complete only opens the replacement
        // guard. Resetting the store on a null file is a separate gap.
        markLoaded(generation);
        return;
      }
      (async () => {
        try {
          const caps = await engine.capabilities();
          const [nextEnvelope, pages, report] = await Promise.all([
            engine.read(file),
            engine.render(file, RENDER_SVG),
            engine.validate(file).catch(() => null),
          ]);
          if (cancelled || generation !== loadGeneration.current) return;
          setCapabilities(caps);
          setEnvelope(nextEnvelope);
          setValidation(report);
          setLoadError(null);
          store.dispatch({ type: "load", document: file, pages });
          markLoaded(generation);
          // Once per completed load, from THIS effect only: a second effect
          // keyed on envelope/pages would re-fire after every apply and undo.
          emitReady(file);
        } catch (e) {
          if (cancelled || generation !== loadGeneration.current) return;
          // A failed load keeps the previous document, and it is the one the
          // editor still shows: refusing every replacement afterwards would
          // leave the surface stuck with no way out but a new file.
          markLoaded(generation);
          setLoadError(toEditorError(e));
          emitError(e);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [engine, file, markLoaded, store]);

    // Single fan-out point: every panel, both toolbar buttons and the
    // applyPendingOps guard read `editable`, so `readOnly` works everywhere
    // because it is applied here and nowhere else.
    const editable = !readOnly && (capabilities?.editable ?? true);
    const editableRef = useRef(editable);
    editableRef.current = editable;

    const queueImage = useCallback((op: Extract<EditOp, { kind: "insert-image" }>, asset: ImageAsset): void => {
      const snapshot = store.getState();
      if (!editable || envelope === null || snapshot.document === null || snapshot.status === "applying") return;
      if (capabilities?.imageAssets !== "v1") throw new HwpEngineError("unavailable", t("image.unsupported"));
      if (op.path !== asset.name) throw new HwpEngineError("bad_request", t("image.referenceMismatch"));
      const active = snapshot.pendingOps.flatMap(pending => {
        const stored = imageAssets.current.get(pending);
        return stored === undefined ? [] : [stored];
      });
      if (active.length + 1 > MAX_IMAGE_ASSETS || active.reduce((bytes, image) => bytes + image.data.length, asset.data.length) > MAX_IMAGE_ASSETS_TOTAL_BYTES) {
        throw new HwpEngineError("bad_request", t("image.queueLimit", { count: MAX_IMAGE_ASSETS, miB: MAX_IMAGE_ASSETS_TOTAL_BYTES / (1024 * 1024) }));
      }
      validateImageAssets([...active, asset]);
      imageAssets.current.set(op, { name: asset.name, data: asset.data.slice() });
      store.dispatch({ type: "queueOp", op });
    }, [editable, envelope, capabilities, store, t]);

    // Follow selection to the relevant tab.
    useEffect(() => {
      if (envelope === null || state.selection === null) return;
      const segment = segmentAtRef(envelope, state.selection);
      if (segment === undefined) return;
      const next: SideTab = isTableSlice(segmentText(envelope, segment)) ? "table" : "para";
      // The palette keeps its tab: the selection an insertion produces is its
      // own result, and leaving its rows behind for the tab it created is not
      // the jump the user asked for. Every other tab still follows.
      //
      // The Styles tab keeps it for the same reason: selecting a style IS the
      // gesture, and the highlight it produces would carry the user to a tab
      // that no longer lists the style they just picked.
      setTab((current) => current === "components" || current === "styles" ? current : next);
    }, [envelope, state.selection]);

    // Dirty-change callback.
    const dirty = state.pendingOps.length > 0;
    useEffect(() => {
      emitDirty(dirty);
    }, [dirty]);

    const applyPendingOps = useCallback((): Promise<void> => {
      const snapshot = store.getState();
      if (
        snapshot.document === null ||
        snapshot.pendingOps.length === 0 ||
        snapshot.status === "applying" ||
        !editable
      ) {
        return Promise.resolve();
      }
      // The staged ops describe the document in the store, which a load in
      // flight is about to replace. Starting now would edit a document the
      // host already left, and the result would land on the new one. Said out
      // loud rather than dropped: the toolbar Apply stays enabled while the
      // load runs, so a press has to answer with the reason.
      if (loadGeneration.current !== loadedGeneration.current) {
        noteRefusal(t("error.loadingReplacement"));
        return Promise.resolve();
      }
      const generation = loadGeneration.current;
      store.dispatch({ type: "applyStarted" });
      // The stack `applyStarted` staged, so a drop can tell whether this
      // attempt's transaction is still the one the store holds.
      const applyingSnapshots = store.getState().snapshots;
      /**
       * A load or a compose that moved the generation owns the document now.
       * Its paths that never dispatch `load` (a failed load, a null file, a
       * refused compose read) would otherwise leave the status at "applying"
       * forever, where the reducer refuses queue, undo and apply: the editor
       * would be locked with no way out but another successful load. When the
       * store still holds the document and the snapshot stack this attempt
       * staged, the drop is recorded against them, which unlocks the editor
       * and renders the reason. When the store has moved on, its own
       * transition owns the state and `emitChange` stays silent either way.
       */
      const dropApply = (): void => {
        const latest = store.getState();
        if (latest.document !== snapshot.document || latest.snapshots !== applyingSnapshots) return;
        store.dispatch({
          type: "applyFailed",
          error: {
            // Only a load still in flight will take this document away. One
            // that already ended without dispatching `load` never will, and
            // this line is the only thing that says why the apply vanished.
            message: loadGeneration.current === loadedGeneration.current
              ? t("error.staleApply")
              : t("error.loadingReplacement"),
          },
        });
      };
      return (async () => {
        try {
          const assets = snapshot.pendingOps.flatMap(op => {
            const asset = imageAssets.current.get(op);
            return asset === undefined ? [] : [asset];
          });
          const next = await engine.edit(snapshot.document!, snapshot.pendingOps, {
            verify: true,
            ...(assets.length ? { assets } : {}),
          });
          const [nextEnvelope, pages, report] = await Promise.all([
            engine.read(next),
            engine.render(next, RENDER_SVG),
            engine.validate(next).catch(() => null),
          ]);
          // A load or a compose that moved the generation owns the document
          // now: its own transition replaced the snapshot stack, so this
          // result is dropped whole rather than applied to the new document.
          if (generation !== loadGeneration.current) {
            dropApply();
            return;
          }
          setEnvelope(nextEnvelope);
          setValidation(report);
          store.dispatch({ type: "applySucceeded", document: next, pages });
          // The edit landed, so the previous attempt's notice ("this document
          // has no table to style") describes a state this document has left.
          // Cleared here rather than when the attempt starts: a failed apply
          // leaves the document alone, and the notice is still true of it.
          setNotice(null);
          emitChange(next);
        } catch (e) {
          // As above: a failure belongs to the document this attempt read, so
          // it is not recorded against the one a load put in its place.
          if (generation !== loadGeneration.current) {
            dropApply();
            return;
          }
          // A find that matched nothing leaves nothing applied, and the engine's
          // own line for it is Korean prose naming staged paths, so the error
          // line carries the localized sentence. The host still hears the
          // failure as it arrived — code, status and cause intact — because a
          // wrapper that drops them cannot be branched on (`onError`'s contract).
          const stored = toEditorError(e);
          store.dispatch({
            type: "applyFailed",
            error: isUnmatchedReplaceRefusal(e) ? { ...stored, message: t("error.unmatchedReplace") } : stored,
          });
          emitError(e);
        }
      })();
    }, [editable, engine, noteRefusal, store, t]);

    const replaceDocument = useCallback(
      (
        produce: (current: DocumentHandle) => Promise<DocumentHandle>,
      ): Promise<boolean> => {
        const snapshot = store.getState();
        const current = snapshot.document;
        const generation = loadGeneration.current;
        if (
          current === null ||
          !editableRef.current ||
          snapshot.status === "applying"
        ) return Promise.resolve(false);
        // The store keeps the previous document until a load resolves, so a
        // caller that produced a result from it would replace the file the
        // host has already switched to. Refused, not silently dropped: the
        // caller's result is worthless, and only the message says why. The
        // sentence goes on the notice line as well as to `onError`: a host
        // that passes no callback would otherwise see a click do nothing.
        if (generation !== loadedGeneration.current) {
          const refusal = new Error(t("error.loadingReplacement"));
          noteRefusal(refusal.message, refusal);
          return Promise.reject(refusal);
        }
        if (snapshot.pendingOps.length > 0) {
          const refusal = new Error(t("error.pendingReplacement"));
          noteRefusal(refusal.message, refusal);
          return Promise.reject(refusal);
        }
        store.dispatch({ type: "applyStarted" });
        const replacementSnapshots = store.getState().snapshots;
        return (async () => {
          try {
            const next = await produce(current);
            // A producer hands back the document it was given when the edit
            // changed nothing: there is nothing to replace, and the snapshot
            // applyStarted staged would undo the document to itself. Whatever
            // the generation says, the snapshot stack is this attempt's — a
            // load that moved the generation and then failed, or a null file,
            // dispatches nothing, so only this release ends "applying".
            if (next === current) {
              const latest = store.getState();
              if (
                latest.document === current &&
                latest.snapshots === replacementSnapshots
              ) {
                store.dispatch({ type: "applyUnchanged" });
              }
              return false;
            }
            const [nextEnvelope, pages, report] = await Promise.all([
              engine.read(next),
              engine.render(next, RENDER_SVG),
              engine.validate(next).catch(() => null),
            ]);
            const latest = store.getState();
            if (
              generation !== loadGeneration.current ||
              latest.document !== current ||
              latest.status !== "applying" ||
              latest.snapshots !== replacementSnapshots ||
              !editableRef.current ||
              latest.pendingOps.length > 0
            ) {
              // Queueing an op changes the status to dirty but still leaves
              // this replacement's snapshot staged. A load/undo replaces the
              // stack, so it owns its own transition instead.
              if (latest.document === current && latest.snapshots === replacementSnapshots) {
                const refusal = !editableRef.current
                  ? t("error.readOnlyReplacement")
                  : latest.pendingOps.length > 0
                    ? t("error.pendingReplacement")
                    : t("error.staleReplacement");
                throw new Error(refusal);
              }
              return false;
            }
            setEnvelope(nextEnvelope);
            setValidation(report);
            store.dispatch({ type: "applySucceeded", document: next, pages });
            // Same rule as an apply: the replacement landed, so a notice about
            // the document it replaced describes a state that no longer holds.
            // A caller that has its own sentence for the new document sets it
            // after this resolves.
            setNotice(null);
            emitChange(next);
            return true;
          } catch (e) {
            const latest = store.getState();
            if (
              latest.document === current &&
              latest.snapshots === replacementSnapshots
            ) {
              store.dispatch({ type: "applyFailed", error: toEditorError(e) });
              emitError(e);
              throw e;
            }
            return false;
          }
        })();
      },
      [emitChange, emitError, engine, noteRefusal, store, t],
    );

    /** Ids of an insertion belong to one document; a new file retires them. */
    useEffect(() => {
      setPendingInserted([]);
      insertedTriedFor.current = null;
    }, [file]);

    /**
     * Insert one component beside the selected paragraph.
     *
     * The values the palette shows are substituted here, once, so a
     * `{{param}}` never reaches the engine, and the styles sent beside the
     * blocks are the component's own plus every profile style it references
     * (resolved by the same code compose uses): `insert_blocks` refuses a block
     * naming a style neither it nor the target defines, and a target document
     * need not carry 바탕글 or 개요 2 for a component to land in it.
     *
     * What the insertion created is read from `edit-report-v1` alone and
     * becomes the selection; no row list survives it, because those ids
     * describe the document as it was written and go stale on the next edit.
     */
    const insertComponent = useCallback(
      (component: Component, values: Record<string, string>, position: InsertPosition): void => {
        const snapshot = store.getState();
        if (!editableRef.current || snapshot.document === null || envelope === null) return;
        // A new attempt retires the previous attempt's notice.
        setNotice(null);
        // An insertion replaces the document, so a queued edit would be lost:
        // the replacement is refused, and the refusal has to be visible rather
        // than reaching only a host that may not be listening. The palette is
        // disabled for the same reason.
        if (snapshot.pendingOps.length > 0) {
          noteRefusal(t("components.pendingEdits"));
          return;
        }
        // Checked here rather than left to `replaceDocument`: that refusal
        // reaches only a host that listens on `onError`, and a palette click
        // that does nothing is the bug this notice exists to prevent.
        if (loadGeneration.current !== loadedGeneration.current) {
          noteRefusal(t("error.loadingReplacement"));
          return;
        }
        const segment = snapshot.selection === null ? undefined : segmentAtRef(envelope, snapshot.selection);
        // The selection, not just its primary: a run of inserted paragraphs
        // anchors at its far edge, so a second insertion does not split it.
        const covered = selectionParagraphs(envelope, snapshot);
        const address = segment === undefined ? null : insertAnchor(covered, position);
        if (address === null) return;
        // Before a section's first paragraph the engine refuses the insertion
        // (it holds the section definition); the palette disables it, and this
        // keeps the rule true for any other caller of this callback.
        if (position === "before" && covered[0] !== undefined && isSectionDefinitionParagraph(covered[0])) return;
        let blocks: Component["blocks"];
        let styles: NonNullable<Extract<AddressedEditOp, { kind: "insert-blocks" }>["styles"]>;
        try {
          const filled = substituteParams(component, values, component.name);
          blocks = filled.blocks;
          styles = componentStyleMap([filled]);
        } catch (error) {
          // A refused param, style reference or redefinition is a sentence for
          // the user, in their locale, naming the component and the field.
          // Every refusal is shown, not only handed to the host: a click that
          // visibly does nothing is the bug this line exists to prevent.
          const shown = toError(componentFailure(error, t));
          noteNotice(shown.message, shown);
          return;
        }
        // Three refusals are certain before the document is touched, so they
        // are answered here rather than by a failed round trip; the palette
        // disables the same rows with the same sentences.
        const preflight = insertionPreflight(blocks, snapshot.document.name, t);
        if (preflight !== "") {
          noteRefusal(preflight);
          return;
        }
        void (async () => {
          let report: EditReport | undefined;
          let applied = false;
          try {
            applied = await replaceDocument(async (current) => {
              try {
                const result = await engine.edit(
                  current,
                  [{
                    kind: "insert-blocks",
                    address,
                    position,
                    blocks,
                    ...(Object.keys(styles).length === 0 ? {} : { styles }),
                  }],
                  { report: true },
                );
                report = result.report;
                return { name: result.name, data: result.data };
              } catch (error) {
                // The width refusal becomes a localized sentence naming both
                // widths before replaceDocument reports it, so one error is
                // emitted rather than two.
                throw toError(insertionFailure(error, blocks, t));
              }
            });
          } catch {
            return;
          }
          // A replacement the editor discarded (a load or an undo landed
          // first) created nothing this state may select.
          if (!applied) return;
          // The report lists every op it ran, in request order, spelled with
          // the engine's own name (`insert_blocks`, not the client's kind), so
          // the entry this insertion owns is named rather than assumed first.
          const outcome = report?.ops.find((entry) => entry.op === "insert_blocks");
          if (outcome === undefined) {
            // The document was published, so this is a notice rather than a
            // failure: the editor shows it and the host still hears it.
            noteRefusal(t("components.noReport"));
            return;
          }
          if (outcome.status !== "applied") {
            // The report says the op did not apply, so the engine's own
            // content-free reason is the cause: framed like any other refusal
            // rather than left as a click that changed nothing.
            noteRefusal(t("components.insertionRefused", { reason: outcome.reason ?? "" }));
            return;
          }
          // A capped list means the ids that would name the rest are simply
          // absent; selecting a partial run would reorder half a component.
          if (outcome.changed_total !== undefined) {
            noteRefusal(t("components.reportTruncated"));
            return;
          }
          let ids: string[];
          try {
            ids = insertedParagraphIds(outcome);
          } catch (error) {
            // A report that lists more paragraphs than it touched is not this
            // contract: say so where the user can read it.
            noteNotice(toError(error).message, error);
            return;
          }
          setPendingInserted(ids);
        })();
      },
      [emitError, engine, envelope, noteRefusal, replaceDocument, store, t],
    );

    const selectedTargets =
      envelope === null || state.selection === null
        ? undefined
        : (() => {
            const segment = segmentAtRef(envelope, state.selection);
            return segment === undefined ? undefined : resolveSelection(envelope, segment);
          })();
    /** The paragraphs the palette would insert beside, in document order. */
    const componentAnchor =
      envelope === null || state.selection === null ? [] : selectionParagraphs(envelope, state);
    // Whether the palette can act at all: any position needs an anchor, and the
    // panel's own before/after choice decides which edge of the selection it is.
    const selectedAddress = insertAnchor(componentAnchor, "after");
    // Before a section's definition paragraph the engine refuses an insertion
    // ("구역 정의 문단 앞에는 삽입할 수 없습니다"), so that one position is off
    // while "after" still works: the palette names the reason rather than
    // disabling both.
    const beforeDisabledReason =
      componentAnchor[0] !== undefined && isSectionDefinitionParagraph(componentAnchor[0])
        ? t("components.positionBeforeLocked")
        : "";
    const componentDisabled =
      componentsSupportReason(capabilities, t) ||
      (state.pendingOps.length > 0 ? t("components.pendingEdits") : "") ||
      (state.selection === null
        ? t("components.noSelection")
        : selectedAddress !== null
          ? ""
          : selectedTargets?.refusal === "cell"
            ? t("segment.cellSelectionRefused")
            : selectedTargets?.refusal === "table"
              ? t("segment.tableSelectionRefused")
              : selectedTargets?.refusal === "container"
                ? t("segment.containerSelectionRefused")
                : t("components.noAddress"));
    /**
     * Why the palette refuses one component's insertion before sending it, or
     * "": the rows it refuses are disabled with that sentence, so a component
     * the engine would certainly reject does not cost a round trip.
     */
    const componentRefusal = useCallback(
      (component: Component): string =>
        insertionPreflight(component.blocks, state.document?.name ?? "", t),
      [state.document, t],
    );

    const revert = useCallback((): Promise<void> => {
      const snapshot = store.getState();
      const previous = snapshot.snapshots[snapshot.snapshots.length - 1];
      if (snapshot.status === "applying" || previous === undefined) return Promise.resolve();
      return (async () => {
        try {
          // BUG-02: the badge described the document being undone away, so
          // re-validate the restored one. Same shape as applyPendingOps; a
          // validate failure leaves the previous badge rather than clearing it.
          const [nextEnvelope, pages, report] = await Promise.all([
            engine.read(previous),
            engine.render(previous, RENDER_SVG),
            engine.validate(previous).catch(() => null),
          ]);
          // Dispatch only after the engine succeeds: popping the snapshot
          // first and failing mid-undo left the canvas showing the pre-undo
          // envelope while the store claimed the previous document. A second
          // revert may have consumed this snapshot while we awaited; if so,
          // leave the newer transition alone.
          const now = store.getState();
          if (now.snapshots[now.snapshots.length - 1] !== previous) return;
          store.dispatch({ type: "undo" });
          setEnvelope(nextEnvelope);
          if (report !== null) setValidation(report);
          store.dispatch({ type: "setPages", pages });
          // Undo moved to another document, so the previous attempt's notice
          // ("this document has no table to style") describes a state that no
          // longer holds. Cleared after the undo lands: a failed undo leaves
          // the document where it was, and the notice is still true of it.
          setNotice(null);
          emitChange(previous);
        } catch (e) {
          // The store was never touched, so store and canvas stay consistent;
          // without this destination the rejection was unhandled.
          setLoadError(toEditorError(e));
          emitError(e);
        }
      })();
    }, [engine, store]);

    const refresh = useCallback(async () => {
      const snapshot = store.getState();
      if (snapshot.document === null) return;
      try {
        const [nextEnvelope, pages, report] = await Promise.all([
          engine.read(snapshot.document),
          engine.render(snapshot.document, RENDER_SVG),
          engine.validate(snapshot.document).catch(() => null),
        ]);
        setEnvelope(nextEnvelope);
        setValidation(report);
        store.dispatch({ type: "setPages", pages });
      } catch (e) {
        // A no-op resolves quietly (above); a FAILURE must be observable to
        // the awaiting host, so surface it three ways and reject.
        setLoadError(toEditorError(e));
        emitError(e);
        throw e;
      }
    }, [engine, store]);

    const openCompose = useCallback(() => setComposing(true), []);
    const loadEpoch = useCallback(() => loadGeneration.current, []);

    /**
     * The sentence a failed table read put on the notice line, captured as it
     * was recorded: the notice holds text, so the read that finally succeeds
     * compares against the words that went up rather than the locale's current
     * ones, and a locale switch between the two reads still retires it.
     */
    const stylesFailureSentence = useRef("");
    /**
     * Read the named styles once per document. Every applied edit, undo and
     * new file replaces `state.document`, which is the only signal that makes
     * the table stale; a host without `styles` (or an engine below 1.4.0,
     * which is the same advertisement) keeps it null and the tab says why.
     */
    useEffect(() => {
      const document = state.document;
      if (document === null || capabilities?.styles !== "v1" || engine.styles === undefined) {
        setStylesLoad(null);
        return;
      }
      let cancelled = false;
      engine.styles(document).then(
        (table) => {
          if (cancelled) return;
          setStylesLoad({ document, table, failed: false });
          // The read that works ends the condition the failure described.
          setNotice((current) => (current === stylesFailureSentence.current ? null : current));
        },
        (error: unknown) => {
          if (cancelled) return;
          // The document stays editable: what failed is the table the Styles
          // tab lists, so the tab loses its rows and the notice says why. The
          // failure is recorded against its document, so the tab can name the
          // cause rather than looking like a read that never finished.
          setStylesLoad({ document, table: null, failed: true });
          const sentence = t("styles.loadFailed");
          stylesFailureSentence.current = sentence;
          noteNotice(sentence, error);
        },
      );
      return () => { cancelled = true; };
      // `t` is deliberately absent: a locale change (or a host that rebuilds an
      // inline `messages` object on every render) would otherwise re-read the
      // table, and with it the rows a panel is holding. The one sentence this
      // effect writes is captured in `stylesFailureSentence` as it is recorded.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capabilities?.styles, engine, noteNotice, state.document]);

    useImperativeHandle(
      ref,
      () => ({ apply: applyPendingOps, revert, refresh, openCompose }),
      [applyPendingOps, revert, refresh, openCompose],
    );

    const contextValue: HwpEditorContextValue = useMemo(
      () => ({
        engine,
        store,
        state,
        envelope,
        capabilities,
        editable,
        validation,
        applyPendingOps,
        replaceDocument,
        queueImage,
        refresh,
        styles,
        stylesStatus,
        noteNotice,
        openCompose,
        loadEpoch,
        t,
        // Moves when the editor takes on a new document (a load or a compose)
        // and stays put across an applied edit and an undo, so a panel can
        // retire a choice made in the previous document without retiring it
        // every time the document is edited.
        documentOrigin,
        // Always defined now, and stable: a widening, since every consumer
        // already calls it as `onError?.(e)` and it no-ops when the host
        // supplied no callback. The payload is unchanged.
        onError: emitError,
      }),
      [
        engine,
        store,
        state,
        envelope,
        capabilities,
        editable,
        validation,
        applyPendingOps,
        replaceDocument,
        queueImage,
        refresh,
        styles,
        stylesStatus,
        noteNotice,
        openCompose,
        loadEpoch,
        t,
        documentOrigin,
      ],
    );

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "Escape") {
        // With the compose dialog open, Escape belongs to the dialog (it
        // closes it); one press must not also drop the page selection.
        if (composing) return;
        store.dispatch({ type: "select", selection: null });
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        // With the compose dialog open the chord belongs to nobody: focus is
        // still on the toolbar trigger when it opens, so the dialog cannot
        // stop a press that never reaches it, and an apply here would rewrite
        // the document the compose is about to replace. Refused at the root,
        // like Escape above; the dialog's own buttons remain the way through.
        if (composing) return;
        e.preventDefault();
        void applyPendingOps();
      }
    };

    const rootClass =
      "hwped hwped-root" + (className !== undefined ? ` ${className}` : "");

    /**
     * A queued style op addresses a style this document defines by its header
     * id: a styles-v1 name can be empty, and two rows can share one, while the
     * id is the row. The pending list resolves it back for reading, and a name
     * this batch creates (which has no id yet) prints as written.
     */
    const styleLabel = (ref: string | number): string =>
      typeof ref === "string"
        ? ref
        : styles?.styles.find((row) => row.id === ref)?.name ?? String(ref);

    return (
      <HwpEditorContext.Provider value={contextValue}>
        <div
          className={rootClass}
          style={style}
          onKeyDown={onKeyDown}
          data-status={state.status}
          // No `dir`: both supported locales are ltr.
          lang={locale}
        >
          <header
            className="hwped-toolbar"
            role="toolbar"
            aria-label={t("toolbar.toolsAria")}
          >
            <span className="hwped-title">
              {state.document?.name ?? "hwp-editor"}
            </span>
            {!editable && (
              <span
                className="hwped-notice"
                role="note"
                // The full engine prose stays reachable on hover once the
                // toolbar clamp truncates a long reason (UI-DEBT-01).
                {...(capabilities?.reason !== undefined
                  ? { title: capabilities.reason }
                  : {})}
              >
                {t("toolbar.readOnly")}
                {/* Suffix only when the ENGINE refused: a host-forced
                    read-only has no reason, and inventing one would claim the
                    document is protected when it isn't. The engine's reason is
                    its own prose, shown verbatim under either locale. */}
                {capabilities?.editable === false &&
                  (capabilities.reason !== undefined
                    ? `: ${capabilities.reason}`
                    : ` (${t("error.kind.protected")})`)}
              </span>
            )}
            <span className="hwped-spacer" />
            {validation !== null && (
              <span
                className={
                  validation.valid
                    ? "hwped-badge hwped-badge-ok"
                    : "hwped-badge hwped-badge-err"
                }
                role="status"
                aria-label={t("validation.aria")}
              >
                {validation.valid
                  ? t("validation.valid")
                  : t("validation.errors", { count: validation.errors.length })}
              </span>
            )}
            <span
              className="hwped-count"
              aria-label={t("toolbar.pendingEdits", {
                count: state.pendingOps.length,
              })}
            >
              {t("toolbar.pendingEdits", { count: state.pendingOps.length })}
            </span>
            <button
              type="button"
              className="hwped-btn"
              onClick={() => void revert()}
              disabled={state.snapshots.length === 0 || state.status === "applying"}
            >
              {t("toolbar.revert")}
            </button>
            <button
              type="button"
              className="hwped-btn hwped-btn-primary"
              onClick={() => void applyPendingOps()}
              disabled={!dirty || !editable || state.status === "applying"}
            >
              {state.status === "applying"
                ? t("toolbar.applying")
                : t("toolbar.applyWithCount", {
                    count: state.pendingOps.length,
                  })}
            </button>
            <button
              type="button"
              className="hwped-btn"
              onClick={() => setComposing(true)}
              disabled={!editable || state.status === "applying"}
            >
              {t("toolbar.newDocument")}
            </button>
          </header>

          {state.pendingOps.length > 0 && <>
            <button type="button" className="hwped-btn" disabled={state.status === "applying"}
              onClick={() => store.dispatch({ type: "clearOps" })}>{t("toolbar.clearPending")}</button>
            <ol className="hwped-pending-list" aria-label={t("toolbar.pendingList")}>
              {state.pendingOps.map((op, index) => (
                <li key={index}>
                  {op.kind}: {"address" in op
                    ? JSON.stringify(op.address)
                    : "find" in op ? op.find : "anchor" in op ? op.anchor : "key" in op ? op.key
                      // A named-style op names the style it rewrites; without
                      // this branch an update would read "update-style:
                      // update-style", which says nothing the kind already did.
                      // It addresses a style this document defines by its own
                      // header id (a styles-v1 name can be empty or shared),
                      // so the row is resolved back for reading.
                      : "style" in op ? styleLabel(op.style) : "name" in op ? op.name : op.kind}
                  {" "}<button type="button" className="hwped-btn" disabled={state.status === "applying"}
                    onClick={() => store.dispatch({ type: "dequeueOp", index })}>{t("toolbar.removePending", { index: index + 1 })}</button>
                </li>
              ))}
            </ol>
          </>}

          {state.status === "error" && state.error !== null && (
            <ErrorLine prefix={t("error.prefix.apply")} {...state.error} />
          )}
          {loadError !== null && (
            <ErrorLine prefix={t("error.prefix.load")} {...loadError} />
          )}
          {notice !== null && (
            <p className="hwped-hint" role="status">{notice}</p>
          )}

          <div className="hwped-main">
            {state.document === null ? (
              <div
                className="hwped-canvas"
                role="main"
                aria-label={t("canvas.aria")}
              >
                <div className="hwped-empty">
                  <p>{t("canvas.empty")}</p>
                  <button
                    type="button"
                    className="hwped-btn hwped-btn-primary"
                    onClick={() => setComposing(true)}
                    disabled={!editable || state.status === "applying"}
                  >
                    {t("canvas.createCta")}
                  </button>
                </div>
              </div>
            ) : (
              <PageCanvas />
            )}
            <aside className="hwped-side" aria-label={t("side.panelAria")} aria-busy={state.status === "applying"}>
              <div className="hwped-tabs" role="tablist">
                {(
                  [
                    ["para", t("tabs.para")],
                    ["styles", t("tabs.styles")],
                    ["table", t("tabs.table")],
                    ["fields", t("tabs.fields")],
                    ["templates", t("tabs.templates")],
                    ["components", t("tabs.components")],
                    ["lint", t("tabs.lint")],
                    ["document", t("tabs.document")],
                    ["images", t("tabs.images")],
                  ] as [SideTab, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    className={
                      "hwped-tab" + (tab === value ? " hwped-tab-active" : "")
                    }
                    onClick={() => setTab(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {state.status === "applying" && <p className="hwped-hint" role="status">{t("toolbar.applying")}</p>}
              {tab === "para" && <SegmentInspector />}
              {tab === "styles" && <StylesPanel />}
              {tab === "table" && <TableGrid />}
              {tab === "fields" && <FieldsPanel />}
              {tab === "templates" && <TemplatePanel />}
              {tab === "components" && (
                <ComponentsPanel
                  components={catalogue}
                  disabledReason={componentDisabled}
                  beforeDisabledReason={beforeDisabledReason}
                  refusalFor={componentRefusal}
                  busy={!editable || state.status === "applying"}
                  onInsert={insertComponent}
                />
              )}
              {tab === "lint" && <LintPanel />}
              {tab === "document" && <DocumentPanel />}
              {tab === "images" && <ImagePanel />}
            </aside>
          </div>

          {composing && (
            <ComposePanel
              components={catalogue}
              canCreate={editable && state.status !== "applying"}
              onClose={() => setComposing(false)}
              onComposed={(document) => {
                if (!editableRef.current) return;
                setComposing(false);
                const generation = ++loadGeneration.current;
                // A composed document is a new document: the host's file did
                // not change, so nothing else would tell a panel so.
                setDocumentOrigin((count) => count + 1);
                // Nor would anything else retire the previous document's
                // notice: the load effect cannot run when the file is the same.
                setNotice(null);
                emitChange(document);
                // The host passes the composed document back via `file`; load
                // it directly so the flow also works when the host doesn't.
                void (async () => {
                  try {
                    const [nextEnvelope, pages, caps, report] = await Promise.all([
                      engine.read(document),
                      engine.render(document, RENDER_SVG),
                      engine.capabilities(),
                      engine.validate(document).catch(() => null),
                    ]);
                    if (generation !== loadGeneration.current) return;
                    // The generation still matches, so no load is in flight:
                    // the guard opens here even when the surface went
                    // read-only during the read, which is a refusal to show
                    // the file and not a load that will finish the job.
                    markLoaded(generation);
                    if (!editableRef.current) return;
                    setCapabilities(caps);
                    setValidation(report);
                    setLoadError(null);
                    setEnvelope(nextEnvelope);
                    store.dispatch({ type: "load", document, pages });
                  } catch (e) {
                    // Covers the render AFTER a successful compose; the
                    // compose call itself fails inside ComposePanel.
                    if (generation !== loadGeneration.current) return;
                    // The composed file reaches the editor through `file`
                    // anyway, so a failed read here must not leave every
                    // replacement refused as if a load were still running.
                    markLoaded(generation);
                    setLoadError(toEditorError(e));
                    emitError(e);
                  }
                })();
              }}
            />
          )}
        </div>
      </HwpEditorContext.Provider>
    );
  },
);
