/**
 * Click hit-testing and highlight placement for PageCanvas.
 *
 * Neither the core segment envelope nor the hwp-cli SVG renderer carries
 * per-paragraph page geometry, so positions are estimated with a linear
 * text-flow model: paragraphs flow in document order across pages
 * proportionally to their markdown length. Clicks map to a global flow
 * fraction, then to the nearest segment via the core coordinate helpers;
 * highlight bands use the exact inverse mapping, so the visual highlight
 * always agrees with what a click would select.
 */

import type { CatEnvelope, Segment } from "@hwp-editor/core";
import { segmentAtOffset } from "@hwp-editor/core";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Resolve a page click to the nearest segment. */
export function nearestSegment(
  envelope: CatEnvelope,
  pageIndex: number,
  yFraction: number,
  pageCount: number,
): Segment | undefined {
  if (envelope.segments.length === 0) return undefined;
  const offset = clickOffset(envelope, pageIndex, yFraction, pageCount);
  const hit = segmentAtOffset(envelope, offset);
  if (hit !== undefined) return hit;
  // Between segments (blank spacing): pick the nearest by start offset.
  let best: Segment | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of envelope.segments) {
    const distance = Math.abs(segment.start - offset);
    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }
  return best;
}

/** Global markdown offset for a click, in flow order. */
export function clickOffset(
  envelope: CatEnvelope,
  pageIndex: number,
  yFraction: number,
  pageCount: number,
): number {
  const total = Math.max(pageCount, 1);
  const fraction = clamp(
    (clamp(pageIndex, 0, total - 1) + clamp(yFraction, 0, 1)) / total,
    0,
    1,
  );
  return Math.round(fraction * envelope.markdown.length);
}

export interface SegmentBand {
  /** 0-based page index the band is drawn on. */
  pageIndex: number;
  /** Band top as a percentage of page height. */
  top: number;
  /** Band height as a percentage of page height. */
  height: number;
}

/**
 * Estimated overlay band for a segment — the inverse of {@link clickOffset},
 * so bands and click hit-testing stay consistent.
 */
export function segmentBand(
  envelope: CatEnvelope,
  segment: Segment,
  pageCount: number,
): SegmentBand | null {
  const length = envelope.markdown.length;
  if (length === 0) return null;
  const total = Math.max(pageCount, 1);
  const center = (segment.start + segment.end) / 2;
  const position = (center / length) * total;
  const pageIndex = clamp(Math.floor(position), 0, total - 1);
  const height = clamp(((segment.end - segment.start) / length) * total * 100, 2, 100);
  const top = clamp((position - pageIndex) * 100 - height / 2, 0, 100 - height);
  return { pageIndex, top, height };
}
