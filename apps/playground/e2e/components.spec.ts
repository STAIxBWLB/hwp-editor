/**
 * WP4 components palette and assembly, end to end against the real binary.
 *
 * AC8 — an insertion lands beside the selected paragraph. The proof is the
 * request that left the browser AND the markdown the engine wrote back: the
 * op is `insert_blocks` addressed to the selected paragraph's id with the
 * component's styles alongside, and the re-read document holds the approval
 * box between the paragraph it was inserted after and the table that was
 * already below it.
 *
 * AC9 — a composed document keeps the assembly's order and its param values.
 * The compose request body is the artifact (the spec the panel built), and the
 * document the editor then opens proves the engine accepted it.
 *
 * Chrome selectors come from the `en` table, never inline literals; the Korean
 * strings that remain are document content and component data, which no UI
 * locale translates.
 */
import { expect, test } from "@playwright/test";
import type { Page, Response } from "@playwright/test";
import { en } from "@hwp-editor/react";

/** One op as the browser sends it: the repo's addressed union, keyed by `kind`. */
interface SentOp {
  kind: string;
  position?: string;
  address?: { id?: string };
  styles?: Record<string, unknown>;
  blocks?: { type: string }[];
}

/**
 * Read the `ops` field out of a captured multipart `/edit` body.
 *
 * The browser posts the addressed union (`kind`, camelCase fields) and the
 * server package is what turns it into the binary's edit-ops-v1 JSON, so this
 * parses the client's own contract rather than the CLI's.
 */
function editOps(body: string): SentOp[] {
  const match = body.match(/name="ops"\r?\n\r?\n([^\r\n]+)/);
  if (match === null) throw new Error("edit request omitted its ops field");
  return JSON.parse(match[1]!) as SentOp[];
}

/** Capture the bodies of the `/edit` requests the page sends. */
async function recordEdits(page: Page): Promise<string[]> {
  const bodies: string[] = [];
  await page.route("**/api/hwp-editor/edit", async (route) => {
    const body = route.request().postData();
    if (body !== null) bodies.push(body);
    await route.continue();
  });
  return bodies;
}

test("AC8: a component inserted after the selected paragraph is rendered there", async ({ page }) => {
  const edits = await recordEdits(page);
  await page.goto("/editor");

  await page.getByLabel("fixture", { exact: true }).selectOption("table-demo.hwpx");
  const pageView = page.getByRole("button", { name: en["page.label"]({ page: 1 }), exact: true });
  await expect(pageView).toBeVisible({ timeout: 30_000 });

  // The heading is the document's first paragraph; clicking the top of the
  // page selects it, which is the address the insertion must carry.
  const box = await pageView.boundingBox();
  if (box === null) throw new Error("page has no box");
  await pageView.click({ position: { x: box.width / 2, y: 20 } });
  await expect(page.locator(".hwped-quote")).toHaveText(/표 편집 데모/);

  await page.getByRole("tab", { name: en["tabs.components"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["components.panelAria"], exact: true });
  const name = "결재란";
  const reRead = page.waitForResponse((response) => response.url().endsWith("/read"));
  await panel.getByRole("button", { name: en["components.insert"]({ name }), exact: true }).click();
  const edited = (await (await reRead).json()) as { markdown: string };

  expect(edits).toHaveLength(1);
  const [op] = editOps(edits[0]!);
  expect(op!.kind).toBe("insert-blocks");
  expect(op!.position).toBe("after");
  // A paragraph id: 16 hex checksum, then the section and paragraph indices.
  // The heading is paragraph 1, not 0: a section's first paragraph is its
  // definition paragraph, which no insertion may precede.
  expect(op!.address?.id).toMatch(/^[0-9a-f]{16}\.0\.1$/);
  // The component's own style travels with the op; the target's styles win,
  // so it is the engine that decides how the box is drawn.
  expect(Object.keys(op!.styles ?? {})).toContain("결재란 셀");
  expect(op!.blocks?.[0]?.type).toBe("table");

  const heading = edited.markdown.indexOf("표 편집 데모");
  const approval = edited.markdown.indexOf("기안자");
  const table = edited.markdown.indexOf("사과");
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(approval).toBeGreaterThan(heading);
  expect(table).toBeGreaterThan(approval);

  // The row exists because the report named the paragraph it created.
  await expect(
    panel.getByRole("button", { name: en["components.remove"]({ name }), exact: true }),
  ).toBeVisible();
  await expect(page.locator(".hwped").getByRole("alert")).toHaveCount(0);
});

test("AC9: a document composed from the assembly keeps its order and params", async ({ page }) => {
  // An empty library leaves the editor's new-document entry in place.
  await page.route("**/fixtures/manifest.json", (route) => route.fulfill({ json: { fixtures: [] } }));
  const bodies: string[] = [];
  await page.route("**/api/hwp-editor/compose", async (route) => {
    const body = route.request().postData();
    if (body !== null) bodies.push(body);
    await route.continue();
  });
  await page.goto("/editor");

  await page.getByRole("button", { name: en["canvas.createCta"], exact: true }).click();
  const dialog = page.getByRole("dialog", { name: en["compose.title"], exact: true });
  const picker = dialog.getByLabel(en["compose.componentPicker"], { exact: true });
  const add = dialog.getByRole("button", { name: en["compose.addComponent"], exact: true });

  await picker.selectOption("결재란");
  await add.click();
  await picker.selectOption("붙임");
  await add.click();

  // Both order controls move a row; the list ends where it started.
  const up = dialog.getByRole("button", { name: en["components.moveUp"]({ name: "붙임" }), exact: true });
  const down = dialog.getByRole("button", { name: en["components.moveDown"]({ name: "붙임" }), exact: true });
  await up.click();
  await down.click();

  await dialog
    .getByLabel(en["compose.paramAria"]({ component: "결재란", param: "기안자" }), { exact: true })
    .fill("김기안");
  await dialog.getByLabel(en["compose.titleLabel"], { exact: true }).fill("구성 문서");

  const reRead = page.waitForResponse((response: Response) => response.url().endsWith("/read"));
  await dialog.getByRole("button", { name: en["compose.submit"], exact: true }).click();
  const opened = (await (await reRead).json()) as { markdown: string };

  expect(bodies).toHaveLength(1);
  const request = JSON.parse(bodies[0]!) as {
    name: string;
    spec: { document: { metadata?: { title?: string }; sections: { blocks: { type: string }[] }[] } };
  };
  expect(request.name).toBe("구성 문서.hwpx");
  expect(request.spec.document.metadata?.title).toBe("구성 문서");
  const blocks = request.spec.document.sections[0]!.blocks;
  // The approval box is one table; the attachment list is four paragraphs.
  expect(blocks.map((block) => block.type)).toEqual([
    "table",
    "paragraph",
    "paragraph",
    "paragraph",
    "paragraph",
  ]);
  expect(JSON.stringify(blocks[0])).toContain("김기안");

  // The binary accepted the spec: the composed document reads back in the
  // assembly's order, with the param value filled in.
  const approval = opened.markdown.indexOf("김기안");
  const attachment = opened.markdown.indexOf("붙임 1. 관련 자료 1부.");
  expect(approval).toBeGreaterThanOrEqual(0);
  expect(attachment).toBeGreaterThan(approval);
  await expect(page.getByRole("button", { name: en["page.label"]({ page: 1 }), exact: true })).toBeVisible({
    timeout: 30_000,
  });
});
