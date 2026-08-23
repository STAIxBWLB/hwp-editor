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
  return markdownSlice
    .split("\n")
    .map(stripLine)
    .join("\n")
    .trim();
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
