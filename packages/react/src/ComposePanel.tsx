import { useState } from "react";
import type { JSX } from "react";
import type { DocumentHandle } from "@hwp-editor/core";
import {
  COMPOSE_PRESETS,
  COMPOSE_PRESET_LABELS,
  buildDocumentSpec,
} from "./presets.js";
import type { ComposePreset } from "./presets.js";
import { useHwpEditorContext } from "./context.js";

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
  const { engine } = useHwpEditorContext();
  const [preset, setPreset] = useState<ComposePreset>("official");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compose = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const spec = buildDocumentSpec(preset, { title, author, body });
      const stem = title.trim() === "" ? "새 문서" : title.trim();
      const result = await engine.compose(spec, `${stem}.hwpx`);
      props.onComposed(result.document);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        aria-label="새 문서 만들기"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="hwped-dialog-title">새 문서 만들기</h2>

        <div className="hwped-field">
          <span className="hwped-label">문서 유형</span>
          <div className="hwped-presets" role="radiogroup" aria-label="문서 유형">
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
                {COMPOSE_PRESET_LABELS[value]}
              </button>
            ))}
          </div>
        </div>

        <div className="hwped-field">
          <label className="hwped-label" htmlFor="hwped-compose-title">
            제목
          </label>
          <input
            id="hwped-compose-title"
            className="hwped-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="문서 제목"
          />
        </div>

        <div className="hwped-field">
          <label className="hwped-label" htmlFor="hwped-compose-author">
            작성자
          </label>
          <input
            id="hwped-compose-author"
            className="hwped-input"
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="작성자 (선택)"
          />
        </div>

        <div className="hwped-field">
          <label className="hwped-label" htmlFor="hwped-compose-body">
            본문
          </label>
          <textarea
            id="hwped-compose-body"
            className="hwped-textarea"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              "빈 줄로 문단을 구분합니다. '# '로 시작하는 줄은 소제목이 됩니다.\n\n예)\n# 1. 개요\n본문 내용..."
            }
          />
        </div>

        {error !== null && (
          <p className="hwped-error" role="alert">
            문서 생성 실패: {error}
          </p>
        )}

        <div className="hwped-row hwped-dialog-actions">
          <button
            type="button"
            className="hwped-btn"
            onClick={props.onClose}
            disabled={busy}
          >
            취소
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-primary"
            onClick={() => void compose()}
            disabled={busy}
          >
            {busy ? "생성 중..." : "문서 생성"}
          </button>
        </div>
      </div>
    </div>
  );
}
