/**
 * A rendered SVG page is an image, never markup: whatever the page's SVG
 * carries stays inside an <img>, which runs no script and loads nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HwpEditor } from "../src/index.js";
import { createMockEngine, makeEnvelope } from "./mock-engine.js";
import type { PageImage } from "@hwp-editor/core";

afterEach(cleanup);

const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="595" height="842" onload="window.__pwned=1">
  <a id="smil-set"><set attributeName="href" to="javascript:window.__pwned=2"/><text y="20">a</text></a>
  <a id="smil-animate"><animate attributeName="href" values="javascript:window.__pwned=3"/><text y="40">b</text></a>
  <a id="split" href="java&#9;script:window.__pwned=4"><text y="60">c</text></a>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <use href="https://example.invalid/x.svg#a"/>
</svg>`;

const page: PageImage = {
  page: 1, width: 595, height: 842, dpi: 96, format: "svg",
  data: new TextEncoder().encode(HOSTILE),
};

describe("PageView renders an SVG page as an image", () => {
  it("puts no SVG markup in the DOM, only one <img> with an svg data URL", async () => {
    const engine = createMockEngine({ envelope: makeEnvelope() });
    engine.render = async () => [page];
    const { container } = render(<HwpEditor engine={engine} file={{ name: "a.hwpx", data: new Uint8Array([1]) }} />);
    const button = await screen.findByRole("button", { name: /1/u });
    const pageBox = button.closest(".hwped-page") ?? button;

    expect(container.querySelector("svg")).toBeNull();
    for (const selector of ["set", "animate", "foreignObject", "use", "[onload]", "#smil-set", "#smil-animate", "#split", ".hwped-page-svg"]) {
      expect(pageBox.querySelector(selector)).toBeNull();
    }
    expect(pageBox.innerHTML).not.toMatch(/javascript|java\tscript|example\.invalid|onload/iu);

    const images = pageBox.querySelectorAll("img");
    expect(images).toHaveLength(1);
    const src = images[0]!.getAttribute("src") ?? "";
    expect(src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(new TextDecoder().decode(Uint8Array.from(atob(src.slice("data:image/svg+xml;base64,".length)), (c) => c.charCodeAt(0))))
      .toBe(HOSTILE);
  });
});
