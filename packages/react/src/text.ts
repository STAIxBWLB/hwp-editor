import type { CatEnvelope, PageImage, Segment } from "@hwp-editor/core";
import { segmentIdPath, segmentText } from "@hwp-editor/core";

/**
 * Plain-text extraction for segment markdown slices.
 *
 * `hwp edit` find/anchor arguments match against the document's paragraph
 * text, not the markdown rendering of it — so markers like `#`, `**`, and
 * link syntax must be stripped before a segment's text is used as an op
 * target. This is intentionally conservative: anything unrecognized is kept
 * verbatim (a longer anchor is still a valid anchor).
 */
export function plainSegmentText(markdownSlice: string): string {
  return dropListBreaks(markdownSlice)
    .split("\n")
    .map(stripLine)
    .join("\n")
    .trim();
}

/**
 * The fixed line the engine's Markdown projection writes between a numbered
 * list and a bulleted list that directly follows it (#183). It is projection,
 * not paragraph text, but it falls inside the next paragraph's char_range.
 * Only a line that is exactly this comment after trimming is dropped; the same
 * text mid-line, or any other comment, is kept verbatim.
 */
const LIST_BREAK = "<!-- list-break -->";

function dropListBreaks(markdown: string): string {
  return markdown
    .split("\n")
    .filter(line => line.trim() !== LIST_BREAK)
    .join("\n");
}

function stripLine(line: string): string {
  let out = line.trimEnd();
  // ATX heading markers.
  out = out.replace(/^#{1,6}\s+/, "");
  // Links and images: keep the visible label.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Emphasis markers (strong first, then em).
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");
  // Inline code backticks.
  out = out.replace(/`([^`]*)`/g, "$1");
  return out;
}

/**
 * A Markdown list marker the projection puts in front of a numbered or
 * bulleted paragraph: `1. `, `1) `, `- `, `* `, `+ `, after any nesting indent.
 */
const LIST_MARKER = /^[ \t]*(?:\d{1,9}[.)]|[-*+])[ \t]+/;

/**
 * The paragraph's editable source text, as `hwp edit` matches it (#168).
 *
 * The Markdown projection renders HWP auto-numbering and bullets as a list
 * marker that is not in the paragraph's source text, so a `find` cut from the
 * Markdown names text the engine does not have. Stripping every leading `1. `
 * would break a paragraph whose source really begins with one, so the marker
 * is dropped only when the envelope or the layout proves it is generated:
 *
 * - v2: the paragraph's first run starts after the paragraph does; the
 *   Markdown between them is presentation, not source.
 * - v1 with render layout: the paragraph's rows cover exactly the source
 *   length without the marker, and not with it.
 *
 * With neither signal, the text is returned as before.
 */
export function paragraphSourceText(
  envelope: CatEnvelope,
  para: Segment,
  pages: readonly PageImage[] = [],
): string {
  const plain = plainSegmentText(segmentText(envelope, para));
  const marker = LIST_MARKER.exec(plain);
  if (marker === null) return plain;
  const stripped = plain.slice(marker[0].length);
  if (para.indices !== undefined) {
    const first = envelope.segments.find(candidate => candidate.kind === "run" &&
      candidate.section === para.section && candidate.indices !== undefined &&
      candidate.indices.length === para.indices!.length + 1 &&
      para.indices!.every((value, index) => candidate.indices![index] === value));
    if (first !== undefined) {
      const lead = dropListBreaks([...segmentText(envelope, para)].slice(0, Math.max(0, first.start - para.start)).join("")).trimStart();
      return LIST_MARKER.test(lead) && lead.trim() === marker[0].trim() ? stripped : plain;
    }
  }
  const length = sourceLength(para, pages);
  if (length === undefined) return plain;
  return stripped.length === length && plain.length !== length ? stripped : plain;
}

/** Source UTF-16 length the layout rows of one paragraph cover, if known. */
function sourceLength(para: Segment, pages: readonly PageImage[]): number | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const page of pages) {
    for (const row of page.layout?.rows ?? []) {
      if (row.kind !== "para" || row.source_chars === null || !rowMatches(row.id, para)) continue;
      start = Math.min(start, row.source_chars.start);
      end = Math.max(end, row.source_chars.end);
    }
  }
  return end >= start ? end - start : undefined;
}

/** Whether a layout row id names this paragraph, with or without a v2 id. */
export function rowMatches(rowId: string, segment: Segment): boolean {
  if (segment.id !== undefined) return rowId === segment.id;
  const path = segmentIdPath(rowId);
  const own = [segment.section, ...(segment.indices ?? [segment.para])];
  return path.length === own.length && path.every((value, index) => value === own[index]);
}
