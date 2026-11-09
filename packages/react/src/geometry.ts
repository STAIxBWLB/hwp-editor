/** Exact layout rows take precedence; older hosts keep the linear flow model. */

import type { CatEnvelope, LayoutRow, PageImage, Segment } from "@hwp-editor/core";
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
  // Between segments: pick a paragraph, never a run address for paragraph edits.
  let best: Segment | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of envelope.segments) {
    if (segment.kind !== "para") continue;
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


/** Segment for a rendered rectangle. Ranges in the two artifacts never mix. */
export function segmentForRow(envelope: CatEnvelope, row: LayoutRow): Segment | undefined {
  return envelope.segments.find((segment) => segment.id === row.id);
}

/** Resolve both axes in page coordinates, favoring inner text over its table. */
export function segmentOnPage(
  envelope: CatEnvelope,
  page: PageImage,
  xFraction: number,
  yFraction: number,
  pageIndex: number,
  pageCount: number,
): Segment | undefined {
  if (page.layout === undefined || !envelope.segments.some((segment) => segment.id !== undefined)) {
    return nearestSegment(envelope, pageIndex, yFraction, pageCount);
  }
  const { width_pt, height_pt, rows } = page.layout;
  const x = clamp(xFraction, 0, 1) * width_pt;
  const y = clamp(yFraction, 0, 1) * height_pt;
  let best: Segment | undefined;
  let bestDistance = Infinity;
  let bestArea = Infinity;
  for (const row of rows) {
    const box = row.box;
    const segment = segmentForRow(envelope, row);
    if (box === null || segment === undefined) continue;
    const dx = Math.max(box.x0 - x, 0, x - box.x1);
    const dy = Math.max(box.y0 - y, 0, y - box.y1);
    const distance = dx * dx + dy * dy;
    const area = Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
    if (distance < bestDistance || (distance === bestDistance &&
      (area < bestArea || (area === bestArea && row.kind === "para" && best?.kind !== "para")))) {
      best = segment;
      bestDistance = distance;
      bestArea = area;
    }
  }
  return best;
}

export interface RowBand {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Every fragment gets its own rectangle, including repeated IDs on one page. */
export function bandsOnPage(
  envelope: CatEnvelope,
  segment: Segment,
  page: PageImage,
  pageIndex: number,
  pageCount: number,
): RowBand[] {
  if (page.layout === undefined || segment.id === undefined) {
    const band = segmentBand(envelope, segment, pageCount);
    return band?.pageIndex === pageIndex
      ? [{ left: 0, top: band.top, width: 100, height: band.height }]
      : [];
  }
  // Runs have no row of their own. Use the enclosing paragraph's geometry.
  const target = segment.kind === "run" && segment.indices !== undefined
    ? envelope.segments.find((candidate) => candidate.kind === "para" &&
        candidate.section === segment.section && candidate.indices !== undefined &&
        candidate.indices.length === segment.indices!.length - 1 &&
        candidate.indices.every((value, index) => value === segment.indices![index])) ?? segment
    : segment;
  const { width_pt, height_pt, rows } = page.layout;
  return rows.filter((row) => row.id === target.id && row.box !== null).map((row) => {
    const box = row.box!;
    return {
      left: box.x0 / width_pt * 100,
      top: box.y0 / height_pt * 100,
      width: Math.max(0, box.x1 - box.x0) / width_pt * 100,
      height: Math.max(0, box.y1 - box.y0) / height_pt * 100,
    };
  });
}
