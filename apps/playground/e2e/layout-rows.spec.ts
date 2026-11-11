import { expect, test } from "@playwright/test";
import type { CatEnvelope, RenderResponse } from "@hwp-editor/core";
import { en } from "@hwp-editor/react";

/**
 * #46 AC1: on a multi-page fixture, clicking any rendered row selects the
 * segment whose layout row contains the click.
 *
 * Every measured row is clicked, on both pages, and the selection is checked
 * against the segment the row names rather than against the click point, so a
 * row that maps to the wrong segment fails even where two rows overlap.
 */
test("AC1: every measured row on a multi-page fixture selects its source segment", async ({ page }) => {
  await page.goto("/editor");
  await expect(page.getByRole("button", { name: en["page.label"]({ page: 1 }), exact: true })).toBeVisible();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/hwp-editor/render") &&
    response.request().method() === "POST");
  await page.getByLabel("fixture").selectOption("z-layout-demo.hwpx");
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const rendered = await response.json() as RenderResponse;
  expect(rendered.pages.length).toBeGreaterThan(1);
  const fixture = await page.request.get("/fixtures/z-layout-demo.hwpx");
  const read = await page.request.post("/api/hwp-editor/read", { multipart: { file: {
    name: "z-layout-demo.hwpx", mimeType: "application/octet-stream", buffer: await fixture.body(),
  } } });
  expect(read.ok()).toBe(true);
  const envelope = await read.json() as CatEnvelope;
  let checked = 0;
  for (const image of rendered.pages) {
    const layout = image.layout!;
    expect(layout).toBeDefined();
    expect(layout.truncated).toBe(false);
    const view = page.getByRole("button", { name: en["page.label"]({ page: image.page }), exact: true });
    await expect(view).toBeVisible();
    for (const row of layout.rows) {
      if (row.box === null) continue;
      const segment = envelope.segments.find((candidate) => candidate.id === row.id);
      expect(segment, row.id).toBeDefined();
      // This fixture has only paragraphs, with no competing containing table.
      expect(row.kind).toBe("para");
      const box = row.box;
      const x = (box.x0 + box.x1) / 2 / layout.width_pt;
      const y = (box.y0 + box.y1) / 2 / layout.height_pt;
      await view.scrollIntoViewIfNeeded();
      const rect = await view.boundingBox();
      if (rect === null) throw new Error("missing rendered page rectangle");
      await view.click({ position: { x: x * rect.width, y: y * rect.height } });
      await expect(page.locator(".hwped-quote")).toHaveText(envelope.markdown.slice(segment!.start, segment!.end).trim());
      const band = view.locator(".hwped-band-selected");
      await expect(band).toHaveCount(layout.rows.filter((candidate) => candidate.id === row.id && candidate.box !== null).length);
      // Overlay and click use the same point-to-viewport transform.
      const overlay = await band.first().boundingBox();
      const after = await view.boundingBox();
      expect(overlay).not.toBeNull();
      expect(Math.abs(overlay!.y - after!.y - box.y0 / layout.height_pt * after!.height)).toBeLessThan(2);
      checked++;
    }
  }
  expect(checked).toBeGreaterThanOrEqual(12);
});
