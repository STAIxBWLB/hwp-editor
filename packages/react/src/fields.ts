/**
 * Field-slot extraction from the read() envelope.
 *
 * The engine contract exposes no field/bookmark registry (that would need
 * `hwp fields` / `hwp bookmarks`), so the fields panel works with template
 * placeholder slots — `{{name}}` markers in the markdown — which map
 * directly onto `hwp edit --set-field "name=value"`.
 */

import type { CatEnvelope, Segment, SegmentRef } from "@hwp-editor/core";
import { segmentAtOffset } from "@hwp-editor/core";

export interface FieldSlot {
  /** Placeholder name as written between the braces. */
  name: string;
  /** Segment containing the placeholder. */
  segment: SegmentRef;
}

const SLOT_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** All `{{name}}` placeholder slots in the envelope, in document order. */
export function extractFieldSlots(envelope: CatEnvelope): FieldSlot[] {
  const slots: FieldSlot[] = [];
  const seen = new Set<string>();
  for (const match of envelope.markdown.matchAll(SLOT_PATTERN)) {
    const name = match[1] ?? "";
    const offset = match.index ?? 0;
    const segment: Segment | undefined = segmentAtOffset(envelope, offset);
    if (segment === undefined || seen.has(name)) continue;
    seen.add(name);
    slots.push({
      name,
      segment: { section: segment.section, para: segment.para },
    });
  }
  return slots;
}
