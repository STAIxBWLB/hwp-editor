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
import type { TFunction } from "./messages.js";
import { isComponentError } from "@hwp-editor/core";
import type { Blocks } from "@hwp-editor/core";

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

/** The insertion width the engine printed in a `layout_overflow` refusal, in mm. */
export function overflowingBodyMm(message: string): number | undefined {
  // The engine prints both forms: "body width is 46.40 mm" for a column total
  // and "exceeds body width 46.40 mm" for the table's own width.
  const match = /body width (?:is )?([\d.]+) ?mm/.exec(message) ??
    /폭은 ([\d.]+)mm/.exec(message);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Whether an engine failure is the width refusal `insert_blocks` answers with.
 *
 * `layout_overflow` is the engine's own diagnostic token and survives its
 * Korean prose, which is why it is the marker rather than a translated phrase.
 */
export function isLayoutOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("layout_overflow");
}

/**
 * An error to report for a failed insertion: the width refusal becomes a
 * localized sentence naming both widths, and anything else is passed through
 * as it came, so a host still sees the engine's own code and detail.
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
  const detail = error instanceof Error ? error : new Error(message);
  // A width-bearing block is what overflows, so an unmeasurable component is
  // reported as the engine sent it rather than with a guessed width.
  if (wanted === undefined) return error;
  const text = t("components.tooWide", {
    width: millimetres(wanted),
    available: available === undefined ? "" : millimetres(available),
  });
  // The engine's diagnostic stays on the error for a host that logs it; the
  // message a user reads is the localized one.
  return Object.assign(new Error(text), { detail: message });
}

/** A component refusal as the localized sentence for it. */
export function componentRefusalText(error: unknown, t: TFunction): string | null {
  if (!isComponentError(error)) return null;
  return t("components.refused", {
    code: error.code,
    source: error.source,
    field: error.field,
    reason: error.reason,
  });
}

/**
 * The message to report for a throw from a component path: the localized
 * refusal when it is one, otherwise whatever came.
 */
export function componentFailure(error: unknown, t: TFunction): unknown {
  const text = componentRefusalText(error, t);
  return text === null ? error : new Error(text);
}
