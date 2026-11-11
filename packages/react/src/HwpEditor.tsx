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
  ValidationReport,
} from "@hwp-editor/core";
import { createStore, insertedParagraphIds, segmentAtRef, segmentRef, validateImageAssets, HwpEngineError, MAX_IMAGE_ASSETS, MAX_IMAGE_ASSETS_TOTAL_BYTES, STARTER_COMPONENTS } from "@hwp-editor/core";
import type { EditorError, EditorStore } from "@hwp-editor/core";
import { HwpEditorContext } from "./context.js";
import type { HwpEditorContextValue } from "./context.js";
import { PageCanvas } from "./PageCanvas.js";
import { SegmentInspector } from "./SegmentInspector.js";
import { TableGrid } from "./TableGrid.js";
import { FieldsPanel } from "./FieldsPanel.js";
import { TemplatePanel } from "./TemplatePanel.js";
import { LintPanel } from "./LintPanel.js";
import { DocumentPanel } from "./DocumentPanel.js";
import { ImagePanel } from "./ImagePanel.js";
import { ComposePanel } from "./ComposePanel.js";
import { ComponentsPanel } from "./ComponentsPanel.js";
import { componentsSupportReason } from "./ComponentsPanel.js";
import type { InsertedComponent } from "./ComponentsPanel.js";
import { isTableSlice } from "./tables.js";
import { ErrorLine } from "./ErrorLine.js";
import { toEditorError } from "./errors.js";
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

type SideTab = "para" | "table" | "fields" | "templates" | "components" | "lint" | "document" | "images";

/**
 * Where a component may be inserted: the selected paragraph's own id.
 *
 * A selection can be a run or a paragraph nested in a table cell, and
 * `insert_blocks` takes a paragraph address. A run resolves to the paragraph
 * that owns it; a nested paragraph keeps its id, whose path carries the whole
 * nesting chain, rather than collapsing to a top-level index that would put
 * the component beside the table instead of in the cell.
 */
