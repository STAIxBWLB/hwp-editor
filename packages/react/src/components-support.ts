/**
 * What the palette does when a component cannot become an op, or when the
 * engine refuses the one it was sent.
 *
 * Two things are translated here rather than shown as the engine wrote them:
 *
 * - A component refusal (`ComponentError`) carries a code, the component's
 *   name or file and the field that failed, so the sentence a user reads is in
 *   their locale and still names where to look.
 * - `insert_blocks` refuses a block wider than its insertion point with a
 *   diagnostic that reads the same in every UI locale ("layout_overflow … body
 *   width is 46.40 mm"). The width of the destination is not something the
 *   render layout publishes — a paragraph's painted box is the width of its
 *   text, 163.9 pt against a 170 mm column in the playground's own fixture —
 *   so the engine's own `layout_overflow` marker and the width it prints are
 *   the source of both numbers, and a preflight from the rendered box would
 *   refuse insertions the engine accepts.
 */
import type { MessageKey, TFunction } from "./messages.js";
import { isComponentError, isHwpEngineError, HwpEngineError } from "@hwp-editor/core";
import type { Blocks, ComponentErrorCode } from "@hwp-editor/core";

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
 * The insertion width named in a `layout_overflow` refusal, in mm.
 *
 * Three spellings reach here: the server's one-line cause (`insertion point
 * 46.40 mm`, built from cli-engine's refusal summary), the engine's own
 * "body width is 46.40 mm" / "exceeds body width 46.40 mm", and the Korean
 * tail it repeats the figure in. A host wired in process passes the raw engine
 * text, so all three stay.
 */
export function overflowingBodyMm(message: string): number | undefined {
  const match = /insertion point ([\d.]+) ?mm/.exec(message) ??
    /body width (?:is )?([\d.]+) ?mm/.exec(message) ??
    /폭은 ([\d.]+)mm/.exec(message);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Whether an engine failure is the width refusal `insert_blocks` answers with.
 *
 * `layout_overflow` is the engine's own diagnostic token: it survives the
 * Korean prose, and the CLI server carries it out of stderr unchanged (it is
 * the only part of an `insert_blocks` refusal that names no file path), so the
 * same marker works over HTTP and in process.
 */
export function isLayoutOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("layout_overflow");
}

/**
 * The localized sentence as an error a host renders, keeping what the failure
 * arrived with: the engine code, the HTTP status and the original error stay on
 * the wrapper (REVIEW.md — a failure wrapper must not drop them), and the
 * engine's own diagnostic rides along on `detail` for a log.
 */
function wrapped(error: unknown, text: string, detail: string): Error {
  if (isHwpEngineError(error)) {
    return Object.assign(
      new HwpEngineError(error.code, text, {
        ...(error.status === undefined ? {} : { status: error.status }),
        cause: error,
      }),
      { detail },
    );
  }
  return Object.assign(new Error(text), { detail });
}

/**
 * An error to report for a failed insertion: the width refusal becomes a
 * localized sentence naming the widths it could measure, and anything else is
 * passed through as it came, so a host still sees the engine's own code and
 * detail.
 */
export function insertionFailure(
  error: unknown,
  blocks: Blocks,
  t: TFunction,
): unknown {
  if (!isLayoutOverflow(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const wanted = widestBlockMm(blocks);
  const available = overflowingBodyMm(message);
  // Every sentence below names a next step the user can take; none of them
  // leaves a blank where a width would go.
  const text = wanted === undefined
    ? t("components.tooWideUnknown")
    : available === undefined
      ? t("components.tooWideUnmeasured", { width: millimetres(wanted) })
      : t("components.tooWide", { width: millimetres(wanted), available: millimetres(available) });
  return wrapped(error, text, message);
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
