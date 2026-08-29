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
  DocumentHandle,
  HwpEngine,
  ValidationReport,
} from "@hwp-editor/core";
import { createStore, segmentAtRef } from "@hwp-editor/core";
import type { EditorError, EditorStore } from "@hwp-editor/core";
import { HwpEditorContext } from "./context.js";
import type { HwpEditorContextValue } from "./context.js";
import { PageCanvas } from "./PageCanvas.js";
import { SegmentInspector } from "./SegmentInspector.js";
import { TableGrid } from "./TableGrid.js";
import { FieldsPanel } from "./FieldsPanel.js";
import { ComposePanel } from "./ComposePanel.js";
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

type SideTab = "para" | "table" | "fields";

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
      onReady,
      onError,
      onChange,
      onDirtyChange,
      className,
      style,
    } = props;

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
    const [tab, setTab] = useState<SideTab>("para");
    const [composing, setComposing] = useState(false);

    // Load the document whenever the engine/file pair changes.
    useEffect(() => {
      let cancelled = false;
      if (file === null) {
        setEnvelope(null);
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
          if (cancelled) return;
          setCapabilities(caps);
          setEnvelope(nextEnvelope);
          setValidation(report);
          setLoadError(null);
          store.dispatch({ type: "load", document: file, pages });
          // Once per completed load, from THIS effect only: a second effect
          // keyed on envelope/pages would re-fire after every apply and undo.
          emitReady(file);
        } catch (e) {
          if (cancelled) return;
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

    // Follow selection to the relevant tab.
    useEffect(() => {
      if (envelope === null || state.selection === null) return;
      const segment = segmentAtRef(envelope, state.selection);
      if (segment === undefined) return;
      setTab(
        isTableSlice(segmentText(envelope, segment)) ? "table" : "para",
      );
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
          const next = await engine.edit(snapshot.document!, snapshot.pendingOps, {
            verify: true,
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

    const revert = useCallback((): Promise<void> => {
      const snapshot = store.getState();
      const previous = snapshot.snapshots[snapshot.snapshots.length - 1];
      if (previous === undefined) return Promise.resolve();
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
        refresh,
        openCompose,
        t,
      ],
    );

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "Escape") {
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
            >
              {t("toolbar.newDocument")}
            </button>
          </header>

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
                  >
                    {t("canvas.createCta")}
                  </button>
                </div>
              </div>
            ) : (
              <PageCanvas />
            )}
            <aside className="hwped-side" aria-label={t("side.panelAria")}>
              <div className="hwped-tabs" role="tablist">
                {(
                  [
                    ["para", t("tabs.para")],
                    ["table", t("tabs.table")],
                    ["fields", t("tabs.fields")],
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
              {tab === "para" && <SegmentInspector />}
              {tab === "table" && <TableGrid />}
              {tab === "fields" && <FieldsPanel />}
            </aside>
          </div>

          {composing && (
            <ComposePanel
              onClose={() => setComposing(false)}
              onComposed={(document) => {
                setComposing(false);
                emitChange(document);
                // The host passes the composed document back via `file`; load
                // it directly so the flow also works when the host doesn't.
                void (async () => {
                  try {
                    const [nextEnvelope, pages] = await Promise.all([
                      engine.read(document),
                      engine.render(document, RENDER_SVG),
                    ]);
                    setEnvelope(nextEnvelope);
                    store.dispatch({ type: "load", document, pages });
                  } catch (e) {
                    // Covers the render AFTER a successful compose; the
                    // compose call itself fails inside ComposePanel.
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
