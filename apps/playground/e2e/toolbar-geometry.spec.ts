import { expect, test } from "@playwright/test";
import { ko } from "@hwp-editor/react";
import { LONG_REASON, SHORT_REASON } from "../app/toolbar-geometry/reasons.js";

/**
 * G-03-1 regression: with a long engine `capabilities().reason`, the toolbar
 * must stay one row. Before the fix, `.hwped-badge`, `.hwped-count` and
 * `.hwped-btn` kept the initial `flex-shrink: 1`, absorbed shrinkage that only
 * `.hwped-title` and `.hwped-notice` should absorb, and collapsed the row into
 * a 103px vertical stack at `locale="ko"`.
 *
 * The assertions are GEOMETRIC because nothing else can see the defect: jsdom
 * has no layout, and every text assertion still passes while the row is
 * stacked — the strings are all present, just on four lines instead of one.
 *
 * `ko` here, `en` in `editor.spec.ts`: the Korean min-content width is roughly
 * one glyph, which is what makes the collapse extreme, and `editor.spec.ts`
 * stays the repository's only default-locale (en) proof. The chrome string
 * still comes from the exported `ko` table, never an inline literal, and the
 * two reason strings are imported from the harness module for the same reason.
 */
test("long ko engine reason keeps the toolbar in one row", async ({ page }) => {
  // 900px is inside the band G-03-1 was measured failing (420-1200px) but
  // clear of 420px, where the toolbar already collapsed with a SHORT reason —
  // the short sample has to be a valid single-row baseline.
  await page.setViewportSize({ width: 900, height: 720 });
  await page.goto("/toolbar-geometry");

  const notice = page.getByRole("note");
  await expect(notice).toHaveAttribute("title", SHORT_REASON, {
    timeout: 30_000,
  });
  await expect(notice).toContainText(ko["toolbar.readOnly"]);

  const short = await page.locator(".hwped-toolbar").boundingBox();
  if (short === null) throw new Error("toolbar has no box (short reason)");

  await page.getByLabel("long-reason").click();
  // The title flip is the signal the new engine's capabilities landed;
  // measuring before it is a race.
  await expect(notice).toHaveAttribute("title", LONG_REASON);

  const long = await page.locator(".hwped-toolbar").boundingBox();
  if (long === null) throw new Error("toolbar has no box (long reason)");

  // A long reason costs the toolbar no height...
  expect(long.height).toBeCloseTo(short.height, 0);
  // ...and that height is one row. The row is ~40px (6+6 padding, 1px border,
  // ~26px control); 56 is comfortably above one row and far below the
  // 67px/103px pre-fix stack. Absolute, because the first assertion alone
  // passes if BOTH samples inflate.
  expect(long.height).toBeLessThan(56);

  // Pinning items non-shrinkable must not trade a vertical stack for
  // horizontal overflow.
  const overflow = await page
    .locator(".hwped-root")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBe(0);

  // The notice is still the one element absorbing the overflow, on one line.
  const noticeLines = await notice.evaluate((el) => el.getClientRects().length);
  expect(noticeLines).toBe(1);
});
