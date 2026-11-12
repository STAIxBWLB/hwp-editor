/**
 * What the palette does when a component cannot become an op, when the engine
 * is certain to refuse it, or when it refuses the op that was sent.
 *
 * Three things are translated here rather than shown as the engine wrote them:
 *
 * - A component refusal (`ComponentError`) carries a code, the component's
 *   name or file and the field that failed, so the sentence a user reads is in
 *   their locale and still names where to look.
 * - `insert_blocks` refuses a block wider than its insertion point with a
 *   diagnostic that reads the same in every UI locale ("layout_overflow … body
 *   width is 46.40 mm"). The width of the destination is not something the
 *   render layout publishes — a paragraph's painted box is the width of its
 *   text, 163.9 pt against a 170 mm column in the playground's own fixture —
 *   so the engine's own `layout_overflow` diagnostic and the width it prints
 *   are the source of both numbers, and a preflight from the rendered box
 *   would refuse insertions the engine accepts.
 * - The same refusal has two other classes — a style the target document
 *   does not define, and a block, style or list definition the engine
 *   rejected — and each gets its own sentence and next step here.
 *
 * All three classes arrive as the structured `insertion` field both
 * transports set from core's `classifyInsertionRefusal` (#88). The message is
 * never parsed for a class: on an unclassified failure it can carry what the
 * user typed.
 *
 * Every other refusal — an insertion before a section's definition paragraph,
 * an equation into `.hwp`, a compile failure — is one class: the engine's own
 * cause inside one frame that names the component and the insertion point, so
 * no transport can leave a caller with a causeless exit code. The three
 * refusals that are certain before the document is touched are answered
 * without a round trip at all.
 *
 * An insertion the engine was stopped out of is the one case where that
 * inner cause is NOT the transport's text: the sentence both transports
 * append for an empty stderr is English, so the locale's own sentence for the
 * structured `stopped` marker takes the slot (#91).
 */
import type { MessageKey, TFunction } from "./messages.js";
import { engineStoppedWithoutDiagnostic } from "./errors.js";
import { isComponentError, isHwpEngineError, isInsertionRefusal, HwpEngineError } from "@hwp-editor/core";
import type { Blocks, ComponentErrorCode, InsertionRefusal } from "@hwp-editor/core";

/** A width as the localized messages print it, in whole millimetres. */
function millimetres(value: number): string {
  return `${Math.round(value * 10) / 10} mm`;
}

/**
 * The widest block a component would insert, in mm.
 *
 * Only the block types that carry a width of their own are measured: a table
 * (its `width_mm`, or its column widths), an image and an equation. Nested
 * cell blocks are measured too, since a cell's content is what overflows a
 * narrow cell first.
 */
export function widestBlockMm(blocks: Blocks): number | undefined {
  let widest: number | undefined;
  const consider = (value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return;
    if (widest === undefined || value > widest) widest = value;
  };
  const walk = (list: Blocks): void => {
    for (const block of list) {
      if (block.type === "table") {
        consider(
          block.width_mm ??
            block.columns.reduce((sum, column) => sum + column.width_mm, 0),
        );
        for (const row of block.rows) {
          for (const cell of row.cells) {
            if (cell.blocks !== undefined) walk(cell.blocks);
          }
        }
      } else if (block.type === "image" || block.type === "equation") {
        consider(block.width_mm);
      }
    }
  };
  walk(blocks);
  return widest;
}

/**
 * The localized reason to refuse an insertion before it is sent, or "" when
 * the engine would accept it.
 *
 * Three refusals are certain rather than speculative, so they are answered
 * here instead of by a failed round trip: the palette stages no image bytes,
 * an insertion carries no section break at the top level of a component, and
 * the engine cannot write an equation into `.hwp` output. Each sentence names
 * the thing to change; the three classes the engine does report stay
 * translated in `insertionFailure` for everything this cannot predict.
 */
export function insertionPreflight(
  blocks: Blocks,
  documentName: string,
  t: TFunction,
): string {
  let image = false;
  let equation = false;
  const walk = (list: Blocks): void => {
    for (const block of list) {
      if (block.type === "image") image = true;
      else if (block.type === "equation") equation = true;
      else if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) if (cell.blocks !== undefined) walk(cell.blocks);
        }
      }
    }
  };
  walk(blocks);
  if (image) return t("components.preflightImage");
  if (blocks.some((block) => block.type === "break" && block.kind === "section")) {
    return t("components.preflightSectionBreak");
  }
  if (equation && documentName.toLowerCase().endsWith(".hwp")) {
    return t("components.preflightEquation", { name: documentName });
  }
  return "";
}

/** The `insert_blocks` class a transport attached to the failure (#88), if any. */
function insertionOf(error: unknown): InsertionRefusal | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { insertion?: unknown }).insertion;
  return isInsertionRefusal(value) ? value : undefined;
}

/**
 * The insertion width a `layout_overflow` refusal measured, in mm, from the
 * structured field a transport sets (#88). The message is not parsed.
 */
export function overflowingBodyMm(error: unknown): number | undefined {
  const insertion = insertionOf(error);
  return insertion?.kind === "layout_overflow" ? insertion.insertionMm : undefined;
}

/**
 * Whether an engine failure is the width refusal `insert_blocks` answers
 * with, read from the structured `insertion` field (#88). The message is not
 * parsed: on an unclassified failure it can carry what the user typed.
 */
export function isLayoutOverflow(error: unknown): boolean {
  return insertionOf(error)?.kind === "layout_overflow";
}

/**
 * The localized sentence as an error a host renders, keeping what the failure
 * arrived with: the engine code, the HTTP status and the original error stay on
 * the wrapper (REVIEW.md — a failure wrapper must not drop them), and the
 * engine's own diagnostic rides along on `detail` for a log.
 */
