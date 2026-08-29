import {
  useCallback,
  useEffect,
  useMemo,
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
  /** Called whenever the document bytes change (applied edit, undo, compose). */
  onChange?: (document: DocumentHandle) => void;
  /** Called when the dirty flag (pending ops queued) changes. */
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
  style?: CSSProperties;
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
export function HwpEditor(props: HwpEditorProps): JSX.Element {
  const {
    engine,
    file,
    locale = "en",
    messages,
    onChange,
    onDirtyChange,
    className,
    style,
  } = props;

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
      } catch (e) {
        if (!cancelled) setLoadError(toEditorError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, file, store]);

  const editable = capabilities?.editable ?? true;

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
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const applyPendingOps = useCallback(() => {
    const snapshot = store.getState();
    if (
      snapshot.document === null ||
      snapshot.pendingOps.length === 0 ||
      snapshot.status === "applying" ||
      !editable
    ) {
      return;
    }
    store.dispatch({ type: "applyStarted" });
    void (async () => {
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
        onChange?.(next);
      } catch (e) {
        store.dispatch({ type: "applyFailed", error: toEditorError(e) });
      }
    })();
  }, [editable, engine, onChange, store]);

  const revert = useCallback(() => {
    const snapshot = store.getState();
    const previous = snapshot.snapshots[snapshot.snapshots.length - 1];
    if (previous === undefined) return;
    void (async () => {
      try {
        const [nextEnvelope, pages] = await Promise.all([
          engine.read(previous),
          engine.render(previous, RENDER_SVG),
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
        store.dispatch({ type: "setPages", pages });
        onChange?.(previous);
      } catch (e) {
        // The store was never touched, so store and canvas stay consistent;
        // without this destination the rejection was unhandled.
        setLoadError(toEditorError(e));
      }
    })();
  }, [engine, onChange, store]);

  const refresh = useCallback(async () => {
    const snapshot = store.getState();
    if (snapshot.document === null) return;
    const [nextEnvelope, pages, report] = await Promise.all([
      engine.read(snapshot.document),
      engine.render(snapshot.document, RENDER_SVG),
      engine.validate(snapshot.document).catch(() => null),
    ]);
    setEnvelope(nextEnvelope);
    setValidation(report);
    store.dispatch({ type: "setPages", pages });
  }, [engine, store]);

  const openCompose = useCallback(() => setComposing(true), []);

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
      applyPendingOps();
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
            <span className="hwped-notice" role="note">
              {t("toolbar.readOnly")}
              {/* The engine's reason is its own prose and is shown verbatim
                  under either locale; only the fallback label is localized. */}
              {capabilities?.reason !== undefined
                ? `: ${capabilities.reason}`
                : ` (${t("error.kind.protected")})`}
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
            onClick={revert}
            disabled={state.snapshots.length === 0 || state.status === "applying"}
          >
            {t("toolbar.revert")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-primary"
            onClick={applyPendingOps}
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
              onChange?.(document);
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
                }
              })();
            }}
          />
        )}
      </div>
    </HwpEditorContext.Provider>
  );
}
