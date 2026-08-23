/**
 * Minimal SVG sanitizer for inline rendering of `hwp render --format svg`
 * output. The CLI output is trusted, but hosts embedding arbitrary documents
 * get script/foreignObject/event-handler removal for free.
 *
 * Returns "" when the payload does not parse as XML.
 */
export function sanitizeSvg(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (
    root === null ||
    root.nodeName === "parsererror" ||
    doc.getElementsByTagName("parsererror").length > 0
  ) {
    return "";
  }
  const dangerous = root.querySelectorAll("script, foreignObject");
  for (const node of Array.from(dangerous)) node.remove();
  scrubElement(root);
  return root.outerHTML;
}

function scrubElement(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim().toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
    } else if (
      (name === "href" || name === "xlink:href") &&
      value.startsWith("javascript:")
    ) {
      el.removeAttribute(attr.name);
    }
  }
  for (const child of Array.from(el.children)) scrubElement(child);
}