function wrapped(error: unknown, text: string, detail: string): Error {
  if (isHwpEngineError(error)) {
    const insertion = insertionOf(error);
    return Object.assign(
      new HwpEngineError(error.code, text, {
        ...(error.status === undefined ? {} : { status: error.status }),
        cause: error,
        ...(insertion === undefined ? {} : { insertion }),
        // The marker survives too: a host's `onError` branches on the same
        // structured fields the transport set, so a wrapper that drops one
        // hands it a failure it cannot classify (#91).
        ...(error.stopped === true ? { stopped: true as const } : {}),
      }),
      { detail },
    );
  }
  return Object.assign(new Error(text), { detail });
}

/**
 * The engine's own words from a transport's failure message.
 *
 * Each transport prefixes its own sentence — `ahwp edit failed (exit 3): ` over
 * HTTP and the CLI engine, `hwped_edit failed: hwp edit failed (exit 3): `
 * through the Tauri bridge (maru still writes the `hwp` head), on
 * top of the engine's own `Error: insert_blocks ` — and the cause sits after
 * all of them. What the frame prints is the engine's line, so a caller never
 * reads two prefixes stapled together.
 */
function refusalReason(message: string): string {
  // The engine's stderr can be several lines, and the frame prints one cause:
  // the first non-empty line is the failure, the rest is its context.
  const firstLine = message.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return firstLine
    // The lazy `^.*?` before `hwp` takes this server's `ahwp edit failed` head
    // and maru's `hwp edit failed` head alike.
    .replace(/^.*?hwp edit failed \(exit \d+\):\s*/, "")
    .replace(/^.*?hwped_edit failed:\s*/, "")
    .replace(/^hwp_failed:\s*/, "")
    .replace(/^error:\s*/i, "")
    .replace(/^insert_blocks refused:?\s*/, "")
    .replace(/^insert_blocks\s+/, "")
    .trim();
}

/**
 * Whether a failure on the insertion path is the engine refusing the block,
 * rather than a failure with a message and a badge of its own.
 *
 * The frame below localizes a refusal and nothing else: a timeout, a missing
 * binary, a protected document, an old engine and a staging failure each keep
 * the handling they already have, because calling one of those "the engine
 * refused this insertion" would misname the cause. A failure that carries no
 * error code counts only when a transport attached an `insertion` class.
 */
function isRefusedInsertion(error: unknown): boolean {
  if (insertionOf(error) !== undefined) return true;
  return isHwpEngineError(error) && (error.code === "failed" || error.code === "bad_request");
}

/**
 * An error to report for a failed insertion, in the user's own language.
 *
 * Every transport lands here, so every refused insertion gets a localized
 * sentence rather than whatever the engine or the server wrote: the specific
 * classes (too wide, unknown style, rejected definition) say what to change,
 * and anything else keeps the engine's own reason inside one frame that names
 * both things a caller can vary — the component and the insertion point. The
 * transport's text stays on `detail` for a log, and an error that is not an
 * engine refusal (a timeout, an unavailable binary, a protected document) is
 * passed through with the handling it already has.
 */
export function insertionFailure(
  error: unknown,
  blocks: Blocks,
  t: TFunction,
): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRefusedInsertion(error)) return error;
  // The class comes from the structured field only (#88).
  const insertion = insertionOf(error);
  if (insertion?.kind === "unknown_style") {
    return wrapped(error, t("components.unknownStyle", { style: insertion.style }), message);
  }
  if (insertion?.kind === "layout_overflow") {
    const wanted = widestBlockMm(blocks);
    const available = insertion.insertionMm;
    // Every sentence below names a next step the user can take; none of them
    // leaves a blank where a width would go.
    const text = wanted === undefined
      ? t("components.tooWideUnknown")
      : available === undefined
        ? t("components.tooWideUnmeasured", { width: millimetres(wanted) })
        : t("components.tooWide", { width: millimetres(wanted), available: millimetres(available) });
    return wrapped(error, text, message);
  }
  if (insertion?.kind === "invalid_definition") {
    return wrapped(error, t("components.invalidDefinition"), message);
  }
  // An insertion the engine was stopped out of gets the locale's own sentence
  // for it (#91): the transports append an English one to the message, which
  // would otherwise sit inside this frame in English.
  const reason = engineStoppedWithoutDiagnostic(error)
    ? t("error.stoppedWithoutDiagnostic")
    : refusalReason(message);
  // The frame is the whole point: a refusal with no readable cause still names
  // both things the caller can vary, rather than an empty slot after a colon.
  return wrapped(error, t("components.insertionRefused", { reason }), message);
}

/**
 * The localized next step for a refusal code. The English `reason` keeps its
 * cause and "then retry" tail as technical detail on the error; what the user
 * reads is a whole sentence in their own language, step included.
 */
const STEP_KEYS: Record<ComponentErrorCode, MessageKey> = {
  component_param: "components.step.param",
  component_style: "components.step.style",
  component_invalid: "components.step.invalid",
  component_load: "components.step.load",
};

/** A component refusal as the localized sentence for it. */
export function componentRefusalText(error: unknown, t: TFunction): string | null {
  if (!isComponentError(error)) return null;
  return t("components.refused", {
    code: error.code,
    source: error.source,
    field: error.field,
    value: error.value,
    step: t(STEP_KEYS[error.code]),
  });
}

/**
 * The message to report for a throw from a component path: the localized
 * refusal when it is one, otherwise whatever came. The English one-line form
 * stays on `detail`, which is where a host's log reads it.
 */
export function componentFailure(error: unknown, t: TFunction): unknown {
  const text = componentRefusalText(error, t);
  if (text === null) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return wrapped(error, text, detail);
}
