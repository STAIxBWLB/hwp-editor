/**
 * #58 (flaky "item 22" on React 18): a page is a button only once the
 * envelope that maps a click onto a paragraph is there. The pages come from the
 * store and the envelope from React state, and a load sets both; under React
 * 18 the store's update could render first, so a page click in that window was
 * silently dropped by `selectAt`. The canvas now shows no page until the
 * envelope commits.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HwpEditor, en } from "../src/index.js";
import { clientYForPara, createMockEngine, makeEnvelope } from "./mock-engine.js";

beforeAll(() => {
  // jsdom reports zero-size boxes; give pages the render's 595x842 rect.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const page = this.classList.contains("hwped-page");
    return { top: 0, left: 0, right: page ? 595 : 0, bottom: page ? 842 : 0, width: page ? 595 : 0, height: page ? 842 : 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

describe("a page is clickable only once its envelope is there", () => {
  // The race needs a click in the same frame the page first paints, so the
  // case is repeated; on React 18 before the fix about 1 in 20 lost its click.
  it.each(Array.from({ length: 20 }, (_, i) => i))("selects the clicked paragraph when clicked at the page's first paint (%s)", async () => {
    const base = makeEnvelope();
    const engine = createMockEngine({ envelope: { ...base, segments: base.segments.map((s, at) => ({ ...s, id: `p${at}` })) } });
    const view = render(<HwpEditor engine={engine} file={{ name: "a.hwpx", data: new Uint8Array([1]) }} />);
    const label = en["page.label"]({ page: 1 });
    await new Promise<void>((resolve) => {
      const tryClick = (): boolean => {
        const page = view.container.querySelector(`[aria-label="${label}"]`);
        if (page === null) return false;
        fireEvent.click(page, { clientY: clientYForPara(base, 0) });
        return true;
      };
      if (tryClick()) { resolve(); return; }
      const observer = new MutationObserver(() => {
        if (tryClick()) { observer.disconnect(); resolve(); }
      });
      observer.observe(view.container, { childList: true, subtree: true });
    });
    expect(await screen.findByText("1. 회의록", {}, { timeout: 1000 })).toBeTruthy();
    cleanup();
  });
});
