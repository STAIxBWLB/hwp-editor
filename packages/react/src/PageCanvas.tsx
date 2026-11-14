import { useMemo } from "react";
import type { JSX, KeyboardEvent, MouseEvent } from "react";
import type { CatEnvelope, EditOp, PageImage, Segment } from "@hwp-editor/core";
import { base64, segmentAtRef, segmentText, selectionAction } from "@hwp-editor/core";
import { segmentOnPage, bandsOnPage } from "./geometry.js";
import { plainSegmentText } from "./text.js";
import { useHwpEditorContext } from "./context.js";

/**
 * Multi-page scroll of rendered pages. Every page renders as an image;
 * raster formats fall back to <img>. Clicks resolve to the nearest segment
 * (using layout rows, with a flow-model fallback for older hosts), and selected/pending
 * segments are highlighted with overlay bands.
 */
export function PageCanvas(): JSX.Element {
  const { state, store, envelope, t } = useHwpEditorContext();
  const { pages, selection, pendingOps } = state;

  const pendingSegments = useMemo(
    () => pendingSegmentKeys(envelope, pendingOps),
    [envelope, pendingOps],
  );

  const selectedSegments = new Set<Segment>();
  if (envelope !== null) {
    const refs = state.selections?.length ? state.selections : selection === null ? [] : [selection];
    for (const ref of refs) {
      const segment = segmentAtRef(envelope, ref);
      if (segment !== undefined) selectedSegments.add(segment);
    }
  }

  // The pages come from the store and the envelope from React state, and a
  // load sets both: the store's dispatch can render before the envelope's
  // update commits (React 18 flushes a useSyncExternalStore change first).
  // A page shown in that window is a button whose click selectAt drops,
  // because there is no envelope to resolve it against. So the pages are not
  // shown, or announced as clickable, until the envelope they map onto is.
  if (pages.length === 0 || envelope === null) {
    return (
      <div className="hwped-canvas" role="main" aria-label={t("canvas.aria")}>
        <div className="hwped-empty">{t("canvas.emptyPages")}</div>
      </div>
    );
  }

  const selectAt = (pageIndex: number, xFraction: number, yFraction: number, modifiers?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void => {
    if (envelope === null) return;
    const segment = segmentOnPage(envelope, pages[pageIndex]!, xFraction, yFraction, pageIndex, pages.length);
    if (segment !== undefined) {
      const mode = modifiers?.shiftKey ? "extend" : modifiers?.metaKey || modifiers?.ctrlKey ? "toggle" : "single";
      store.dispatch(selectionAction(envelope, store.getState(), segment, mode));
    }
  };

  return (
    <div className="hwped-canvas" role="main" aria-label={t("canvas.aria")}>
      {pages.map((page, pageIndex) => (
        <PageView
          key={page.page}
          page={page}
          onClick={(e: MouseEvent<HTMLDivElement>) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            selectAt(
              pageIndex,
              rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5,
              rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5,
              e,
            );
          }}
          onActivate={event => selectAt(pageIndex, 0.5, 0.5, event)}
          bands={bandsForPage(
            envelope,
            page,
            pageIndex,
            pages.length,
            selectedSegments,
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
  left: number;
  width: number;
}

/**
 * What tells two segments apart in a React key.
 *
 * A run that a block control interrupts is published as two pieces under ONE
 * id and one nesting path (`crates/hwp-convert/src/segment.rs`, "A fragmented
 * run"), so the id names the run and the path names where it sits - neither
 * names a piece. The published `char_range` start does, because each piece is
 * its own contiguous run of characters, so it joins the key. Without it the two
 * pieces are two bands under one React key and React keeps the wrong one.
 */
export function bandIdentity(segment: Segment): string {
  return `${segment.section}/${segment.indices?.join(".") ?? segment.para}:${segment.start}`;
}

function bandsForPage(
  envelope: ReturnType<typeof useHwpEditorContext>["envelope"],
  page: PageImage,
  pageIndex: number,
  pageCount: number,
  selected: Set<Segment>,
  pendingKeys: Set<string>,
): Band[] {
  if (envelope === null) return [];
  const bands: Band[] = [];
  const selectedIds = new Set([...selected].flatMap(segment => segment.id === undefined ? [] : [segment.id]));
  for (const segment of envelope.segments) {
    const key = segment.id ?? `${segment.section}:${segment.para}`;
    const isSelected = selected.has(segment) || (segment.id !== undefined && selectedIds.has(segment.id));
    const isPending = !isSelected && pendingKeys.has(key);
    if (!isSelected && !isPending) continue;
    for (const [index, band] of bandsOnPage(envelope, segment, page, pageIndex, pageCount).entries()) {
      bands.push({
        ...band,
        key: `${isSelected ? "sel" : "pend"}-${key}-${bandIdentity(segment)}-${index}`,
        className: (isSelected
          ? "hwped-band hwped-band-selected"
          : "hwped-band hwped-band-pending") + (band.approximate ? " hwped-band-approximate" : ""),
      });
    }
  }
  return bands;
}

function PageView(props: {
  page: PageImage;
  onClick: (e: MouseEvent<HTMLDivElement>) => void;
  onActivate: (event: KeyboardEvent<HTMLDivElement>) => void;
  bands: Band[];
}): JSX.Element {
  const { page, onClick, onActivate, bands } = props;
  // PageView is only ever rendered inside <HwpEditor>, so it reaches `t`
  // through the context rather than threading a label prop down.
  const { t } = useHwpEditorContext();
  const label = t("page.label", { page: page.page });
  // Every format is drawn through <img>, SVG included: an SVG document used
  // as an image runs no script and loads no external resource, so the page's
  // bytes never become markup in the editor's DOM.
  const imgSrc = useMemo(() => {
    const mime = page.format === "jpeg" ? "image/jpeg" : page.format === "svg" ? "image/svg+xml" : `image/${page.format}`;
    return `data:${mime};base64,${base64.encode(page.data)}`;
  }, [page]);

  return (
    <div
      className="hwped-page"
      role="button"
      tabIndex={0}
      aria-label={label}
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(e);
        }
      }}
    >
      <img
        className="hwped-page-img"
        src={imgSrc}
        alt={label}
        width={page.width}
        height={page.height}
      />
      {bands.map((band) => (
        <div
          key={band.key}
          className={band.className}
          data-approximate={band.className.includes("hwped-band-approximate") ? "true" : undefined}
          style={{ top: `${band.top}%`, height: `${band.height}%`, left: `${band.left}%`, width: `${band.width}%` }}
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


function pendingSegmentKeys(envelope: CatEnvelope | null, ops: EditOp[]): Set<string> {
  const keys = new Set<string>();
  if (envelope === null) return keys;
  for (const segment of envelope.segments) {
    if (ops.some((op) => targetsSegment(op, envelope, segment))) {
      keys.add(segment.id ?? `${segment.section}:${segment.para}`);
    }
  }
  return keys;
}

export function targetsSegment(op: EditOp, envelope: CatEnvelope, segment: Segment): boolean {
  if ("address" in op) {
    if (op.address.id !== undefined) return segment.id === op.address.id;
    const at = op.address.at;
    if (segment.section !== at.section || segment.para !== at.paragraph) return false;
    return "run" in at
      ? segment.kind === "run" && segment.indices?.length === 2 && segment.indices[1] === at.run
      : segment.kind === "para" && (segment.indices === undefined || segment.indices.length === 1);
  }
  const target = opSearchText(op);
  return target !== null && target !== "" &&
    plainSegmentText(segmentText(envelope, segment)).includes(target);
}
