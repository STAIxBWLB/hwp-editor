import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Capabilities, Component, DocumentHandle, EditorError, EmbeddedTemplate } from "@hwp-editor/core";
import { STARTER_COMPONENTS, documentSpecFromComponents } from "@hwp-editor/core";
import { ErrorLine } from "./ErrorLine.js";
import { toEditorError } from "./errors.js";
import { COMPOSE_PRESETS, buildDocumentSpec } from "./presets.js";
import { componentFailure } from "./components-support.js";
import type { ComposePreset } from "./presets.js";
import type { MessageKey } from "./messages.js";
import { useHwpEditorContext } from "./context.js";
import { templateMethodStatus, templateStatusReason } from "./template-support.js";

/**
 * Preset key -> message key. A typed total Record rather than a
 * template-literal cast: adding an eighth preset must fail `tsc --noEmit`
 * here and force a label decision, which a cast would hide. The preset
 * PROFILES stay in presets.ts as document data (I18N-05).
 */
const PRESET_LABEL_KEYS: Record<ComposePreset, MessageKey> = {
  official: "presets.official",
  report: "presets.report",
  plan: "presets.plan",
  notice: "presets.notice",
  minutes: "presets.minutes",
  gaejosik: "presets.gaejosik",
  press: "presets.press",
};

export interface ComposePanelProps {
  /** False when the current editor surface is read-only. */
  canCreate?: boolean;
  /** Components the assembly offers; the shipped starters by default. */
  components?: readonly Component[];
  /**
   * Called with the composed document once engine.compose() succeeds.
   *
   * RETURNING a sentence refuses it: the editor did not take the document, the
   * dialog stays open with the composition, and the sentence is shown there.
   * The creating surface owns the screen while it is open, so a refusal that
   * only reached the editor's notice line would be written behind the modal.
   */
  onComposed: (document: DocumentHandle) => string | void;
  /** Close without composing. */
  onClose: () => void;
}

/**
 * One row of the assembly: a component, its catalogue position fixed at the
 * time it was added, and the param values the user edited for it.
 */
interface AssemblyRow {
  /** Row identity; the same component may be added more than once. */
  key: number;
  component: Component;
  /** Only what the user changed; an untouched param keeps the component's value. */
  values: Record<string, string>;
}

/**
 * New-document flow, from one of two sources:
 *
 * - the preset picker plus guided form (title, author, markdown-ish body), or
 * - an ordered component list, composed through `documentSpecFromComponents`,
 *   which substitutes each component's params once and merges the styles the
 *   components define (refusing two different definitions of one name).
 *
 * The assembly wins while it holds a row: it is the document's content and
 * carries its own styles, so the type, author and body fields are switched off
 * with a hint rather than silently ignored. The title stays: it is the file
 * name and the document metadata in both sources.
 */
