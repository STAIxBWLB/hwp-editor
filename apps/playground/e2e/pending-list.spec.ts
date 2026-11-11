import { expect, test } from "@playwright/test";
import { en } from "@hwp-editor/react";

test("a large pending queue scrolls without hiding the editor", async ({ page }) => {
  await page.goto("/editor");
  await page.getByLabel("fixture").selectOption("table-demo.hwpx");
  const pageView = page.getByRole("button", {
    name: en["page.label"]({ page: 1 }), exact: true,
  });
  await expect(pageView).toBeVisible();
  const box = await pageView.boundingBox();
  if (box === null) throw new Error("page has no box");
  await pageView.click({ position: { x: box.width / 2, y: 20 } });
  await page.getByLabel(en["segment.bold"], { exact: true }).check();
  const format = page.getByRole("button", { name: en["segment.formatSubmit"], exact: true });
  for (let index = 0; index < 30; index++) await format.click();

  const list = page.getByRole("list", { name: en["toolbar.pendingList"], exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(30);
  await expect(page.getByLabel(en["toolbar.pendingEdits"]({ count: 30 }), { exact: true }))
    .toHaveText(en["toolbar.pendingEdits"]({ count: 30 }));
  const dimensions = await list.evaluate((element) => ({
    height: element.clientHeight, contentHeight: element.scrollHeight,
  }));
  expect(dimensions.height).toBeGreaterThan(0);
  expect(dimensions.height).toBeLessThanOrEqual(120);
  expect(dimensions.contentHeight).toBeGreaterThan(dimensions.height);
  expect(await page.locator(".hwped-main").evaluate((element) => element.clientHeight))
    .toBeGreaterThan(100);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await list.getByRole("button", { name: en["toolbar.removePending"]({ index: 30 }), exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(29);
  await page.getByRole("button", { name: en["toolbar.clearPending"], exact: true }).click();
  await expect(list).toHaveCount(0);

});
