/**
 * Field-slot extraction from the read() envelope.
 *
 * The engine contract exposes no field/bookmark registry (that would need
 * `hwp fields` / `hwp bookmarks`), so the fields panel works with template
 * placeholder slots — `{{name}}` markers in the markdown — which map
 * directly onto `hwp edit --set-field "name=value"`.
 */

import type { CatEnvelope, Segment, SegmentRef } from "@hwp-editor/core";
import { resolveSelection, segmentRef } from "@hwp-editor/core";

export interface FieldSlot {
  /** Placeholder name as written between the braces. */
  name: string;
  /** Segment containing the placeholder. */
  segment: SegmentRef;
}

const SLOT_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Kinds whose range is a control's own display text or anchor inside a
 * paragraph, never text that a paragraph sits inside.
 *
 * A field segment covers the text it displays (the projection's
 * `open_control_segment`), at the same depth as the run that holds it, and a
 * hyperlink or push-button field's display text is usually shorter than that
 * run - so the depth-and-range comparison favours the control over the run.
 * Resolving a slot through the control refuses it as a container, which would
 * drop exactly the `{{slot}}`s that `--set-field` fills. The paragraph or run
 * that holds the control is what a slot inside it belongs to.
 */
const CONTROL_KINDS: ReadonlySet<string> = new Set(["field", "image", "bookmark"]);

/**
 * The innermost segment covering `offset`.
 *
 * A v2 projection lists a table's host paragraph before the cell and the
 * cell's own paragraph, and `segmentAtOffset` answers with the first segment
 * whose range holds the offset: for a slot in a cell that is the host. Depth
 * in `indices` is what says which segment sits inside which. On a tie -
 * including a legacy projection, where every depth is 0 - the shorter range
 * is the inner one.
 *
 * Controls are not candidates (see `CONTROL_KINDS`). Tables and cells stay in
 * the comparison without ever being the answer: they lose to the paragraph
 * that holds the text, and a slot inside a table whose cell paragraph the
 * projection omits is then refused rather than resolved to the host paragraph
 * whose range covers the whole table.
 */
function innermostAt(envelope: CatEnvelope, offset: number): Segment | undefined {
  let best: Segment | undefined;
  for (const segment of envelope.segments) {
    if (CONTROL_KINDS.has(segment.kind)) continue;
    if (segment.start > offset || offset >= segment.end) continue;
    if (best === undefined) {
      best = segment;
      continue;
    }
    const depth = segment.indices?.length ?? 0;
    const bestDepth = best.indices?.length ?? 0;
    if (depth > bestDepth ||
        (depth === bestDepth && segment.end - segment.start < best.end - best.start)) {
      best = segment;
    }
  }
  return best;
}

/**
 * All `{{name}}` placeholder slots in the envelope, in document order.
 *
 * Each slot names the paragraph that holds it, never an enclosing one: a
 * table and a cell sit inside a host paragraph whose range covers the whole
 * table, so a slot resolved to the host would make the inspector's Delete
 * remove the table as well. `resolveSelection` is the same mapper every other
 * target goes through, so a slot resolves exactly where a click on it does.
 * When it refuses - a nested paragraph with no id of its own has no ref that
 * names it - the slot is left out: `hit` is a segment the resolver rejected,
 * and shipping its coordinate would resolve to the host it was refused for.
 */
export function extractFieldSlots(envelope: CatEnvelope): FieldSlot[] {
  const slots: FieldSlot[] = [];
  const seen = new Set<string>();
  for (const match of envelope.markdown.matchAll(SLOT_PATTERN)) {
    const name = match[1] ?? "";
    // `match.index` counts UTF-16 units while a segment range counts Unicode
    // scalars, so a non-BMP character before the slot would shift the lookup
    // one segment on. Counting the prefix's scalars is the offset.
    const offset = [...envelope.markdown.slice(0, match.index ?? 0)].length;
    const hit = innermostAt(envelope, offset);
    if (hit === undefined || seen.has(name)) continue;
    const paragraph = resolveSelection(envelope, hit).paragraph;
    if (paragraph === undefined) continue;
    seen.add(name);
    slots.push({ name, segment: segmentRef(paragraph) });
  }
  return slots;
}
