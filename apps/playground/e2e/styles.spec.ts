/**
 * WP3 named styles, end to end through the HTTP host (issue #53, AC6 and AC7).
 *
 * The server suite proves the engine's half against the binary directly, but
 * the editor talks to the binary through `/edit` and `/styles`, and that path
 * is where a preset sent as its own form field was dropped: the switch failed
 * on every HTTP host while the desktop path worked. This drives the browser.
 *
 * AC6 — one body-style size change moves every body paragraph in the render,
 * leaves the directly formatted run as it was, and is one undo entry. The proof
 * is the request the page sent (a single `update-style`), the `/read` envelope
 * the editor then works from (both inheriting paragraphs report the new size,
 * the direct run keeps its 20pt at its own level), and the render bytes, which
 * move.
 *
 * AC7 — the same preset twice is byte-identical. The `/edit` answers carry the
 * edited document, so the two answers are compared byte for byte rather than
 * through a proxy like the render.
 *
 * Chrome selectors come from the `en` table; the Korean strings here are
 * document content, which no UI locale translates.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { en } from "@hwp-editor/react";
import { DOCUMENT_PROFILES } from "@hwp-editor/core";

/** One op as the browser sends it: the repo's union, keyed by `kind`. */
interface SentOp {
  kind: string;
  /** A style reference: the row id for a style the document defines, else a name. */
  style?: string | number;
  size?: string;
  preset?: string;
}

interface StyleRow {
  id: number;
  name: string;
  used_by: string[];
  attrs: { char?: { size_pt?: number }; para?: { line_spacing?: number } };
}

interface TableShape {
  styles: StyleRow[];
}

/**
 * Read the `ops` field out of a captured multipart `/edit` body. The browser
 * posts the client's own union and the server package turns it into the
 * binary's edit-ops-v1 JSON, so this parses the client's contract.
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

interface EnvelopeSegment {
  kind: string;
  id?: string;
  style?: { char?: { size_pt?: number }; para?: unknown };
  direct?: { char?: { size_pt?: number } };
}

/** Open a styles fixture and wait for its first page. */
async function openStylesDemo(page: Page, fixture = "styles-demo.hwpx"): Promise<void> {
  await page.goto("/editor");
  await page.getByLabel("fixture", { exact: true }).selectOption(fixture);
  await expect(page.getByRole("button", { name: en["page.label"]({ page: 1 }), exact: true }))
    .toBeVisible({ timeout: 30_000 });
}

/** The body paragraph's own style row, which `compose` names `body`. */
function bodyRow(page: Page) {
  // The list also carries the engine's seven defaults (바탕글, 개요 1-6), so
  // the row is matched by its name rather than by position.
  return page.getByRole("button", { name: /^body/ });
}

