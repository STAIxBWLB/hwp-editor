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
import type { AddressedEditOp } from "@hwp-editor/core";
import { compareSegments, componentStyleMap, createStore, insertedParagraphIds, resolveSelection, segmentAtRef, segmentRef, substituteParams, validateImageAssets, HwpEngineError, MAX_IMAGE_ASSETS, MAX_IMAGE_ASSETS_TOTAL_BYTES, STARTER_COMPONENTS } from "@hwp-editor/core";
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
import type { InsertPosition } from "./ComponentsPanel.js";
import { componentFailure, insertionFailure } from "./components-support.js";
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
 * Where a component goes: the paragraph the same selection resolves to for an
 * edit, never a guess about the segment's kind.
 *
 * `resolveSelection` is what every other addressed control uses, so a run
 * resolves to the paragraph that owns it and a table, image, field or bookmark
 * resolves to nothing with a reason. A cell resolves to its own paragraphs,
 * and the insertion position picks the edge of that run: "after" addresses the
 * cell's last paragraph and "before" its first, so a box inserted before a
 * cell's text does not land between the cell's own paragraphs. A cell with no
 * paragraph is refused rather than walked up to the table's host paragraph,
 * which would put the component beside the table.
 */
function insertAnchor(
  envelope: CatEnvelope,
  segment: Segment,
  position: InsertPosition,
): ParagraphAddress | null {
  const targets = resolveSelection(envelope, segment);
  if (targets.paragraph !== undefined) {
    return targets.paragraph.id === undefined ? null : { id: targets.paragraph.id };
  }
  const ordered = [...targets.paragraphs].sort(compareSegments);
  const paragraph = position === "before" ? ordered[0] : ordered[ordered.length - 1];
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
     * A notice about an operation that succeeded in the document but could not
     * finish its follow-up — an insertion whose report names no usable ids, so
     * nothing can be selected. Not a failure, so it does not take the error
     * line; it is shown here and still reaches the host through `onError`.
     */
    const [notice, setNotice] = useState<string | null>(null);
    const loadGeneration = useRef(0);
    const [tab, setTab] = useState<SideTab>("para");
    const [composing, setComposing] = useState(false);
    /**
     * Ids one insertion reported, held until the re-read envelope carries them.
     * The paragraphs do not exist in the envelope the op was sent with, so the
     * selection is built from the envelope that reads them back, in real paths
     * rather than guessed ones. They are the only record of an insertion: a
     * row list would keep ids that describe the document as it was written.
     */
    const [pendingInserted, setPendingInserted] = useState<string[]>([]);
    /** Show a post-success notice and hand the same text to the host. */
    const noteInsertion = useCallback((text: string): void => {
      setNotice(text);
      emitError(new Error(text));
    }, [emitError]);
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
      ): Promise<boolean> => {
        const snapshot = store.getState();
        const current = snapshot.document;
        const generation = loadGeneration.current;
        if (
          current === null ||
          !editableRef.current ||
          snapshot.status === "applying"
        ) return Promise.resolve(false);
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
              return false;
            }
            setEnvelope(nextEnvelope);
            setValidation(report);
            store.dispatch({ type: "applySucceeded", document: next, pages });
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
      [emitChange, emitError, engine, store, t],
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
        const segment = snapshot.selection === null ? undefined : segmentAtRef(envelope, snapshot.selection);
        const address = segment === undefined ? null : insertAnchor(envelope, segment, position);
        if (address === null) return;
        let blocks: Component["blocks"];
        let styles: NonNullable<Extract<AddressedEditOp, { kind: "insert-blocks" }>["styles"]>;
        try {
          const filled = substituteParams(component, values, component.name);
          blocks = filled.blocks;
          styles = componentStyleMap([filled]);
        } catch (error) {
          // A refused param, style reference or redefinition is a sentence for
          // the user, in their locale, naming the component and the field.
          emitError(toError(componentFailure(error, t)));
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
            noteInsertion(t("components.noReport"));
            return;
          }
          if (outcome.status !== "applied") return;
          // A capped list means the ids that would name the rest are simply
          // absent; selecting a partial run would reorder half a component.
          if (outcome.changed_total !== undefined) {
            noteInsertion(t("components.reportTruncated"));
            return;
          }
          let ids: string[];
          try {
            ids = insertedParagraphIds(outcome);
          } catch (error) {
            emitError(toError(error));
            return;
          }
          setPendingInserted(ids);
        })();
      },
      [emitError, engine, envelope, noteInsertion, replaceDocument, store, t],
    );

    const selectedTargets =
      envelope === null || state.selection === null
        ? undefined
        : (() => {
            const segment = segmentAtRef(envelope, state.selection);
            return segment === undefined ? undefined : resolveSelection(envelope, segment);
          })();
    // Whether the palette can act at all: any position needs an anchor, and the
    // panel's own before/after choice decides which edge of a cell's paragraph
    // run is addressed.
    const selectedAddress =
      envelope === null || state.selection === null
        ? null
        : (() => {
            const segment = segmentAtRef(envelope, state.selection);
            return segment === undefined ? null : insertAnchor(envelope, segment, "after");
          })();
    const componentDisabled =
      componentsSupportReason(capabilities, t) ||
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
                  disabledReason={componentDisabled}
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
