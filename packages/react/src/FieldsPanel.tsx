import { useMemo, useState } from "react";
import type { JSX } from "react";
import { segmentAtRef, segmentText } from "@hwp-editor/core";
import { extractFieldSlots } from "./fields.js";
import { useHwpEditorContext } from "./context.js";

/**
 * Lists `{{field}}` placeholder slots found in the read() envelope, with
 * set-field editing and jump-to-segment on click. (The engine contract has
 * no native field/bookmark listing; see fields.ts.)
 */
export function FieldsPanel(): JSX.Element {
  const { store, envelope, editable } = useHwpEditorContext();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const slots = useMemo(
    () => (envelope === null ? [] : extractFieldSlots(envelope)),
    [envelope],
  );

  if (envelope === null || slots.length === 0) {
    return (
      <div className="hwped-panel" role="region" aria-label="필드">
        <p className="hwped-hint">
          문서에서 {"{{이름}}"} 형태의 필드 자리표시자를 찾지 못했습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="hwped-panel" role="region" aria-label="필드">
      <ul className="hwped-fields">
        {slots.map((slot) => {
          const segment = segmentAtRef(envelope, slot.segment);
          const snippet =
            segment === undefined
              ? ""
              : segmentText(envelope, segment).trim().slice(0, 40);
          const draft = drafts[slot.name] ?? "";
          return (
            <li key={slot.name} className="hwped-field-item">
              <div className="hwped-row">
                <button
                  type="button"
                  className="hwped-btn hwped-btn-link"
                  title={snippet}
                  onClick={() =>
                    store.dispatch({ type: "select", selection: slot.segment })
                  }
                >
                  {slot.name}
                </button>
              </div>
              <div className="hwped-row">
                <input
                  className="hwped-input"
                  type="text"
                  value={draft}
                  disabled={!editable}
                  placeholder="새 값"
                  aria-label={`필드 ${slot.name} 값`}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [slot.name]: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="hwped-btn"
                  disabled={!editable || draft === ""}
                  onClick={() =>
                    store.dispatch({
                      type: "queueOp",
                      op: { kind: "set-field", name: slot.name, value: draft },
                    })
                  }
                >
                  설정
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
