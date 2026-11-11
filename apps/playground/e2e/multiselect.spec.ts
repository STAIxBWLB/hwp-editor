import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { en } from "@hwp-editor/react";
import { segmentText, type CatEnvelope, type EditOp } from "@hwp-editor/core";

function readResponse(response: Response): boolean {
  return response.url().endsWith("/read") && response.ok();
}
function editOps(request: Request): EditOp[] {
  const match = request.postDataBuffer()?.toString("utf8").match(/name="ops"\r?\n\r?\n([^\r\n]+)/);
  if (!match) throw new Error("edit request omitted its ops field");
  return JSON.parse(match[1]!) as EditOp[];
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
  const list = page.getByRole("listbox",{name:en["segment.paragraphChoices"]});
  await list.getByRole("option").nth(0).click();
  await list.getByRole("option").nth(4).click({modifiers:["Shift"]});
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(5);
  await page.getByLabel(en["segment.paraShapeValueAria"],{exact:true}).fill("200");
  await page.getByRole("button",{name:en["segment.setPara"],exact:true}).click();
  const requests: Request[] = [];
  page.on("request",request=>{if(request.url().endsWith("/edit") && request.method()==="POST")requests.push(request);});
  const applied = page.waitForResponse(readResponse);
  await page.getByRole("button",{name:en["toolbar.applyWithCount"]({count:5}),exact:true}).click();
  const after = await (await applied).json() as CatEnvelope;
  await expect(page.getByRole("status",{name:en["validation.aria"],exact:true})).toHaveText(en["validation.valid"]);
  expect(requests).toHaveLength(1);
  const ops=editOps(requests[0]!);
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
  expect(requests).toHaveLength(1);
});

test("Inspector range snaps to one whole run without changing a repeated phrase", async ({page}) => {
  const before = await loadSelectionFixture(page);
  const list=page.getByRole("listbox",{name:en["segment.paragraphChoices"]});
  await list.getByRole("option").nth(0).click();
  const range=page.getByLabel(en["segment.rangeTextAria"],{exact:true});
  await range.focus();
  await range.evaluate(element=>(element as HTMLTextAreaElement).setSelectionRange(0,0));
  for(let index=0;index<3;index++)await range.press("Shift+ArrowRight");
  await expect(page.getByText(en["segment.rangeRunCount"]({count:1}),{exact:true})).toBeVisible();
  await page.getByLabel(en["segment.bold"],{exact:true}).check();
  await page.getByRole("button",{name:en["segment.formatSubmit"],exact:true}).click();
  const request=page.waitForRequest(request=>request.url().endsWith("/edit"));
  const applied=page.waitForResponse(readResponse);
  await page.getByRole("button",{name:en["toolbar.applyWithCount"]({count:1}),exact:true}).click();
  const ops=editOps(await request);
  const firstRun=before.segments.find(segment=>segment.kind==="run")!;
  expect(ops).toEqual([{kind:"set-format",address:{id:firstRun.id},props:{bold:"on"}}]);
  const op=ops[0]!;
  expect("address" in op && "chars" in op.address).toBe(false);
  const after=await (await applied).json() as CatEnvelope;
  const repeated=after.segments.filter(segment=>segment.kind==="run" && segmentText(after,segment).includes("동일문"));
  expect(repeated).toHaveLength(2);
  expect(repeated.map(segment=>segment.directChar?.bold)).toEqual([true,false]);
});
