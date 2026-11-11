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
  // The palette fills the component's params, so the document gets the value
  // the user typed and never the `{{param}}` placeholder.
  await panel
    .getByLabel(en["components.paramLabel"]({ name, param: "기안자" }), { exact: true })
    .fill("김기안");
  const reRead = page.waitForResponse((response) => response.url().endsWith("/read"));
  const insert = panel.getByRole("button", { name: en["components.insert"]({ name }), exact: true });
  await insert.click();
  const edited = (await (await reRead).json()) as { markdown: string };

  expect(edits).toHaveLength(1);
  const [op] = editOps(edits[0]!);
  expect(op!.kind).toBe("insert-blocks");
  expect(op!.position).toBe("after");
  // A paragraph id: 16 hex checksum, then the section and paragraph indices.
  // The heading is paragraph 1, not 0: a section's first paragraph is its
  // definition paragraph, which no insertion may precede.
  expect(op!.address?.id).toMatch(/^[0-9a-f]{16}\.0\.1$/);
  // The styles travel with the op: the component's own cell style plus the
  // profile style it is based on, which a bare target need not define. The
  // target's definitions win where both name one (#428 contract).
  expect(Object.keys(op!.styles ?? {})).toContain("결재란 셀");
  expect(Object.keys(op!.styles ?? {})).toContain("바탕글");
  expect(op!.blocks?.[0]?.type).toBe("table");
  // No placeholder reached the engine, and the value the user typed did.
  expect(JSON.stringify(op!.blocks)).not.toContain("{{");
  expect(JSON.stringify(op!.blocks)).toContain("김기안");

  const heading = edited.markdown.indexOf("표 편집 데모");
  const approval = edited.markdown.indexOf("김기안");
  const table = edited.markdown.indexOf("사과");
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(approval).toBeGreaterThan(heading);
  expect(table).toBeGreaterThan(approval);

  // An insertion owns the document until the re-read lands, and the palette's
  // own button is disabled for exactly that span, so it is the signal that the
  // paragraphs the report named are the selection now.
  await expect(insert).toBeEnabled();

  // The paragraphs the report named are the selection, so the editor points at
  // what the insertion created instead of the paragraph it was sent. The box is
  // a table, and its host paragraph carries the cell text, so the quote reads
  // the inserted box and not the heading the click selected.
  await page.getByRole("tab", { name: en["tabs.para"], exact: true }).click();
  const inspected = page.getByRole("region", { name: en["segment.panelAria"], exact: true });
  await expect(inspected.locator(".hwped-quote")).toContainText("김기안");
  await expect(inspected.locator(".hwped-quote")).not.toContainText("표 편집 데모");
  await expect(inspected.locator('[aria-selected="true"]').first()).toBeVisible();

  // Reorder acts on that selection through the addressed control: the inserted
  // paragraph moves up with `move-para`, addressed to paragraph 2 of section 0
  // (the slot the insertion filled), so no row list survives it and no id can
  // go stale.
  const moved = page.waitForResponse((response) => response.url().endsWith("/read"));
  await inspected.getByRole("button", { name: en["segment.moveUp"], exact: true }).click();
  await page.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }), exact: true }).click();
  await moved;
  expect(editOps(edits[1]!)[0]!.kind).toBe("move-para");
  expect(editOps(edits[1]!)[0]!.address?.id).toMatch(/^[0-9a-f]{16}\.0\.2$/);

  // An applied edit clears the selection, so the paragraph the move wrote is
  // selected again from the panel's own paragraph list (an empty selection is
  // how the landed replacement shows), and removed with its own `delete-para`
  // addressed to that paragraph.
  await expect(inspected.getByRole("listbox").locator('[aria-selected="true"]')).toHaveCount(0);
  await inspected.getByRole("option", { name: /기안 \| 검토/ }).click();
  // The side panel follows a selection to the tab its text belongs to, and a
  // table's paragraph reads as table markdown, so the paragraph controls that
  // address it are one tab click away.
  await expect(page.getByRole("tab", { name: en["tabs.table"], exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: en["tabs.para"], exact: true }).click();
  const removed = page.waitForResponse((response) => response.url().endsWith("/read"));
  await inspected.getByRole("button", { name: en["segment.deletePara"], exact: true }).click();
  await page.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }), exact: true }).click();
  const afterRemove = (await (await removed).json()) as { markdown: string };
  expect(editOps(edits[2]!)[0]!.kind).toBe("delete-para");
  expect(afterRemove.markdown).not.toContain("김기안");
  await expect(page.locator(".hwped").getByRole("alert")).toHaveCount(0);
});

