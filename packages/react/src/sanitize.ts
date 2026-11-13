/**
 * Minimal SVG cleanup that removes script, foreignObject and event-handler
 * attributes. Returns "" when the payload does not parse as XML.
 *
 * @deprecated Not a security boundary: a blocklist cannot make SVG safe to
 * insert into HTML, and its output must not be inserted into the DOM as
 * markup (innerHTML, dangerouslySetInnerHTML). Render an SVG page as an image
 * instead, e.g. `<img src="data:image/svg+xml;base64,...">`, which is what the
 * editor's page view does. Kept exported for API compatibility only; it is
 * unused by this package and will be removed in 2.0.
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
