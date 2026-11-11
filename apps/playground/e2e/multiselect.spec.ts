import { expect, test, type Page, type Response } from "@playwright/test";
import { en } from "@hwp-editor/react";
import { segmentText, type CatEnvelope, type EditOp } from "@hwp-editor/core";

function readResponse(response: Response): boolean {
  return response.url().endsWith("/read") && response.ok();
}

/** The ops a POST /edit carried. `page.on("request")` reports no body, a route does. */
function editOps(body: string): EditOp[] {
  const match = body.match(/name="ops"\r?\n\r?\n([^\r\n]+)/);
  if (!match) throw new Error("edit request omitted its ops field");
  return JSON.parse(match[1]!) as EditOp[];
}

/** Record the /edit bodies a test causes, and let every one through. */
async function recordEdits(page: Page): Promise<string[]> {
  const bodies: string[] = [];
  await page.route("**/api/hwp-editor/edit", async route => {
    const body = route.request().postData();
    if (body !== null) bodies.push(body);
    await route.continue();
  });
  return bodies;
}

/**
 * Select `[start, end)` of the run-range field in UTF-16 units.
 *
 * A headless Chromium readonly textarea moves no caret on Shift+Arrow (a bare
 * probe textarea behaves the same), so the selection is applied directly and
 * announced with the events a real selection emits: the document-level
 * `selectionchange` React listens to, the field's own `select`, and the
 * `keyup` the arrow press would have produced.
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
  await page.getByLabel("fixture", {exact:true}).selectOption("z-selection-demo.hwpx");
  const envelope = await (await loaded).json() as CatEnvelope;
  await expect(page.getByRole("listbox",{name:en["segment.paragraphChoices"]}).getByRole("option")).toHaveCount(5);
  return envelope;
}

test("AC3: five selected paragraphs use one edit request and one undo restores all", async ({page}) => {
  const before = await loadSelectionFixture(page);
  const bodies = await recordEdits(page);
  const list = page.getByRole("listbox",{name:en["segment.paragraphChoices"]});
  await list.getByRole("option").nth(0).click();
  await list.getByRole("option").nth(4).click({modifiers:["Shift"]});
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(5);
  await page.getByLabel(en["segment.paraShapeValueAria"],{exact:true}).fill("200");
  await page.getByRole("button",{name:en["segment.setPara"],exact:true}).click();
  const applied = page.waitForResponse(readResponse);
  await page.getByRole("button",{name:en["toolbar.applyWithCount"]({count:5}),exact:true}).click();
  const after = await (await applied).json() as CatEnvelope;
  await expect(page.getByRole("status",{name:en["validation.aria"],exact:true})).toHaveText(en["validation.valid"]);
  expect(bodies).toHaveLength(1);
  const ops=editOps(bodies[0]!);
  expect(ops).toHaveLength(5);
  expect(ops.every(op=>op.kind==="set-para" && "address" in op && op.value==="200%")).toBe(true);
  expect(new Set(ops.map(op=>"address" in op ? op.address.id : undefined)))
    .toEqual(new Set(before.segments.filter(segment=>segment.kind==="para").map(segment=>segment.id)));
  expect(after.segments.filter(segment=>segment.kind==="para").map(segment=>segment.directPara?.line_spacing)).toEqual([200,200,200,200,200]);
  const undone=page.waitForResponse(readResponse);
  await page.getByRole("button",{name:en["toolbar.revert"],exact:true}).click();
  const restored=await (await undone).json() as CatEnvelope;
  expect(restored.markdown).toBe(before.markdown);
  expect(restored.segments.filter(segment=>segment.kind==="para").map(segment=>segment.directPara))
    .toEqual(before.segments.filter(segment=>segment.kind==="para").map(segment=>segment.directPara));
  expect(bodies).toHaveLength(1);
});

/**
 * #46 AC2: bolding part of a phrase that occurs twice changes only the selected
 * occurrence.
 *
 * The selection here is three characters of the first occurrence, which is
 * what AC2 asks. Under the 2026-11-09 address decision a sub-run selection
 * snaps to the whole run it sits in (sub-run characters wait for
 * hwp-cli#517), so the op carries the run and no `chars`; the assertion that
 * decides AC2 is the last one: the two occurrences read bold and not bold.
 */
test("AC2: a range over a repeated phrase changes only the selected occurrence", async ({page}) => {
  const before = await loadSelectionFixture(page);
  const bodies = await recordEdits(page);
  const list=page.getByRole("listbox",{name:en["segment.paragraphChoices"]});
  await list.getByRole("option").nth(0).click();
  await selectRunRange(page, 0, 3);
  await expect(page.getByText(en["segment.rangeRunCount"]({count:1}),{exact:true})).toBeVisible();
  await page.getByLabel(en["segment.bold"],{exact:true}).check();
  await page.getByRole("button",{name:en["segment.formatSubmit"],exact:true}).click();
  const applied=page.waitForResponse(readResponse);
  await page.getByRole("button",{name:en["toolbar.applyWithCount"]({count:1}),exact:true}).click();
  expect(bodies).toHaveLength(1);
  const ops=editOps(bodies[0]!);
  const firstRun=before.segments.find(segment=>segment.kind==="run")!;
  expect(ops).toEqual([{kind:"set-format",address:{id:firstRun.id},props:{bold:"on"}}]);
  const op=ops[0]!;
  expect("address" in op && "chars" in op.address).toBe(false);
  const after=await (await applied).json() as CatEnvelope;
  const repeated=after.segments.filter(segment=>segment.kind==="run" && segmentText(after,segment).includes("동일문"));
  expect(repeated).toHaveLength(2);
  expect(repeated.map(segment=>segment.directChar?.bold)).toEqual([true,false]);
});