/**
 * AC8 for a component that is more than one paragraph.
 *
 * Six of the seven starters insert several paragraphs, and the selection a
 * report names is then a run rather than a single paragraph. The controls must
 * act on the run: one `move-para` of the neighbouring paragraph across the
 * whole block, and one addressed `delete-para` per paragraph in a single
 * batch, which is still one engine call and one undo.
 */
test("AC8: a multi-paragraph component is inserted, moved as a block, and deleted", async ({ page }) => {
  const edits = await recordEdits(page);
  await page.goto("/editor");

  await page.getByLabel("fixture", { exact: true }).selectOption("table-demo.hwpx");
  const pageView = page.getByRole("button", { name: en["page.label"]({ page: 1 }), exact: true });
  await expect(pageView).toBeVisible({ timeout: 30_000 });
  const box = await pageView.boundingBox();
  if (box === null) throw new Error("page has no box");
  await pageView.click({ position: { x: box.width / 2, y: 20 } });
  await expect(page.locator(".hwped-quote")).toHaveText(/표 편집 데모/);

  await page.getByRole("tab", { name: en["tabs.components"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["components.panelAria"], exact: true });
  const name = "붙임";
  const insert = panel.getByRole("button", { name: en["components.insert"]({ name }), exact: true });
  const reRead = page.waitForResponse((response) => response.url().endsWith("/read"));
  await insert.click();
  const edited = (await (await reRead).json()) as { markdown: string };

  expect(edits).toHaveLength(1);
  const [op] = editOps(edits[0]!);
  expect(op!.kind).toBe("insert-blocks");
  // Four paragraph blocks, no table. The fourth param is empty by default, so
  // the engine places an empty paragraph it cannot name in the report; the
  // three named ones are what the palette can address.
  expect(op!.blocks?.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph"]);
  const heading = edited.markdown.indexOf("표 편집 데모");
  const attachment = edited.markdown.indexOf("붙임 1. 관련 자료 1부.");
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(attachment).toBeGreaterThan(heading);

  // The inserted paragraphs are the selection, so the block moves from the
  // paragraph controls with a single op.
  await expect(insert).toBeEnabled();
  await page.getByRole("tab", { name: en["tabs.para"], exact: true }).click();
  const inspected = page.getByRole("region", { name: en["segment.panelAria"], exact: true });
  await expect(inspected.locator(".hwped-quote")).toContainText("붙임");
  const moved = page.waitForResponse((response) => response.url().endsWith("/read"));
  await inspected.getByRole("button", { name: en["segment.moveUp"], exact: true }).click();
  await page.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }), exact: true }).click();
  const afterMove = (await (await moved).json()) as { markdown: string };
  const move = editOps(edits[1]!);
  expect(move).toHaveLength(1);
  expect(move[0]!.kind).toBe("move-para");
  // The block stayed a block: every attachment line is now above the heading
  // the component was inserted after.
  expect(afterMove.markdown.indexOf("붙임 1. 관련 자료 1부.")).toBeLessThan(
    afterMove.markdown.indexOf("표 편집 데모"),
  );

  // An applied edit clears the selection, so the run is picked again from the
  // paragraph list: the first attachment paragraph through the last one the
  // report named.
  await expect(inspected.getByRole("listbox").locator('[aria-selected="true"]')).toHaveCount(0);
  await inspected.getByRole("option", { name: /Paragraph \d+: 붙임$/ }).click();
  await inspected
    .getByRole("option", { name: /Paragraph \d+: 붙임 2\. 세부 일정 1부\.$/ })
    .click({ modifiers: ["Shift"] });
  await expect(inspected.locator(".hwped-quote")).toContainText("붙임");

  // Delete acts on the run: one addressed delete per named paragraph, in one
  // batch, so the engine sees one call and undo sees one step.
  const removed = page.waitForResponse((response) => response.url().endsWith("/read"));
  await inspected.getByRole("button", { name: en["segment.deletePara"], exact: true }).click();
  await page.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 3 }), exact: true }).click();
  const afterRemove = (await (await removed).json()) as { markdown: string };
  const deletes = editOps(edits[2]!);
  expect(deletes).toHaveLength(3);
  expect(deletes.every((sent) => sent.kind === "delete-para")).toBe(true);
  expect(new Set(deletes.map((sent) => sent.address?.id)).size).toBe(3);
  expect(afterRemove.markdown).not.toContain("붙임 1. 관련 자료 1부.");
  expect(afterRemove.markdown).not.toContain("붙임 2. 세부 일정 1부.");
  expect(afterRemove.markdown).toContain("표 편집 데모");
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
