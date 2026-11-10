import { expect, test } from "@playwright/test";
import { en } from "@hwp-editor/react";

test("AC4: auto-built slots/native fields preview, apply, undo and official lint", async ({ page }) => {
  await page.goto("/editor");
  await page.getByLabel("fixture", { exact: true }).selectOption("template-demo.hwpx");
  await expect(page.getByRole("button", { name: en["page.label"]({ page: 1 }), exact: true })).toBeVisible();
  await page.getByRole("tab", { name: en["tabs.templates"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["templates.panelAria"], exact: true });
  await expect(panel.getByLabel("document_no", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("approval", { exact: true })).toBeVisible();
  // Fill every discovered input through its rendered form, including required
  // label/value form cells. The two explicit values prove slots and native fields.
  for (const input of await panel.locator('input[type="text"]').all()) {
    const id = await input.getAttribute("id") ?? "";
    await input.fill(id.endsWith("document_no") ? "2026-101" : id.endsWith("approval") ? "승인 완료" : "입력값");
  }
  const fillResponse = page.waitForResponse(response => response.url().endsWith("/fill"));
  await panel.getByRole("button", { name: en["templates.previewFill"], exact: true }).click();
  expect((await fillResponse).ok()).toBe(true);
  await expect(panel.getByLabel(en["templates.previewAria"], { exact: true })).toBeVisible();
  const revert = page.getByRole("button", { name: en["toolbar.revert"], exact: true });
  await expect(revert).toBeDisabled();

  const appliedRead = page.waitForResponse(response => response.url().endsWith("/read"));
  await panel.getByRole("button", { name: en["templates.apply"], exact: true }).click();
  const applied = await (await appliedRead).json();
  expect(applied.markdown).toContain("2026-101");
  expect(applied.markdown).toContain("승인 완료");
  expect(applied.markdown).not.toContain("{{document_no}}");
  await expect(revert).toBeEnabled();

  const undoneRead = page.waitForResponse(response => response.url().endsWith("/read"));
  await revert.click();
  const undone = await (await undoneRead).json();
  expect(undone.markdown).toContain("{{document_no}}");
  expect(undone.markdown).toContain("대기");
  await expect(revert).toBeDisabled();

  await page.getByLabel("fixture", { exact: true }).selectOption("official-demo.hwpx");
  await expect(page.locator(".hwped-title")).toHaveText("official-demo.hwpx");
  await page.getByRole("tab", { name: en["tabs.lint"], exact: true }).click();
  const lintResponse = page.waitForResponse(response => response.url().endsWith("/lint"));
  await page.getByRole("button", { name: en["lint.run"], exact: true }).click();
  const report = await (await lintResponse).json();
  expect(report.findings.filter((finding: { severity: string }) => finding.severity === "error")).toEqual([]);
  await expect(page.getByRole("region", { name: en["lint.panelAria"], exact: true })).toBeVisible();
});

test("embedded template picker works from an empty editor", async ({ page }) => {
  await page.route("**/fixtures/manifest.json", route => route.fulfill({ json: { fixtures: [] } }));
  await page.goto("/editor");
  await page.getByRole("button", { name: en["toolbar.newDocument"], exact: true }).click();
  const picker = page.getByRole("combobox", { name: en["templates.embeddedPicker"], exact: true });
  await expect(picker).toBeEnabled();
  await picker.selectOption("gongmun-basic");
  const created = page.waitForResponse(response => response.url().endsWith("/create"));
  await page.getByRole("button", { name: en["templates.createEmbedded"], exact: true }).click();
  expect((await created).ok()).toBe(true);
  await expect(page.getByRole("button", { name: en["page.label"]({ page: 1 }), exact: true })).toBeVisible();
  await page.getByRole("tab", { name: en["tabs.templates"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["templates.panelAria"], exact: true });
  await expect(panel.locator('input[type="text"]').first()).toBeVisible();
});
