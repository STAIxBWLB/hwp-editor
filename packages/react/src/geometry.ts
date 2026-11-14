/** Exact layout rows take precedence; older hosts keep the linear flow model. */

import type { CatEnvelope, PageImage, Segment } from "@hwp-editor/core";
import { segmentAtOffset, markdownLength, segmentIdPath } from "@hwp-editor/core";

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
  return Math.round(fraction * markdownLength(envelope));
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
  const length = markdownLength(envelope);
  if (length === 0) return null;
  const total = Math.max(pageCount, 1);
  const center = (segment.start + segment.end) / 2;
  const position = (center / length) * total;
  const pageIndex = clamp(Math.floor(position), 0, total - 1);
  const height = clamp(((segment.end - segment.start) / length) * total * 100, 2, 100);
  const top = clamp((position - pageIndex) * 100 - height / 2, 0, 100 - height);
  return { pageIndex, top, height };
}


/**
 * id to segment for one envelope, built once.
 *
 * A click walks every layout row on the page, so resolving a row's id with a
 * linear scan of the envelope makes one click O(rows x segments). The envelope
 * object is the cache key because every read() replaces it: a stale index
 * cannot outlive the document it describes. The first segment wins, which is
 * what the scan this replaces did, and a repeated id on one page is a fragment
 * the projection lists more than once.
 */
const idIndexes = new WeakMap<CatEnvelope, Map<string, Segment>>();

function idIndex(envelope: CatEnvelope): Map<string, Segment> {
  const cached = idIndexes.get(envelope);
  if (cached !== undefined) return cached;
  const index = new Map<string, Segment>();
  for (const segment of envelope.segments) {
    if (segment.id !== undefined && !index.has(segment.id)) index.set(segment.id, segment);
  }
  idIndexes.set(envelope, index);
  return index;
}

/**
 * Paragraphs of an id-less (v1) envelope by their positional path,
 * `section.indices` joined with dots. A layout row id carries the same path
 * after its checksum, so rows resolve without v2 ids (#168).
 */
const pathIndexes = new WeakMap<CatEnvelope, Map<string, Segment>>();

function pathIndex(envelope: CatEnvelope): Map<string, Segment> {
  const cached = pathIndexes.get(envelope);
  if (cached !== undefined) return cached;
  const index = new Map<string, Segment>();
  for (const segment of envelope.segments) {
    if (segment.id !== undefined || segment.kind !== "para") continue;
    const key = [segment.section, ...(segment.indices ?? [segment.para])].join(".");
    if (!index.has(key)) index.set(key, segment);
  }
  pathIndexes.set(envelope, index);
  return index;
}

/** The segment a layout row draws, by v2 id or, without ids, by path. */
function rowSegment(envelope: CatEnvelope, rowId: string): Segment | undefined {
  const byId = idIndex(envelope).get(rowId);
  if (byId !== undefined) return byId;
  const path = segmentIdPath(rowId);
  return path.length === 0 ? undefined : pathIndex(envelope).get(path.join("."));
}

function hasIds(envelope: CatEnvelope): boolean {
  return envelope.segments.some((segment) => segment.id !== undefined);
}

/** Whether a row draws this segment: same id, or same path without ids. */
function rowDraws(envelope: CatEnvelope, rowId: string, segment: Segment): boolean {
  if (segment.id !== undefined) return rowId === segment.id;
  return rowSegment(envelope, rowId) === segment;
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
  if (page.layout === undefined || (!hasIds(envelope) && page.layout.rows.every((row) => rowSegment(envelope, row.id) === undefined))) {
    return nearestSegment(envelope, pageIndex, yFraction, pageCount);
  }
  const { width_pt, height_pt, rows } = page.layout;
  const x = clamp(xFraction, 0, 1) * width_pt;
  const y = clamp(yFraction, 0, 1) * height_pt;
  let best: Segment | undefined;
  let bestVertical = Infinity;
  let bestHorizontal = Infinity;
  let bestArea = Infinity;
  for (const row of rows) {
    const box = row.box;
    const segment = rowSegment(envelope, row.id);
    if (box === null || segment === undefined) continue;
    const dx = Math.max(box.x0 - x, 0, x - box.x1);
    const dy = Math.max(box.y0 - y, 0, y - box.y1);
    const distance = dx * dx + dy * dy;
    // Beyond a truncated prefix, a nearer recorded row may hide an omitted row.
    if (page.layout.truncated && distance > 0) continue;
    const area = Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
    // In page margins, prefer vertical proximity, then horizontal proximity.
    if (dy < bestVertical || (dy === bestVertical && (dx < bestHorizontal ||
      (dx === bestHorizontal && (area < bestArea ||
        (area === bestArea && row.kind === "para" && best?.kind !== "para")))))) {
      best = segment;
      bestVertical = dy;
      bestHorizontal = dx;
      bestArea = area;
    }
  }
  return best;
}

export interface RowBand {
  /** Set on a band estimated from Markdown length because the page has no layout. */
  approximate?: true;
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
  // Row geometry wins with or without v2 ids (#168). The character-fraction
  // estimate is only for a host that publishes no layout, and says so.
  if (page.layout === undefined) {
    const band = segmentBand(envelope, segment, pageCount);
    return band?.pageIndex === pageIndex
      ? [{ left: 0, top: band.top, width: 100, height: band.height, approximate: true }]
      : [];
  }
  // Runs, images and fields fold into their enclosing paragraph's row.
  const target = ["run", "image", "field"].includes(segment.kind) && segment.indices !== undefined
    ? envelope.segments.find((candidate) => candidate.kind === "para" &&
        candidate.section === segment.section && candidate.indices !== undefined &&
        candidate.indices.length === segment.indices!.length - 1 &&
        candidate.indices.every((value, index) => value === segment.indices![index])) ?? segment
    : segment;
  const { width_pt, height_pt, rows } = page.layout;
  return rows.filter((row) => row.box !== null && rowDraws(envelope, row.id, target)).map((row) => {
    const box = row.box!;
    return {
      left: box.x0 / width_pt * 100,
      top: box.y0 / height_pt * 100,
      width: Math.max(0, box.x1 - box.x0) / width_pt * 100,
      height: Math.max(0, box.y1 - box.y0) / height_pt * 100,
    };
  });
}
