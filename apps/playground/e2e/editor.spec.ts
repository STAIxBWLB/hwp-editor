import { expect, test } from "@playwright/test";
import { en } from "@hwp-editor/react";

/**
 * Full loop against the real hwp binary: load a seeded fixture, select a
 * paragraph segment, queue a replace op, apply, and expect a re-render plus
 * a clean validate badge.
 *
 * Chrome selectors derive from the `en` table imported from the package
 * entry point, never from inline English literals: a copy change to a
 * message value moves the selector with it instead of leaving a stale one
 * behind. `en` and not `ko` because the harness at
 * `apps/playground/app/editor/page.tsx` deliberately mounts `<HwpEditor>`
 * with NO `locale` prop, which makes this suite the repository's only
 * end-to-end proof that the shipped default locale is English. Pinning the
 * harness to `locale="ko"` would make it permanently immune to exactly the
 * default-locale regression that broke this file once already.
 *
 * Every chrome selector passes `exact: true` so a match is whole-string
 * equality against the literal the component rendered — that is what keeps
 * `"Apply"` and `"Apply format"` from colliding with `"Apply (1)"` under
 * Playwright strict mode.
 *
 * The Korean literals that remain are document CONTENT (the fixture's own
 * paragraph text and the value typed into the replace field), which no UI
 * locale translates.
 */
test("fixture → select segment → replace → apply → re-render + valid", async ({
  page,
}) => {
  await page.goto("/editor");

  await page.getByLabel("fixture").selectOption("table-demo.hwpx");

  // The document loads: page 1 rendered, validate badge clean.
  const pageView = page.getByRole("button", {
    name: en["page.label"]({ page: 1 }),
    exact: true,
  });
  await expect(pageView).toBeVisible({ timeout: 30_000 });
  const badge = page.getByRole("status", {
    name: en["validation.aria"],
    exact: true,
  });
  await expect(badge).toHaveText(en["validation.valid"]);
  const svgBefore = await page.locator(".hwped-page-svg").first().innerHTML();

  // Click near the top of the page: selects the heading paragraph.
  const box = await pageView.boundingBox();
  if (box === null) throw new Error("page has no box");
  await pageView.click({ position: { x: box.width / 2, y: 20 } });
  await expect(page.locator(".hwped-quote")).toHaveText(/표 편집 데모/);

  // Queue a replace op and apply it.
  await page
    .getByLabel(en["segment.replaceLabel"], { exact: true })
    .fill("표 편집 데모 — 셀이 바뀌었습니다.");
  await page
    .getByRole("button", { name: en["segment.replaceSubmit"], exact: true })
    .click();

  // The pending count's accessible name IS its text: HwpEditor feeds the same
  // `toolbar.pendingEdits` value to the span's aria-label and to its content.
  // Locating by the name and then asserting the text pins that collapse
  // deliberately — re-splitting the two would fail here rather than silently.
  const pendingOne = en["toolbar.pendingEdits"]({ count: 1 });
  await expect(page.getByLabel(pendingOne, { exact: true })).toHaveText(
    pendingOne,
  );

  await page
    .getByRole("button", {
      name: en["toolbar.applyWithCount"]({ count: 1 }),
      exact: true,
    })
    .click();
  const pendingNone = en["toolbar.pendingEdits"]({ count: 0 });
  await expect(page.getByLabel(pendingNone, { exact: true })).toHaveText(
    pendingNone,
    { timeout: 30_000 },
  );

  // Re-rendered: the page SVG changed, validation is still clean, no alerts.
  await expect
    .poll(async () => page.locator(".hwped-page-svg").first().innerHTML(), {
      timeout: 30_000,
    })
    .not.toBe(svgBefore);
  await expect(badge).toHaveText(en["validation.valid"]);
  // No error alerts inside the editor (Next's route-announcer is also an alert).
  await expect(page.locator(".hwped").getByRole("alert")).toHaveCount(0);
});
