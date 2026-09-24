import { expect, test } from "@playwright/test";
import { en } from "@hwp-editor/react";

/**
 * jpeg and webp renders against the real hwp binary — the one engine surface
 * no existing UI path requests, so it gets the only new spec in this change.
 *
 * Structural analog of editor.spec.ts: the same seeded fixture, loaded the
 * same way through the editor page, and the render requested through the
 * same API route the UI's own engine calls. The assertion checks the
 * response is a valid image of the requested format, the way editor.spec.ts
 * checks its re-render output is valid markup: magic bytes for the
 * container, plus strictly positive dimensions, which is what proves the
 * engine parsed real renderer output rather than passing bytes through.
 */
test("fixture renders as jpeg and as webp, each a valid image of its format", async ({
  page,
  request,
}) => {
  await page.goto("/editor");

  await page.getByLabel("fixture").selectOption("table-demo.hwpx");
  await expect(
    page.getByRole("button", {
      name: en["page.label"]({ page: 1 }),
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });

  const fixtureBytes = await (
    await request.get("/fixtures/table-demo.hwpx")
  ).body();

  const render = async (format: "jpeg" | "webp") => {
    const res = await request.post("/api/hwp-editor/render", {
      multipart: {
        file: {
          name: "table-demo.hwpx",
          mimeType: "application/octet-stream",
          buffer: fixtureBytes,
        },
        format,
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      pages: { page: number; width: number; height: number; format: string; dataBase64: string }[];
    };
    expect(body.pages.length).toBeGreaterThan(0);
    return body.pages;
  };

  const jpeg = await render("jpeg");
  for (const p of jpeg) {
    expect(p.format).toBe("jpeg");
    const bytes = Buffer.from(p.dataBase64, "base64");
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]); // JPEG SOI
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
  }

  const webp = await render("webp");
  for (const p of webp) {
    expect(p.format).toBe("webp");
    const bytes = Buffer.from(p.dataBase64, "base64");
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
  }
});
