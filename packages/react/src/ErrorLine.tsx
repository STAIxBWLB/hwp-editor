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
import { engineErrorKind, ENGINE_ERROR_LABELS } from "./errors.js";

/** One alert line with a distinct kind badge for known engine failures. */
export function ErrorLine(props: {
  prefix: string;
  /** Stable HwpErrorCode when the failure carried one; drives the badge. */
  code?: string;
  message: string;
}): JSX.Element {
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
          {ENGINE_ERROR_LABELS[kind]}
        </span>
      )}
      {props.prefix}: {props.message}
    </p>
  );
}
