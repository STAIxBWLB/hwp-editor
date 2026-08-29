/**
 * Localization contract for the editor chrome (I18N-01..04, I18N-06..08).
 *
 * Selectors here are TABLE-DRIVEN: every query derives from the `en`/`ko`
 * tables rather than a hardcoded literal, so the suite runs against both
 * locales from one body and a copy change never silently breaks a selector.
 * The merge order under test is `en` -> locale table -> `messages`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DocumentHandle } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import type { Locale, MessageTable } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(cleanup);

const tables: Record<Locale, MessageTable> = { en, ko };
const LOCALES: Locale[] = ["en", "ko"];

const file: DocumentHandle = {
  name: "minutes.hwpx",
  data: new TextEncoder().encode("original"),
};

beforeAll(() => {
  // jsdom reports zero-size boxes; give pages the render's 595x842 rect.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return {
      top: 0, left: 0, right: 595, bottom: 842, width: 595, height: 842,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect;
  };
});

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
    expect(
      screen.getByText(en["toolbar.applyWithCount"]({ count: 0 })),
    ).toBeTruthy();
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

  it("renders an empty-string override as empty, not as the default", () => {
    const { container } = render(
      <HwpEditor
        engine={createMockEngine()}
        file={null}
        messages={{ "canvas.empty": "" }}
      />,
    );
    const p = container.querySelector(".hwped-empty p");
    expect(p).not.toBeNull();
    expect(p?.textContent).toBe("");
    expect(screen.queryByText(en["canvas.empty"])).toBeNull();
  });

  // Lookup is exact string equality on keys, so an unknown key is not a
  // silent no-op — `Partial<MessageTable>`'s excess-property check makes
  // `messages={{ "toolbar.nope": "x" }}` a tsc error. That is asserted by
  // the package's typecheck step, not here: committing the broken literal
  // would break the build it is meant to demonstrate.

  it("leaves the locale table untouched for messages={{}}", () => {
    const { container } = render(
      <HwpEditor engine={createMockEngine()} file={null} messages={{}} />,
    );
    expect(root(container).getAttribute("lang")).toBe("en");
    expect(screen.getByText(en["toolbar.revert"])).toBeTruthy();
    expect(screen.getByText(en["toolbar.newDocument"])).toBeTruthy();
  });
});

describe.each(LOCALES)("HwpEditor chrome under locale=%s", (locale) => {
  const t = tables[locale];

  it("puts the active locale on the root lang attribute", () => {
    const { container } = render(
      <HwpEditor locale={locale} engine={createMockEngine()} file={null} />,
    );
    expect(root(container).getAttribute("lang")).toBe(locale);
    // Both supported locales are ltr, so `dir` is deliberately absent.
    expect(root(container).hasAttribute("dir")).toBe(false);
  });

  it("renders the read-only notice with the protected-document fallback", async () => {
    const engine = createMockEngine({ editable: false });
    render(<HwpEditor locale={locale} engine={engine} file={file} />);
    const notice = await screen.findByRole("note");
    // No engine reason: the parenthesized protected label is the fallback.
    expect(notice.textContent).toBe(
      `${t["toolbar.readOnly"]} (${t["error.kind.protected"]})`,
    );
  });

  it("renders an engine-supplied reason verbatim, never translated", async () => {
    // Deliberately Korean prose under BOTH locales: the engine authored it.
    const engine = createMockEngine({ editable: false, reason: "배포용 문서" });
    render(<HwpEditor locale={locale} engine={engine} file={file} />);
    const notice = await screen.findByRole("note");
    expect(notice.textContent).toBe(`${t["toolbar.readOnly"]}: 배포용 문서`);
  });

  it("renders the validation badge as valid", async () => {
    render(<HwpEditor locale={locale} engine={createMockEngine()} file={file} />);
    const badge = await screen.findByLabelText(t["validation.aria"]);
    expect(badge.textContent).toBe(t["validation.valid"]);
  });

  it.each([0, 1, 2])(
    "renders the validation badge for %i errors with no count special-casing",
    async (count) => {
      const engine = createMockEngine();
      engine.validate = async () => ({
        valid: false,
        errors: Array.from({ length: count }, (_, i) => ({
          message: `e${i}`,
        })) as never,
      });
      render(<HwpEditor locale={locale} engine={engine} file={file} />);
      const badge = await screen.findByLabelText(t["validation.aria"]);
      expect(badge.textContent).toBe(t["validation.errors"]({ count }));
    },
  );

  it("renders the pending-edit count at zero through the same function value", () => {
    render(<HwpEditor locale={locale} engine={createMockEngine()} file={null} />);
    const label = t["toolbar.pendingEdits"]({ count: 0 });
    expect(screen.getByLabelText(label).textContent).toBe(label);
  });

  it("renders the empty canvas with its create CTA", () => {
    render(<HwpEditor locale={locale} engine={createMockEngine()} file={null} />);
    expect(screen.getByLabelText(t["canvas.aria"])).toBeTruthy();
    expect(screen.getByText(t["canvas.empty"])).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t["canvas.createCta"] }),
    ).toBeTruthy();
  });

  it("labels the side panel and the three tabs", () => {
    render(<HwpEditor locale={locale} engine={createMockEngine()} file={null} />);
    expect(screen.getByLabelText(t["side.panelAria"])).toBeTruthy();
    for (const key of ["tabs.para", "tabs.table", "tabs.fields"] as const) {
      expect(screen.getByRole("tab", { name: t[key] })).toBeTruthy();
    }
  });

  it("renders the whole chrome from the active table in one mounted pass", () => {
    // One mount, one locale: toolbar, tabs and every empty state must agree
    // with the SAME table — a partially-translated render is the failure
    // this catches that the per-area tests above cannot (I18N-08).
    render(<HwpEditor locale={locale} engine={createMockEngine()} file={null} />);

    // Toolbar
    expect(screen.getByLabelText(t["toolbar.toolsAria"])).toBeTruthy();
    expect(screen.getByRole("button", { name: t["toolbar.revert"] })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t["toolbar.newDocument"] }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: t["toolbar.applyWithCount"]({ count: 0 }),
      }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(t["toolbar.pendingEdits"]({ count: 0 })),
    ).toBeTruthy();

    // Side panel and its three tabs
    expect(screen.getByLabelText(t["side.panelAria"])).toBeTruthy();
    for (const key of ["tabs.para", "tabs.table", "tabs.fields"] as const) {
      expect(screen.getByRole("tab", { name: t[key] })).toBeTruthy();
    }

    // Empty states: the canvas and the default paragraph panel
    expect(screen.getByLabelText(t["canvas.aria"])).toBeTruthy();
    expect(screen.getByText(t["canvas.empty"])).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t["canvas.createCta"] }),
    ).toBeTruthy();
    expect(screen.getByText(t["segment.hint"])).toBeTruthy();

    // Nothing from the other table leaked into this render.
    const other = locale === "en" ? ko : en;
    expect(screen.queryByText(other["canvas.empty"])).toBeNull();
    expect(screen.queryByText(other["segment.hint"])).toBeNull();
    expect(screen.queryByText(other["toolbar.revert"])).toBeNull();
  });

  it("prefixes a load failure with error.prefix.load", async () => {
    const engine = createMockEngine();
    engine.read = async () => {
      throw new Error("hwp-engine HTTP 500: boom");
    };
    render(<HwpEditor locale={locale} engine={engine} file={file} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`${t["error.prefix.load"]}: `);
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
