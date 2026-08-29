import { useState } from "react";
import type { JSX } from "react";
import type { DocumentHandle, EditorError } from "@hwp-editor/core";
import { ErrorLine } from "./ErrorLine.js";
import { toEditorError } from "./errors.js";
import { COMPOSE_PRESETS, buildDocumentSpec } from "./presets.js";
import type { ComposePreset } from "./presets.js";
import type { MessageKey } from "./messages.js";
import { useHwpEditorContext } from "./context.js";

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
  /** Called with the composed document once engine.compose() succeeds. */
  onComposed: (document: DocumentHandle) => void;
  /** Close without composing. */
  onClose: () => void;
}

/**
 * New-document flow: preset picker + guided form (title, author,
 * markdown-ish sections) → DocumentSpec v2 → engine.compose().
 */
export function ComposePanel(props: ComposePanelProps): JSX.Element {
  const { engine, t, onError } = useHwpEditorContext();
  const [preset, setPreset] = useState<ComposePreset>("official");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EditorError | null>(null);

  const compose = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const spec = buildDocumentSpec(preset, { title, author, body });
      const stem =
        title.trim() === "" ? t("compose.defaultFileStem") : title.trim();
      const result = await engine.compose(spec, `${stem}.hwpx`);
      props.onComposed(result.document);
    } catch (e) {
      // Compose is one of the two operations that can refuse with
      // `protected`, so this surface needs the code as much as the editor's.
      setError(toEditorError(e));
      // This panel owns its own error state, so the context passthrough is
      // the only channel by which a compose failure reaches the host.
      onError?.(e);
    } finally {
      setBusy(false);
    }
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
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("compose.bodyPlaceholder")}
          />
        </div>

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
            disabled={busy}
          >
            {busy ? t("compose.submitting") : t("compose.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
