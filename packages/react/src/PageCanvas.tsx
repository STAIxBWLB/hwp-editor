import { useMemo } from "react";
import type { JSX, MouseEvent } from "react";
import type { PageImage, Segment } from "@hwp-editor/core";
import { base64, segmentAtRef, segmentRef, segmentText } from "@hwp-editor/core";
import { nearestSegment, segmentBand } from "./geometry.js";
import { sanitizeSvg } from "./sanitize.js";
import { plainSegmentText } from "./text.js";
import { useHwpEditorContext } from "./context.js";

/**
 * Multi-page scroll of rendered pages. SVG pages render inline (sanitized);
 * raster formats fall back to <img>. Clicks resolve to the nearest segment
 * (see geometry.ts for the flow-model approximation), and selected/pending
 * segments are highlighted with overlay bands.
 */
export function PageCanvas(): JSX.Element {
  const { state, store, envelope } = useHwpEditorContext();
  const { pages, selection, pendingOps } = state;

  // Segments covered by queued text-targeting ops, highlighted as pending.
  const pendingSegments = useMemo(() => {
    if (envelope === null) return new Set<string>();
    const keys = new Set<string>();
    for (const op of pendingOps) {
      const target = opSearchText(op);
      if (target === null || target === "") continue;
      for (const segment of envelope.segments) {
        const plain = plainSegmentText(segmentText(envelope, segment));
        if (plain.includes(target)) {
          keys.add(`${segment.section}:${segment.para}`);
        }
      }
    }
    return keys;
  }, [envelope, pendingOps]);

  const selectedSegment =
    envelope !== null && selection !== null
      ? segmentAtRef(envelope, selection)
      : undefined;

  if (pages.length === 0) {
    return (
      <div className="hwped-canvas" role="main" aria-label="문서 페이지">
        <div className="hwped-empty">렌더링된 페이지가 없습니다.</div>
      </div>
    );
  }

  const selectAt = (pageIndex: number, yFraction: number): void => {
    if (envelope === null) return;
    const segment = nearestSegment(envelope, pageIndex, yFraction, pages.length);
    if (segment !== undefined) {
      store.dispatch({ type: "select", selection: segmentRef(segment) });
    }
  };

  return (
    <div className="hwped-canvas" role="main" aria-label="문서 페이지">
      {pages.map((page, pageIndex) => (
        <PageView
          key={page.page}
          page={page}
          onClick={(e: MouseEvent<HTMLDivElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            selectAt(
              pageIndex,
              rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5,
            );
          }}
          onActivate={() => selectAt(pageIndex, 0.5)}
          bands={bandsForPage(
            envelope,
            pageIndex,
            pages.length,
            selectedSegment,
            pendingSegments,
          )}
        />
      ))}
    </div>
  );
}

interface Band {
  key: string;
  className: string;
  top: number;
  height: number;
}

function bandsForPage(
  envelope: ReturnType<typeof useHwpEditorContext>["envelope"],
  pageIndex: number,
  pageCount: number,
  selected: Segment | undefined,
  pendingKeys: Set<string>,
): Band[] {
  if (envelope === null) return [];
  const bands: Band[] = [];
  for (const segment of envelope.segments) {
    const key = `${segment.section}:${segment.para}`;
    const isSelected = selected === segment;
    const isPending = !isSelected && pendingKeys.has(key);
    if (!isSelected && !isPending) continue;
    const band = segmentBand(envelope, segment, pageCount);
    if (band === null || band.pageIndex !== pageIndex) continue;
    bands.push({
      key: `${isSelected ? "sel" : "pend"}-${key}`,
      className: isSelected
        ? "hwped-band hwped-band-selected"
        : "hwped-band hwped-band-pending",
      top: band.top,
      height: band.height,
    });
  }
  return bands;
}

function PageView(props: {
  page: PageImage;
  onClick: (e: MouseEvent<HTMLDivElement>) => void;
  onActivate: () => void;
  bands: Band[];
}): JSX.Element {
  const { page, onClick, onActivate, bands } = props;
  const svgHtml = useMemo(
    () =>
      page.format === "svg"
        ? sanitizeSvg(new TextDecoder().decode(page.data))
        : null,
    [page],
  );
  const imgSrc = useMemo(() => {
    if (page.format === "svg") return null;
    const mime = page.format === "jpeg" ? "image/jpeg" : `image/${page.format}`;
    return `data:${mime};base64,${base64.encode(page.data)}`;
  }, [page]);

  return (
    <div
      className="hwped-page"
      role="button"
      tabIndex={0}
      aria-label={`페이지 ${page.page}`}
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {svgHtml !== null ? (
        <div
          className="hwped-page-svg"
          // Sanitized by sanitizeSvg: script/foreignObject/event handlers removed.
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      ) : (
        <img
          className="hwped-page-img"
          src={imgSrc ?? ""}
          alt={`페이지 ${page.page}`}
          width={page.width}
          height={page.height}
        />
      )}
      {bands.map((band) => (
        <div
          key={band.key}
          className={band.className}
          style={{ top: `${band.top}%`, height: `${band.height}%` }}
        />
      ))}
    </div>
  );
}

/** The free-text target of an op, when it has one (find/anchor/text). */
function opSearchText(op: {
  kind: string;
  find?: string;
  anchor?: string;
  text?: string;
}): string | null {
  if ("find" in op && typeof op.find === "string") return op.find;
  if ("anchor" in op && typeof op.anchor === "string") return op.anchor;
  if (op.kind === "delete-para" && typeof op.text === "string") return op.text;
  return null;
}