export function ComposePanel(props: ComposePanelProps): JSX.Element {
  const { engine, t, onError, store, state, loadEpoch, loadSettled, loadInFlight } = useHwpEditorContext();
  const components = props.components ?? STARTER_COMPONENTS;
  const [preset, setPreset] = useState<ComposePreset>("official");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [assembly, setAssembly] = useState<AssemblyRow[]>([]);
  const [catalogue, setCatalogue] = useState(components[0]?.name ?? "");
  const nextRowKey = useRef(0);
  const [creating, setBusy] = useState(false);
  const busy = creating || state.status === "applying";
  const assembling = assembly.length > 0;
  const [error, setError] = useState<EditorError | null>(null);
  const canCreate = props.canCreate ?? true;
  /**
   * A load in flight is the one state `canCreate` cannot see: the store still
   * holds the old document until the load resolves, so a created document
   * would replace the file the host has just chosen. Disabled here, with the
   * sentence that says why; the flow's own guards still compare the captured
   * epoch, because this flag is a render hint and can lag a started load.
   */
  const locked = !canCreate || busy || loadInFlight;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [templates, setTemplates] = useState<EmbeddedTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const embeddedStatus = templateMethodStatus(engine, capabilities, "listTemplates");
  const createStatus = templateMethodStatus(engine, capabilities, "create");

  useEffect(() => {
    let cancelled = false;
    void engine.capabilities().then(async (result) => {
      if (cancelled) return;
      setCapabilities(result);
      if (templateMethodStatus(engine, result, "listTemplates").supported && engine.listTemplates !== undefined) {
        const items = await engine.listTemplates();
        if (!cancelled) { setTemplates(items); setTemplateId(items[0]?.id ?? ""); }
      }
    }).catch((e: unknown) => {
      if (!cancelled) { setError(toEditorError(e)); onError?.(e); }
    });
    return () => { cancelled = true; };
  }, [engine, onError]);

  // Escape is the way out of a modal, like the Cancel button. It listens on
  // the document because focus is still on the trigger when the dialog
  // opens. It leaves alone an Escape that ends an IME composition (Korean
  // input), one another handler already consumed, and any press while a
  // compose is in flight, the same state that disables Cancel.
  const { onClose } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (busy) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  // A host that swaps its library must not leave the picker on a component it
  // no longer offers.
  useEffect(() => {
    setCatalogue((current) =>
      components.some((component) => component.name === current) ? current : components[0]?.name ?? "",
    );
  }, [components]);

  const addRow = (): void => {
    const component = components.find((candidate) => candidate.name === catalogue);
    if (component === undefined) return;
    setAssembly((previous) => [
      ...previous,
      { key: nextRowKey.current++, component, values: {} },
    ]);
  };

  const moveRow = (key: number, direction: -1 | 1): void => {
    setAssembly((previous) => {
      const at = previous.findIndex((row) => row.key === key);
      const target = at + direction;
      if (at < 0 || target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      next[at] = previous[target]!;
      next[target] = previous[at]!;
      return next;
    });
  };

  const removeRow = (key: number): void => {
    setAssembly((previous) => previous.filter((row) => row.key !== key));
  };

  const setParam = (key: number, param: string, value: string): void => {
    setAssembly((previous) =>
      previous.map((row) =>
        row.key === key ? { ...row, values: { ...row.values, [param]: value } } : row,
      ),
    );
  };

  /**
   * Refuse a press in the two places this dialog can be answered in: its own
   * error line, where the user is looking, and the host, which hears every
   * refusal in this editor so a caller is never left with a press that did
   * nothing. The sentence is carried as an `Error` when no engine failure
   * carries it instead, the same shape `noteRefusal` uses.
   */
  const refuse = (sentence: string): void => {
    const shown = new Error(sentence);
    setError(toEditorError(shown));
    onError?.(shown);
  };

  /**
   * The exact "a document is still loading" sentence this dialog last showed,
   * kept as text rather than re-derived when it is retired: a locale change
   * while the load runs would otherwise leave the other language's sentence on
   * screen, which is the class the editor's own notice line already had to fix.
   */
  const loadingRefusal = useRef("");
  /**
   * Refuse a press because a load is replacing the document, and remember the
   * sentence so the load that caused it can take it back down.
   */
  const refuseLoading = (): void => {
    const sentence = t("error.loadingReplacement");
    loadingRefusal.current = sentence;
    refuse(sentence);
  };
  // The load that caused that refusal has landed or failed, so the sentence
  // names a condition that no longer holds and the press can be made again.
  // No dependency list: `loadSettled()` compares refs, so the render that
  // carries the settled load is the only trigger there is.
  useEffect(() => {
    const sentence = loadingRefusal.current;
    if (sentence === "" || !loadSettled()) return;
    loadingRefusal.current = "";
    setError((current) => (current !== null && current.message === sentence ? null : current));
  });

  const compose = async (): Promise<void> => {
    if (!canCreate || busy) return;
    // A load in flight would be replaced by what this composes, and it is the
    // file the host chose. `locked` disables the button, but the hint is a
    // render behind, so the press itself asks the generations. A composed
    // document's read raises no hint at all — the dialog is open and enabled
    // while this editor is still taking that composition on — so the refusal
    // is said out loud rather than left as a press that did nothing, and it
    // reaches the host as every other refusal in this editor does.
    if (!loadSettled()) {
      refuseLoading();
      return;
    }
    setBusy(true);
    setError(null);
    // Both halves are captured now and checked before the result may replace
    // the document: a load the host started meanwhile, and an apply or undo
    // that changed the document, each make this result stale.
    const epoch = loadEpoch();
    const source = store.getState().document;
    try {
      const written = title.trim();
      const spec = assembling
        ? documentSpecFromComponents(
            assembly.map((row) => ({ component: row.component, values: row.values })),
            written === "" ? {} : { title: written },
          )
        : buildDocumentSpec(preset, { title, author, body });
      const stem = written === "" ? t("compose.defaultFileStem") : written;
      const result = await engine.compose(spec, `${stem}.hwpx`);
      if (!mounted.current) return;
      if (loadEpoch() !== epoch || store.getState().document !== source) {
        throw new Error(t("error.staleCompose"));
      }
      // The editor may refuse the document it was handed (a load that started
      // after this press). It answers with the sentence rather than writing it
      // on the editor's notice line, which sits behind this dialog.
      const refused = props.onComposed(result.document);
      if (typeof refused === "string") refuse(refused);
    } catch (e) {
      // A component refusal carries a code, the component and the field, and
      // is rendered as a localized sentence before it reaches the host: the
      // assembly is what produced it, so this dialog says where to look.
      const shown = componentFailure(e, t);
      // Compose is one of the two operations that can refuse with
      // `protected`, so this surface needs the code as much as the editor's.
      setError(toEditorError(shown));
      // This panel owns its own error state, so the context passthrough is
      // the only channel by which a compose failure reaches the host.
      onError?.(shown);
    } finally {
      setBusy(false);
    }
  };

  const createEmbedded = async (): Promise<void> => {
    if (!canCreate || busy || engine.create === undefined || !createStatus.supported || templateId === "") return;
    // Same rule as `compose`: a document created now would replace the file
    // the host has chosen and this editor has not finished reading.
    if (!loadSettled()) {
      refuseLoading();
      return;
    }
    const epoch = loadEpoch();
    const source = store.getState().document;
    setBusy(true); setError(null);
    try {
      const stem = title.trim() === "" ? templateId : title.trim();
      const next = await engine.create(templateId, `${stem}.hwpx`);
      if (!mounted.current) return;
      // A load in flight leaves the old document in the store until it
      // resolves, so the document identity alone would still match.
      if (loadEpoch() !== epoch || store.getState().document !== source) throw new Error(t("error.staleCompose"));
      const refused = props.onComposed(next);
      if (typeof refused === "string") refuse(refused);
    } catch (e) {
      if (mounted.current) { setError(toEditorError(e)); onError?.(e); }
    } finally { if (mounted.current) setBusy(false); }
  };

  return (
    <div className="hwped-overlay" role="presentation" onClick={props.onClose}>
      <div
        className="hwped-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("compose.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="hwped-dialog-title">{t("compose.title")}</h2>

        <section className="hwped-field" aria-label={t("templates.embeddedPicker")}>
          <span className="hwped-label">{t("templates.embeddedPicker")}</span>
          {(!embeddedStatus.supported || !createStatus.supported) ? (
            <p className="hwped-hint">{t("templates.disabled", { reason: !embeddedStatus.supported ? templateStatusReason(t, embeddedStatus, "listTemplates") : templateStatusReason(t, createStatus, "create"), remedy: t("templates.remedy") })}</p>
          ) : (
            <div className="hwped-row">
              <select className="hwped-input" aria-label={t("templates.embeddedPicker")} value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={locked || templates.length === 0}>
                {templates.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <button type="button" className="hwped-btn" disabled={locked || templateId === ""} onClick={() => void createEmbedded()}>{t("templates.createEmbedded")}</button>
            </div>
          )}
        </section>

        <div className="hwped-field">
          <span className="hwped-label">{t("compose.docType")}</span>
          <div
            className="hwped-presets"
            role="radiogroup"
            aria-label={t("compose.docTypeAria")}
          >
            {COMPOSE_PRESETS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={preset === value}
                className={
                  "hwped-preset" +
                  (preset === value ? " hwped-preset-active" : "")
                }
                disabled={locked || assembling}
                onClick={() => setPreset(value)}
              >
                {t(PRESET_LABEL_KEYS[value])}
              </button>
            ))}
          </div>
        </div>

        <div className="hwped-field">
          <label className="hwped-label" htmlFor="hwped-compose-title">
            {t("compose.titleLabel")}
          </label>
          <input
            id="hwped-compose-title"
            className="hwped-input"
            type="text"
            disabled={locked}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("compose.titlePlaceholder")}
          />
        </div>

        <div className="hwped-field">
          <label className="hwped-label" htmlFor="hwped-compose-author">
            {t("compose.authorLabel")}
          </label>
          <input
            id="hwped-compose-author"
            className="hwped-input"
            type="text"
            disabled={locked || assembling}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder={t("compose.authorPlaceholder")}
          />
        </div>

        <div className="hwped-field">
          <label className="hwped-label" htmlFor="hwped-compose-body">
            {t("compose.bodyLabel")}
          </label>
          <textarea
            id="hwped-compose-body"
            className="hwped-textarea"
            rows={8}
            disabled={locked || assembling}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("compose.bodyPlaceholder")}
          />
        </div>

        <section className="hwped-field" aria-label={t("compose.componentsTitle")}>
          <span className="hwped-label">{t("compose.componentsTitle")}</span>
          <p className="hwped-hint">{t("compose.componentsHint")}</p>
          <div className="hwped-row">
            <select
              className="hwped-input"
              aria-label={t("compose.componentPicker")}
              value={catalogue}
              onChange={(e) => setCatalogue(e.target.value)}
              disabled={locked || components.length === 0}
            >
              {components.map((component) => (
                <option key={component.name} value={component.name}>
                  {component.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="hwped-btn"
              disabled={locked || catalogue === ""}
              onClick={addRow}
            >
              {t("compose.addComponent")}
            </button>
          </div>
          {assembling ? (
            <ol className="hwped-fields" aria-label={t("compose.assemblyAria")}>
              {assembly.map((row, index) => (
                <li key={row.key} className="hwped-field-item">
                  <strong>{row.component.name}</strong>
                  {Object.entries(row.component.params).map(([param, fallback]) => (
                    <label key={param} className="hwped-label">
                      {param}
                      <input
                        className="hwped-input"
                        type="text"
                        aria-label={t("compose.paramAria", { component: row.component.name, param })}
                        disabled={locked}
                        value={row.values[param] ?? fallback}
                        onChange={(e) => setParam(row.key, param, e.target.value)}
                      />
                    </label>
                  ))}
                  <div className="hwped-row">
                    <button
                      type="button"
                      className="hwped-btn"
                      disabled={locked || index === 0}
                      aria-label={t("components.moveUp", { name: row.component.name })}
                      onClick={() => moveRow(row.key, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="hwped-btn"
                      disabled={locked || index === assembly.length - 1}
                      aria-label={t("components.moveDown", { name: row.component.name })}
                      onClick={() => moveRow(row.key, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="hwped-btn"
                      disabled={locked}
                      aria-label={t("components.remove", { name: row.component.name })}
                      onClick={() => removeRow(row.key)}
                    >
                      {t("components.remove", { name: row.component.name })}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="hwped-hint">{t("compose.componentsEmpty")}</p>
          )}
        </section>

        {loadInFlight && <p className="hwped-hint" role="status">{t("compose.loadingInFlight")}</p>}

        {error !== null && (
          <ErrorLine prefix={t("error.prefix.compose")} {...error} />
        )}

        <div className="hwped-row hwped-dialog-actions">
          <button
            type="button"
            className="hwped-btn"
            onClick={props.onClose}
            disabled={busy}
          >
            {t("compose.cancel")}
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-primary"
            onClick={() => void compose()}
            disabled={locked}
          >
            {busy ? t("compose.submitting") : t("compose.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
