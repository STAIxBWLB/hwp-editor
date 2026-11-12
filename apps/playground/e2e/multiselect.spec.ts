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
 * #46 AC2 as written: bolding three characters inside a longer run that occurs
 * twice changes only the selected occurrence and only the selected characters.
 *
 * The first occurrence is the six-character run "동일문 안내", and the e2e
 * selects its first three characters. hwp-cli 1.6.1 publishes `source_chars`
 * on run segments (schema 1.1, agent-hwp#517), so the op addresses the run with
 * the half-open source window `chars: [0, 3]` instead of snapping to the whole
 * run, and the untouched " 안내" and the second occurrence prove the window
 * landed where it was asked.
 */
test("AC2: three characters inside a longer run are bolded, the rest and the other occurrence unchanged", async ({page}) => {
  const before = await loadSelectionFixture(page);
  const firstRun=before.segments.find(segment=>segment.kind==="run")!;
  expect(segmentText(before,firstRun)).toBe("동일문 안내");
  expect(firstRun.sourceChars).toEqual({start:0,end:6});
  const bodies = await recordEdits(page);
  const list=page.getByRole("listbox",{name:en["segment.paragraphChoices"]});
  await list.getByRole("option").nth(0).click();
  await selectRunRange(page, 0, 3);
  await expect(page.getByText(en["segment.rangeRunCount"]({count:1}),{exact:true})).toBeVisible();
  // A mapped window is not a whole-run target, so the row does not say it is.
  await expect(page.getByText(en["segment.rangeWholeRunTargets"]({count:1}),{exact:true})).toHaveCount(0);
  await page.getByLabel(en["segment.bold"],{exact:true}).check();
  await page.getByRole("button",{name:en["segment.formatSubmit"],exact:true}).click();
  const applied=page.waitForResponse(readResponse);
  await page.getByRole("button",{name:en["toolbar.applyWithCount"]({count:1}),exact:true}).click();
  expect(bodies).toHaveLength(1);
  const ops=editOps(bodies[0]!);
  expect(ops).toEqual([{kind:"set-format",address:{id:firstRun.id,chars:[0,3]},props:{bold:"on"}}]);
  const after=await (await applied).json() as CatEnvelope;
  // The engine wraps a formatted run in its markers, so compare the text a
  // reader sees: the bolded run is now the phrase alone, the rest of the
  // source run follows unbolded, and the italic occurrence is untouched.
  const visible=(segment:CatEnvelope["segments"][number])=>
    segmentText(after,segment)
      .replace(/\*\*([\s\S]+?)\*\*/u,"$1")
      .replace(/\*([\s\S]+?)\*/u,"$1");
  const inParagraph=after.segments.filter(segment=>segment.kind==="run" &&
    segment.section===firstRun.section && segment.para===firstRun.para);
  expect(inParagraph.filter(segment=>segment.directChar?.bold).map(visible)).toEqual(["동일문"," / "]);
  expect(inParagraph.filter(segment=>!segment.directChar?.bold).map(visible)).toEqual([" 안내","동일문"]);
  expect(inParagraph.filter(segment=>visible(segment)==="동일문").map(segment=>segment.directChar?.italic))
    .toEqual([false,true]);
});

/**
 * AC2 again on the format that stores its paragraph break: a `.hwp` paragraph
 * keeps the break as its last character, so ahwp 1.6.1 publishes the first
 * paragraph's only run as `(0, 7)` for the six characters it shows. Reading
 * the window back has to accept that one unit, or every partial selection in a
 * paragraph's last run - most paragraphs of a real `.hwp` - would be refused.
 */
test("AC2 on .hwp: a sub-run window lands in a paragraph's last run", async ({page}) => {
  await page.goto("/editor");
  const loaded = page.waitForResponse(async response => readResponse(response) &&
    ((await response.json()) as CatEnvelope).markdown.includes("동일문 다른"));
  await page.getByLabel("fixture",{exact:true}).selectOption("z-subrun-demo.hwp");
  const before = await (await loaded).json() as CatEnvelope;
  const firstRun=before.segments.find(segment=>segment.kind==="run")!;
  expect(segmentText(before,firstRun)).toBe("동일문 안내");
  expect(firstRun.sourceChars).toEqual({start:0,end:7});
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
  expect(ops).toEqual([{kind:"set-format",address:{id:firstRun.id,chars:[0,3]},props:{bold:"on"}}]);
  const after=await (await applied).json() as CatEnvelope;
  const visible=(segment:CatEnvelope["segments"][number])=>
    segmentText(after,segment)
      .replace(/\*\*([\s\S]+?)\*\*/u,"$1")
      .replace(/\*([\s\S]+?)\*/u,"$1");
  const runs=after.segments.filter(segment=>segment.kind==="run");
  expect(runs.filter(segment=>segment.directChar?.bold).map(visible)).toEqual(["동일문"]);
  expect(runs.filter(segment=>!segment.directChar?.bold).map(visible)).toEqual([" 안내","동일문 다른 문단"]);
});

/**
 * AC2 against the failure the second review round measured: the first head
 * took a drag that reached only a formatted run's opening marker and widened
 * it to the whole run, and the engine's answer shows what that did - a bare
 * id formats every character of the run, so `*동일문*` became `***동일문***`
 * and the OTHER occurrence of the word was reformatted too. A piece that shows
 * nothing the selection covers now names no target at all.
 */
test("AC2: a drag that stops on the italic marker names no target for that run", async ({page}) => {
  const before = await loadSelectionFixture(page);
  const italic = before.segments.find(segment=>segment.kind==="run" && segment.directChar?.italic)!;
  expect(segmentText(before, italic)).toBe("*동일문*");
  const bodies = await recordEdits(page);
  const list = page.getByRole("listbox",{name:en["segment.paragraphChoices"]});
  await list.getByRole("option").nth(0).click();
  // The drag reaches the run through its opening `*` and no further.
  await selectRunRange(page, italic.start, italic.start + 1);
  await expect(page.getByText(en["segment.rangeInvalid"],{exact:true})).toBeVisible();
  await expect(page.getByText(en["segment.rangeRunCount"]({count:1}),{exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:en["toolbar.applyWithCount"]({count:1}),exact:true})).toHaveCount(0);
  expect(bodies).toHaveLength(0);
});

/**
 * The same selection against a schema `1.0` envelope: it carries no
 * `source_chars`, because the field's presence is the feature gate. The range
 * then keeps the pre-#71 behavior and names the whole run, rather than
 * inventing a window from markdown offsets the host never published.
 */
test("AC2 fallback: an envelope without source_chars formats the whole run", async ({page}) => {
  await page.route("**/api/hwp-editor/read", async route => {
    const response = await route.fetch();
    const body = await response.json() as CatEnvelope;
    for (const segment of body.segments) delete (segment as {sourceChars?: unknown}).sourceChars;
    await route.fulfill({ response, json: body });
  });
  const before = await loadSelectionFixture(page);
  const firstRun=before.segments.find(segment=>segment.kind==="run")!;
  expect(firstRun.sourceChars).toBeUndefined();
  expect(segmentText(before,firstRun)).toBe("동일문 안내");
  const bodies = await recordEdits(page);
  const list=page.getByRole("listbox",{name:en["segment.paragraphChoices"]});
  await list.getByRole("option").nth(0).click();
  await selectRunRange(page, 0, 3);
  await expect(page.getByText(en["segment.rangeRunCount"]({count:1}),{exact:true})).toBeVisible();
  // A target with no source window is named as the whole run in the pending
  // row, so the widening is visible before the op is queued.
  await expect(page.getByText(en["segment.rangeWholeRunTargets"]({count:1}),{exact:true})).toBeVisible();
  await page.getByLabel(en["segment.bold"],{exact:true}).check();
  await page.getByRole("button",{name:en["segment.formatSubmit"],exact:true}).click();
  await page.getByRole("button",{name:en["toolbar.applyWithCount"]({count:1}),exact:true}).click();
  expect(bodies).toHaveLength(1);
  expect(editOps(bodies[0]!)).toEqual([{kind:"set-format",address:{id:firstRun.id},props:{bold:"on"}}]);
});
