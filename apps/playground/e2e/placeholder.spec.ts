import { expect, test, type Page, type Response } from "@playwright/test";
import { en } from "@hwp-editor/react";
import type { CatEnvelope } from "@hwp-editor/core";

function readResponse(response: Response): boolean {
  return response.url().endsWith("/read") && response.ok();
}

/**
 * Select `[start, end)` of the run-range field in UTF-16 units.
 *
 * Same protocol as multiselect.spec.ts: a headless Chromium readonly textarea
 * moves no caret on Shift+Arrow, so the selection is applied directly and
 * announced with the events a real selection emits.
 */
async function selectRunRange(page: Page, start: number, end: number): Promise<void> {
  await page.getByLabel(en["segment.rangeTextAria"], { exact: true }).evaluate((element, range) => {
    const field = element as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(range.start, range.end);
    field.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    field.dispatchEvent(new Event("select", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
  }, { start, end });
}

async function loadSelectionFixture(page: Page): Promise<CatEnvelope> {
  await page.goto("/editor");
  const loaded = page.waitForResponse(async response => readResponse(response) &&
    ((await response.json()) as CatEnvelope).markdown.includes("동일문"));
  await page.getByLabel("fixture", { exact: true }).selectOption("z-selection-demo.hwpx");
  const envelope = await (await loaded).json() as CatEnvelope;
  await expect(page.getByRole("listbox", { name: en["segment.paragraphChoices"] }).getByRole("option")).toHaveCount(5);
  return envelope;
}

test("AC5: a made placeholder round-trips the selected text through a fill", async ({ page }) => {
  await loadSelectionFixture(page);
  // Paragraph 1 is one run ("둘째 😀문단"), so the whole run is the selection and
  // the placeholder replaces exactly the text the user picked.
  const list = page.getByRole("listbox", { name: en["segment.paragraphChoices"] });
  await list.getByRole("option").nth(1).click();
  await selectRunRange(page, 0, 7);
  await expect(page.getByText(en["segment.rangeRunCount"]({ count: 1 }), { exact: true })).toBeVisible();
  await page.getByLabel(en["segment.placeholderNameAria"], { exact: true }).fill("owner");
  await page.getByRole("button", { name: en["segment.placeholderCreate"], exact: true }).click();
  const applied = page.waitForResponse(readResponse);
  await page.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }), exact: true }).click();
  const slotted = await (await applied).json() as CatEnvelope;
  expect(slotted.markdown).toContain("{{owner}}");
  expect(slotted.markdown).not.toContain("둘째 😀문단");

  // The new slot is what the Template panel offers without a reload path of
  // its own: it reads slots from the document the apply installed.
  await page.getByRole("tab", { name: en["tabs.templates"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["templates.panelAria"], exact: true });
  await panel.getByLabel("owner", { exact: true }).fill("김철수");
  const fillResponse = page.waitForResponse(response => response.url().endsWith("/fill"));
  await panel.getByRole("button", { name: en["templates.previewFill"], exact: true }).click();
  expect((await fillResponse).ok()).toBe(true);
  const filledRead = page.waitForResponse(readResponse);
  await panel.getByRole("button", { name: en["templates.apply"], exact: true }).click();
  const filled = await (await filledRead).json() as CatEnvelope;
  expect(filled.markdown).toContain("김철수");
  expect(filled.markdown).not.toContain("{{owner}}");
});

test("a range whose text repeats in the paragraph cannot become a placeholder", async ({ page }) => {
  await loadSelectionFixture(page);
  const list = page.getByRole("listbox", { name: en["segment.paragraphChoices"] });
  await list.getByRole("option").nth(0).click();
  // Run 0 reads 동일문, which the paragraph carries twice: the addressed
  // replace would rewrite both, so the control has to stay off.
  await selectRunRange(page, 0, 3);
  await expect(page.getByText(en["segment.rangeRunCount"]({ count: 1 }), { exact: true })).toBeVisible();
  await page.getByLabel(en["segment.placeholderNameAria"], { exact: true }).fill("owner");
  await expect(page.getByText(en["segment.placeholderAmbiguous"], { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: en["segment.placeholderCreate"], exact: true })).toBeDisabled();
});