test("AC6: a body-style size change moves every body paragraph and leaves direct formatting alone", async ({ page }) => {
  const edits = await recordEdits(page);
  // The render is the half of AC6 a bytes comparison can show: capturing both
  // answers means the assertion reads what the host drew, not what we assumed.
  const renders: Buffer[] = [];
  page.on("response", (response) => {
    if (!response.url().endsWith("/render")) return;
    void response.body().then((body) => renders.push(body)).catch(() => undefined);
  });

  // The table the editor read for this document names the row the panel
  // queues against, and the paragraphs that inherit it.
  const loadedStyles = page.waitForResponse((response) => response.url().endsWith("/styles"));
  await openStylesDemo(page);
  const loaded = (await (await loadedStyles).json()) as TableShape;
  const bodyId = loaded.styles.find((row) => row.name === "body")!.id;
  // The load itself renders the page; that answer is AC6's "before".
  await expect.poll(() => renders.length).toBeGreaterThan(0);
  const beforeRender = renders[renders.length - 1]!;

  await page.getByRole("tab", { name: en["tabs.styles"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["tabs.styles"], exact: true });
  // The rows only exist once the tab is open: the panel is what reads the
  // table the editor loaded for this document.
  await expect(bodyRow(page)).toBeVisible();
  await bodyRow(page).click();

  // The form is seeded from the style itself: 12pt, the size the fixture's
  // body row carries. Changing it to 14 keeps it distinct from the heading
  // style's 15pt, so "every body paragraph moved" cannot be satisfied by the
  // heading.
  const size = panel.getByLabel(en["styles.size"], { exact: true });
  await expect(size).toHaveValue("12");
  await size.fill("14");

  const rendersBeforeApply = renders.length;
  const reRead = page.waitForResponse((response) => response.url().endsWith("/read"));
  const styleRead = page.waitForResponse((response) => response.url().endsWith("/styles"));
  await panel.getByRole("button", { name: en["styles.updateSubmit"], exact: true }).click();
  await page.getByRole("button", { name: en["toolbar.applyWithCount"]({ count: 1 }), exact: true }).click();

  // The request carries the size and nothing else: the untouched font, bold
  // and alignment are not re-sent, because each of them rewrites the style's
  // own definition when it crosses. Polled, because the recorder sees the
  // answer a beat after the click.
  await expect.poll(() => edits.length).toBe(1);
  expect(editOps(edits[0]!)).toEqual([{ kind: "update-style", style: bodyId, size: "14" }]);

  // The style table the editor was re-read from names the paragraphs that
  // inherit the style, and that join is what "every body paragraph moved"
  // means: a count of segments carrying a size would also take the run inside
  // a paragraph, which is not a paragraph.
  const table = (await (await styleRead).json()) as TableShape;
  const body = table.styles.find((row) => row.name === "body")!;
  expect(body.attrs.char?.size_pt).toBe(14);
  expect(body.used_by).toHaveLength(2);

  const envelope = (await (await reRead).json()) as { segments: EnvelopeSegment[] };
  const byId = new Map(envelope.segments.map((segment) => [segment.id, segment]));
  for (const id of body.used_by) {
    const segment = byId.get(id);
    expect(segment, `the envelope does not carry the paragraph ${id} its own style table names`).toBeDefined();
    expect(segment!.kind).toBe("para");
    expect(segment!.style?.char?.size_pt).toBe(14);
    // The paragraph's own level as well as the style it inherits: the style
    // level agrees with the row by construction, so only this one is the
    // document's own answer that the edit reached the paragraph.
    expect(segment!.direct?.char?.size_pt).toBe(14);
  }

  // The run whose size was set directly kept it, which is AC6's second clause,
  // and it is a run: it is not one of the paragraphs the style table listed.
  const direct = envelope.segments.filter((segment) => segment.direct?.char?.size_pt === 20);
  expect(direct).toHaveLength(1);
  expect(direct[0]!.style?.char?.size_pt).toBe(14);
  expect(body.used_by).not.toContain(direct[0]!.id);

  // And the render moved with the shapes.
  await expect.poll(() => renders.length).toBeGreaterThan(rendersBeforeApply);
  const afterRender = renders[renders.length - 1]!;
  expect(afterRender.equals(beforeRender)).toBe(false);

  // One replacement, one history entry: a single undo returns the 12pt render.
  const undo = page.getByRole("button", { name: en["toolbar.revert"], exact: true });
  await expect(undo).toBeEnabled();
  const restored = page.waitForResponse((response) => response.url().endsWith("/styles"));
  await undo.click();
  const restoredTable = (await (await restored).json()) as TableShape;
  expect(restoredTable.styles.find((row) => row.name === "body")?.attrs.char?.size_pt).toBe(12);
});

/**
 * t12-a2 on a document with nothing to style, through the browser.
 *
 * The engine's union suite cannot run in CI (it needs the binary), and this is
 * the case the flag form lost an edit on: `--style-tables` aborts the whole
 * call when no eligible table exists, so the body-style update went with it.
 * As one batch with `allowPartial` the style half lands and `style_tables`
 * reports itself unapplied — which the editor shows as a notice, not a
 * failure.
 */
test("AC2: a table-less document keeps the preset's style update and says what it could not style", async ({ page }) => {
  const edits = await recordEdits(page);
  const loadedStyles = page.waitForResponse((response) => response.url().endsWith("/styles"));
  await openStylesDemo(page, "styles-plain-demo.hwpx");
  const loaded = (await (await loadedStyles).json()) as TableShape;
  const body = loaded.styles.find((row) => row.name === "body")!;
  // The fixture's own body row, which is NOT the official profile's: that is
  // what makes the style half of the switch visible below.
  expect(body.attrs.char?.size_pt).toBe(11);

  await page.getByRole("tab", { name: en["tabs.styles"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["tabs.styles"], exact: true });
  const reReadStyles = page.waitForResponse((response) => response.url().endsWith("/styles"));
  await panel.getByRole("button", { name: en["styles.presetSubmit"], exact: true }).click();

  // The one batch carries both halves.
  await expect.poll(() => edits.length).toBe(1);
  expect(editOps(edits[0]!).map((op) => op.kind)).toEqual(["update-style", "style-tables"]);

  // The preset's own outcome is a notice about the document, and the edit
  // itself landed: no error line, and the style moved to the profile.
  await expect(page.getByText(en["styles.noTableToStyle"], { exact: true })).toBeVisible();
  const after = (await (await reReadStyles).json()) as TableShape;
  const restyled = after.styles.find((row) => row.name === "body")!;
  expect(restyled.attrs.char?.size_pt).toBe(DOCUMENT_PROFILES.official.bodySizePt);
  expect(restyled.attrs.para?.line_spacing).toBe(DOCUMENT_PROFILES.official.lineHeightPercent);

  // One replacement, so one undo step, even though the preset had nothing to
  // do: the style half is a real change.
  const undo = page.getByRole("button", { name: en["toolbar.revert"], exact: true });
  await expect(undo).toBeEnabled();
});

test("AC7: applying the same preset twice produces the same bytes", async ({ page }) => {
  const edits = await recordEdits(page);
  const loadedStyles = page.waitForResponse((response) => response.url().endsWith("/styles"));
  await openStylesDemo(page);
  const loaded = (await (await loadedStyles).json()) as TableShape;
  const bodyId = loaded.styles.find((row) => row.name === "body")!.id;
  await page.getByRole("tab", { name: en["tabs.styles"], exact: true }).click();
  const panel = page.getByRole("region", { name: en["tabs.styles"], exact: true });

  /** Press the preset switch and return the document the host answered with. */
  async function switchPreset(): Promise<Buffer> {
    const edited = page.waitForResponse((response) => response.url().endsWith("/edit"));
    await panel.getByRole("button", { name: en["styles.presetSubmit"], exact: true }).click();
    const body = (await (await edited).json()) as { dataBase64: string };
    return Buffer.from(body.dataBase64, "base64");
  }

  const once = await switchPreset();
  // The preset travels INSIDE the batch, beside the body-style update: that is
  // the field a client-side preset silently lost, and the reason this runs
  // through the browser at all.
  await expect.poll(() => edits.length).toBe(1);
  const first = editOps(edits[0]!);
  expect(first.some((op) => op.kind === "style-tables" && op.preset === "official")).toBe(true);
  // The body-style half addresses the row this document defines by its id, not
  // by its name: a styles-v1 name can be empty or shared between two rows.
  expect(first.some((op) => op.kind === "update-style" && op.style === bodyId)).toBe(true);

  const twice = await switchPreset();
  await expect.poll(() => edits.length).toBe(2);
  expect(editOps(edits[1]!).some((op) => op.kind === "style-tables")).toBe(true);
  expect(twice.equals(once)).toBe(true);
});
