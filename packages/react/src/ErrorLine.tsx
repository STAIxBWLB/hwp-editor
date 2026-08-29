/**
 * The one alert surface in this package. Every `role="alert"` the editor
 * renders goes through here, which is what guarantees each of them carries
 * a `data-error-kind` — and gives a later redaction pass (Phase 4 SEC-06)
 * a single place to change.
 *
 * Deliberately NOT exported from index.ts: `packages/react/src/index.ts` is
 * published API at 1.0.0 and nothing outside this package needs it.
 */

import type { JSX } from "react";
import { engineErrorKind } from "./errors.js";
import type { EngineErrorKind } from "./errors.js";
import { useHwpEditorContext } from "./context.js";
import type { MessageKey } from "./messages.js";

/**
 * Badge label key per kind. A total Record on purpose: a fifth kind must
 * fail `tsc --noEmit` here rather than render an undefined label. The label
 * TEXT lives in the string table; only this kind→key mapping is code.
 */
const LABEL_KEY_BY_KIND: Record<EngineErrorKind, MessageKey> = {
  timeout: "error.kind.timeout",
  unavailable: "error.kind.unavailable",
  protected: "error.kind.protected",
  generic: "error.kind.generic",
};

/** One alert line with a distinct kind badge for known engine failures. */
export function ErrorLine(props: {
  prefix: string;
  /** Stable HwpErrorCode when the failure carried one; drives the badge. */
  code?: string;
  message: string;
}): JSX.Element {
  // ErrorLine is always rendered inside <HwpEditor>, so it reaches `t`
  // through the context instead of taking a label prop at both call sites.
  const { t } = useHwpEditorContext();
  const kind = engineErrorKind({
    // Conditional spread: exactOptionalPropertyTypes rejects an explicit
    // `code: undefined` against the optional field.
    ...(props.code !== undefined ? { code: props.code } : {}),
    message: props.message,
  });
  return (
    <p className="hwped-error" role="alert" data-error-kind={kind}>
      {kind !== "generic" && (
        <span className={`hwped-error-kind hwped-error-${kind}`}>
          {t(LABEL_KEY_BY_KIND[kind])}
        </span>
      )}
      {props.prefix}: {props.message}
    </p>
  );
}
