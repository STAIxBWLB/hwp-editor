/**
 * Localization contract for the editor chrome (I18N-01..04, I18N-06..08).
 *
 * Selectors here are TABLE-DRIVEN: every query derives from the `en`/`ko`
 * tables rather than a hardcoded literal, so the suite runs against both
 * locales from one body and a copy change never silently breaks a selector.
 * The merge order under test is `en` -> locale table -> `messages`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import type { Locale, MessageTable } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const tables: Record<Locale, MessageTable> = { en, ko };

/** The editor root — the element carrying `lang` and `data-status`. */
function root(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".hwped-root");
  if (el === null) throw new Error("no .hwped-root");
  return el as HTMLElement;
}

describe("locale selection (I18N-02, I18N-07)", () => {
  it("defaults to en with lang=en when no locale prop is given", () => {
    const { container } = render(
      <HwpEditor engine={createMockEngine()} file={null} />,
    );
    expect(root(container).getAttribute("lang")).toBe("en");
    expect(screen.getByText(en["toolbar.revert"])).toBeTruthy();
    expect(screen.queryByText(ko["toolbar.revert"])).toBeNull();
  });

  it('renders Korean chrome with lang=ko when locale="ko"', () => {
    const { container } = render(
      <HwpEditor engine={createMockEngine()} file={null} locale="ko" />,
    );
    expect(root(container).getAttribute("lang")).toBe("ko");
    expect(screen.getByText(ko["toolbar.revert"])).toBeTruthy();
    expect(screen.queryByText(en["toolbar.revert"])).toBeNull();
  });
});

describe("messages override (I18N-03)", () => {
  it("replaces exactly the overridden key and leaves the rest at the locale default", () => {
    render(
      <HwpEditor
        engine={createMockEngine()}
        file={null}
        messages={{ "toolbar.revert": "Roll back" }}
      />,
    );
    expect(screen.getByText("Roll back")).toBeTruthy();
    expect(screen.queryByText(en["toolbar.revert"])).toBeNull();
    // Adjacent keys are untouched.
    expect(screen.getByText(en["toolbar.newDocument"])).toBeTruthy();
    expect(screen.getByText(en["canvas.empty"])).toBeTruthy();
  });

  it("overrides on top of the ko table, not on top of en", () => {
    render(
      <HwpEditor
        engine={createMockEngine()}
        file={null}
        locale="ko"
        messages={{ "toolbar.revert": "롤백" }}
      />,
    );
    expect(screen.getByText("롤백")).toBeTruthy();
    expect(screen.getByText(ko["toolbar.newDocument"])).toBeTruthy();
  });

  it("leaves the locale table untouched for messages={{}}", () => {
    const { container } = render(
      <HwpEditor engine={createMockEngine()} file={null} messages={{}} />,
    );
    expect(root(container).getAttribute("lang")).toBe("en");
    expect(screen.getByText(en["toolbar.revert"])).toBeTruthy();
    expect(screen.getByText(en["toolbar.newDocument"])).toBeTruthy();
  });
});

describe("table parity (I18N-06, I18N-08)", () => {
  // `const ko: MessageTable` already makes a missing/extra key a tsc error in
  // both directions; this is the belt-and-braces runtime assertion.
  it("ko has exactly the same keys as en", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });

  it("agrees on which keys are function values", () => {
    for (const key of Object.keys(en) as (keyof MessageTable)[]) {
      expect(typeof ko[key]).toBe(typeof en[key]);
    }
  });
});
