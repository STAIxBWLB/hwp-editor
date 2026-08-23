import { expect, test } from "@playwright/test";

/**
 * Full loop against the real hwp binary: load a seeded fixture, select a
 * paragraph segment, queue a replace op, apply, and expect a re-render plus
 * a clean validate badge.
 */
test("fixture → select segment → replace → apply → re-render + valid", async ({
  page,
}) => {
  await page.goto("/editor");

  await page.getByLabel("fixture").selectOption("table-demo.hwpx");

  // The document loads: page 1 rendered, validate badge clean.
  const pageView = page.getByRole("button", { name: "페이지 1" });
  await expect(pageView).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "검증 결과" })).toHaveText("유효");
  const svgBefore = await page.locator(".hwped-page-svg").first().innerHTML();

  // Click near the top of the page: selects the heading paragraph.
  const box = await pageView.boundingBox();
  if (box === null) throw new Error("page has no box");
  await pageView.click({ position: { x: box.width / 2, y: 20 } });
  await expect(page.locator(".hwped-quote")).toHaveText(/표 편집 데모/);

  // Queue a replace op and apply it.
  await page
    .getByLabel("텍스트 교체")
    .fill("표 편집 데모 — 셀이 바뀌었습니다.");
  await page.getByRole("button", { name: "교체", exact: true }).click();
  await expect(page.getByLabel("대기 중인 편집 수")).toHaveText("대기 편집 1");

  await page.getByRole("button", { name: "적용 (1)" }).click();
  await expect(page.getByLabel("대기 중인 편집 수")).toHaveText("대기 편집 0", {
    timeout: 30_000,
  });

  // Re-rendered: the page SVG changed, validation is still clean, no alerts.
  await expect
    .poll(async () => page.locator(".hwped-page-svg").first().innerHTML(), {
      timeout: 30_000,
    })
    .not.toBe(svgBefore);
  await expect(page.getByRole("status", { name: "검증 결과" })).toHaveText("유효");
  // No error alerts inside the editor (Next's route-announcer is also an alert).
  await expect(page.locator(".hwped").getByRole("alert")).toHaveCount(0);
});
