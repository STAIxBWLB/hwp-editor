import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { ParagraphAlignment } from "@hwp-editor/core";
import { segmentAtRef, segmentText } from "@hwp-editor/core";
import { plainSegmentText } from "./text.js";
import { useHwpEditorContext } from "./context.js";

const ALIGNMENTS: { value: ParagraphAlignment; label: string }[] = [
  { value: "left", label: "왼쪽" },
  { value: "center", label: "가운데" },
  { value: "right", label: "오른쪽" },
  { value: "justify", label: "양쪽" },
];

/**
 * Inspector for a selected paragraph segment: current text plus op builders
 * (replace, insert before/after, delete, alignment, minimal char-format).
 * All controls queue EditOps; nothing touches the engine until Apply.
 */
export function SegmentInspector(): JSX.Element {
  const { state, store, envelope, editable } = useHwpEditorContext();
  const { selection } = state;

  const segment =
    envelope !== null && selection !== null
      ? segmentAtRef(envelope, selection)
      : undefined;
  const currentText =
    envelope !== null && segment !== undefined
      ? plainSegmentText(segmentText(envelope, segment))
      : "";

  const [replaceWith, setReplaceWith] = useState("");
  const [insertText, setInsertText] = useState("");
  const [bold, setBold] = useState(false);
  const [fontSize, setFontSize] = useState("");
  const [color, setColor] = useState("");

  // Reset drafts when the selection moves.
  useEffect(() => {
    setReplaceWith("");
    setInsertText("");
    setBold(false);
    setFontSize("");
    setColor("");
  }, [selection]);

  if (segment === undefined || selection === null) {
    return (
      <div className="hwped-panel" role="region" aria-label="문단 편집">
        <p className="hwped-hint">
          페이지를 클릭해 편집할 문단을 선택하세요.
        </p>
      </div>
    );
  }

  const find = currentText;
  const disabled = !editable;

  return (
    <div className="hwped-panel" role="region" aria-label="문단 편집">
      <div className="hwped-field">
        <span className="hwped-label">
          선택 문단 (구역 {selection.section}, 문단 {selection.para})
        </span>
        <div className="hwped-quote">{currentText || "(빈 문단)"}</div>
      </div>

      <div className="hwped-field">
        <label className="hwped-label" htmlFor="hwped-replace">
          텍스트 교체
        </label>
        <div className="hwped-row">
          <input
            id="hwped-replace"
            className="hwped-input"
            type="text"
            value={replaceWith}
            disabled={disabled}
            onChange={(e) => setReplaceWith(e.target.value)}
            placeholder="새 텍스트"
          />
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || replaceWith === "" || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "replace", find, replace: replaceWith },
              })
            }
          >
            교체
          </button>
        </div>
      </div>

      <div className="hwped-field">
        <label className="hwped-label" htmlFor="hwped-insert">
          문단 삽입
        </label>
        <textarea
          id="hwped-insert"
          className="hwped-textarea"
          value={insertText}
          disabled={disabled}
          onChange={(e) => setInsertText(e.target.value)}
          placeholder="삽입할 문단 텍스트"
          rows={2}
        />
        <div className="hwped-row">
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || insertText === "" || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para-before", anchor: find, text: insertText },
              })
            }
          >
            앞에 삽입
          </button>
          <button
            type="button"
            className="hwped-btn"
            disabled={disabled || insertText === "" || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "insert-para", anchor: find, text: insertText },
              })
            }
          >
            뒤에 삽입
          </button>
          <button
            type="button"
            className="hwped-btn hwped-btn-danger"
            disabled={disabled || find === ""}
            onClick={() =>
              store.dispatch({
                type: "queueOp",
                op: { kind: "delete-para", text: find },
              })
            }
          >
            문단 삭제
          </button>
        </div>
      </div>

      <div className="hwped-field">
        <span className="hwped-label">정렬</span>
        <div className="hwped-row" role="group" aria-label="문단 정렬">
          {ALIGNMENTS.map((align) => (
            <button
              key={align.value}
              type="button"
              className="hwped-btn"
              disabled={disabled || find === ""}
              onClick={() =>
                store.dispatch({
                  type: "queueOp",
                  op: { kind: "set-align", find, alignment: align.value },
                })
              }
            >
              {align.label}
            </button>
          ))}
        </div>
      </div>

      <div className="hwped-field">
        <span className="hwped-label">글자 서식</span>
        <div className="hwped-row">
          <label className="hwped-check">
            <input
              type="checkbox"
              checked={bold}
              disabled={disabled}
              onChange={(e) => setBold(e.target.checked)}
            />
            굵게
          </label>
          <input
            className="hwped-input hwped-input-narrow"
            type="number"
            min={1}
            value={fontSize}
            disabled={disabled}
            onChange={(e) => setFontSize(e.target.value)}
            placeholder="크기(pt)"
            aria-label="글자 크기(pt)"
          />
          <input
            className="hwped-input hwped-input-narrow"
            type="text"
            value={color}
            disabled={disabled}
            onChange={(e) => setColor(e.target.value)}
            placeholder="#FF0000"
            aria-label="글자 색상"
          />
          <button
            type="button"
            className="hwped-btn"
            disabled={
              disabled ||
              find === "" ||
              (!bold && fontSize === "" && color === "")
            }
            onClick={() => {
              const props: Record<string, string> = {};
              if (bold) props["bold"] = "on";
              if (fontSize !== "") props["size"] = fontSize;
              if (color !== "") props["color"] = color;
              store.dispatch({
                type: "queueOp",
                op: { kind: "set-format", find, props },
              });
            }}
          >
            서식 적용
          </button>
        </div>
      </div>
    </div>
  );
}