function insertAddress(envelope: CatEnvelope, segment: Segment | undefined): ParagraphAddress | null {
  if (segment === undefined) return null;
  if (segment.kind === "para" && segment.id !== undefined) return { id: segment.id };
  // A run's id ends with its run index, so the paragraph that owns it is the
  // segment whose nesting path is the run's minus that last index.
  const indices = segment.indices;
  if (indices === undefined) return null;
  const owner = envelope.segments.find((candidate) =>
    candidate.kind === "para" &&
    candidate.section === segment.section &&
    candidate.indices !== undefined &&
    candidate.indices.length === indices.length - 1 &&
    candidate.indices.every((index, at) => index === indices[at]));
  return owner?.id === undefined ? null : { id: owner.id };
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
    const loadGeneration = useRef(0);
    const [tab, setTab] = useState<SideTab>("para");
    const [composing, setComposing] = useState(false);
    /**
     * Rows for what an insertion reported in THIS document state. The ids come
     * from `edit-report-v1` alone: the engine assigns them against the
     * document it just wrote, so a new load invalidates every one of them.
     */
    const [inserted, setInserted] = useState<InsertedComponent[]>([]);
    /**
     * Ids one insertion reported, held until the re-read envelope carries them.
     * The paragraphs do not exist in the envelope the op was sent with, so the
     * selection is built from the envelope that reads them back, in real paths
     * rather than guessed ones.
     */
    const [pendingInserted, setPendingInserted] = useState<string[]>([]);
    const imageAssets = useRef(new Map<EditOp, ImageAsset>());
    useEffect(() => {
      const active = new Set(state.pendingOps);
      for (const op of imageAssets.current.keys()) if (!active.has(op)) imageAssets.current.delete(op);
    }, [state.pendingOps]);

    // Select the paragraphs an insertion created. `insert_blocks` names them
    // only in the edit report, so a ref for one can be built only against the
    // envelope that reads the new document back, whose paths are the engine's.
    useEffect(() => {
      if (pendingInserted.length === 0 || envelope === null) return;
      const paragraphs = pendingInserted.flatMap((id) => {
        const segment = segmentAtRef(envelope, { id, section: 0, para: 0 });
        return segment === undefined || segment.kind !== "para" ? [] : [segment];
      });
      if (paragraphs.length === 0) return;
      setPendingInserted([]);
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
      let cancelled = false;
      if (file === null) {
        setEnvelope(null);
        setCapabilities(null);
        setValidation(null);
        setLoadError(null);
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
          // Once per completed load, from THIS effect only: a second effect
          // keyed on envelope/pages would re-fire after every apply and undo.
          emitReady(file);
        } catch (e) {
          if (cancelled || generation !== loadGeneration.current) return;
          setLoadError(toEditorError(e));
          emitError(e);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [engine, file, store]);

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
      setTab((current) => current === "components" ? current : next);
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
      store.dispatch({ type: "applyStarted" });
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
          setEnvelope(nextEnvelope);
          setValidation(report);
          store.dispatch({ type: "applySucceeded", document: next, pages });
          emitChange(next);
        } catch (e) {
          store.dispatch({ type: "applyFailed", error: toEditorError(e) });
          emitError(e);
        }
      })();
    }, [editable, engine, store]);

    const replaceDocument = useCallback(
      (
        produce: (current: DocumentHandle) => Promise<DocumentHandle>,
      ): Promise<void> => {
        const snapshot = store.getState();
        const current = snapshot.document;
        const generation = loadGeneration.current;
        if (
          current === null ||
          !editableRef.current ||
          snapshot.status === "applying"
        ) return Promise.resolve();
        if (snapshot.pendingOps.length > 0) {
          const refusal = new Error(t("error.pendingReplacement"));
          emitError(refusal);
          return Promise.reject(refusal);
        }
        store.dispatch({ type: "applyStarted" });
        const replacementSnapshots = store.getState().snapshots;
        return (async () => {
          try {
            const next = await produce(current);
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
              return;
            }
            setEnvelope(nextEnvelope);
            setValidation(report);
            store.dispatch({ type: "applySucceeded", document: next, pages });
            emitChange(next);
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
            return;
          }
        })();
      },
      [emitChange, emitError, engine, store, t],
    );

    // The rows are keyed by ids that only describe the current document state.
    useEffect(() => {
      setInserted([]);
    }, [file]);

    /**
     * The engine reports the paragraphs an insertion created; only their ids
     * can address them afterwards. A row whose id the engine no longer knows
     * is refused by its drift check, never applied to a different paragraph.
     */
    const insertComponent = useCallback(
      (component: Component): void => {
        const snapshot = store.getState();
        if (!editableRef.current || snapshot.document === null || envelope === null) return;
        const address = insertAddress(
          envelope,
          snapshot.selection === null ? undefined : segmentAtRef(envelope, snapshot.selection),
        );
        if (address === null) return;
        let report: EditReport | undefined;
        void (async () => {
          try {
            await replaceDocument(async (current) => {
              const result = await engine.edit(
                current,
                [{
                  kind: "insert-blocks",
                  address,
                  position: "after",
                  blocks: component.blocks,
                  ...(component.styles === undefined ? {} : { styles: component.styles }),
                }],
                { report: true },
              );
              report = result.report;
              return { name: result.name, data: result.data };
            });
          } catch (error) {
            emitError(error);
            return;
          }
          const outcome = report?.ops[0];
          if (outcome === undefined) {
            emitError(new Error(t("components.noReport")));
            return;
          }
          if (outcome.status !== "applied") return;
          const ids = insertedParagraphIds(outcome);
          setInserted((previous) => [...previous, ...ids.map((id) => ({ id, name: component.name }))]);
          setPendingInserted(ids);
        })();
      },
      [emitError, engine, envelope, replaceDocument, store, t],
    );

    const moveInserted = useCallback(
      (id: string, direction: -1 | 1): void => {
        const at = inserted.findIndex((row) => row.id === id);
        const neighbour = inserted[at + direction];
        if (at < 0 || neighbour === undefined) return;
        let report: EditReport | undefined;
        void (async () => {
          try {
            await replaceDocument(async (current) => {
              const result = await engine.edit(
                current,
                [{
                  kind: "move-para",
                  address: { id },
                  to: { address: { id: neighbour.id }, position: direction === -1 ? "before" : "after" },
                }],
                { report: true },
              );
              report = result.report;
              return { name: result.name, data: result.data };
            });
          } catch (error) {
            emitError(error);
            return;
          }
          // A move re-keys its own target; the report lists that pair and no
          // other, so the rows are re-keyed by what it did report and left
          // alone otherwise.
          const pairs = report?.ops[0]?.changed ?? [];
          setInserted((previous) => {
            const rekeyed = previous.map((row) => {
              const pair = pairs.find((entry) => entry.before === row.id);
              return pair === undefined || pair.after === null ? row : { ...row, id: pair.after };
            });
            const next = [...rekeyed];
            next[at] = rekeyed[at + direction]!;
            next[at + direction] = rekeyed[at]!;
            return next;
          });
        })();
      },
      [emitError, engine, inserted, replaceDocument],
    );

    const removeInserted = useCallback(
      (id: string): void => {
        void (async () => {
          try {
            await replaceDocument(async (current) => {
              const result = await engine.edit(current, [{ kind: "delete-para", address: { id } }], { report: true });
              return { name: result.name, data: result.data };
            });
          } catch (error) {
            emitError(error);
            return;
          }
          setInserted((previous) => previous.filter((row) => row.id !== id));
        })();
      },
      [emitError, engine, replaceDocument],
    );

    const selectedAddress =
      envelope === null || state.selection === null
        ? null
        : insertAddress(envelope, segmentAtRef(envelope, state.selection));
    const componentDisabled =
      componentsSupportReason(capabilities, t) ||
      (state.selection === null
        ? t("components.noSelection")
        : selectedAddress === null
          ? t("components.noAddress")
          : "");

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
        openCompose,
        t,
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
        openCompose,
        t,
      ],
    );

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "Escape") {
        // With the compose dialog open, Escape belongs to the dialog (it
        // closes it); one press must not also drop the page selection.
        if (composing) return;
        store.dispatch({ type: "select", selection: null });
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void applyPendingOps();
      }
    };

    const rootClass =
      "hwped hwped-root" + (className !== undefined ? ` ${className}` : "");

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
                    : "find" in op ? op.find : "anchor" in op ? op.anchor : "key" in op ? op.key : "name" in op ? op.name : op.kind}
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
              {tab === "table" && <TableGrid />}
              {tab === "fields" && <FieldsPanel />}
              {tab === "templates" && <TemplatePanel />}
              {tab === "components" && (
                <ComponentsPanel
                  components={catalogue}
                  inserted={inserted}
                  disabledReason={componentDisabled}
                  busy={!editable || state.status === "applying"}
                  onInsert={insertComponent}
                  onMove={moveInserted}
                  onRemove={removeInserted}
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
                    if (generation !== loadGeneration.current || !editableRef.current) return;
                    setCapabilities(caps);
                    setValidation(report);
                    setLoadError(null);
                    setEnvelope(nextEnvelope);
                    store.dispatch({ type: "load", document, pages });
                  } catch (e) {
                    // Covers the render AFTER a successful compose; the
                    // compose call itself fails inside ComposePanel.
                    if (generation !== loadGeneration.current) return;
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
