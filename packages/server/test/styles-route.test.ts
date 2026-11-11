/**
 * The `/styles` route and the preset edit field (issue #53, WP3/T5).
 *
 * Stub-engine shape tests: they pin what crosses the wire — the projected
 * table, the capability advertisement and the `styleTables` form field — and
 * leave the engine behaviour to `styles.test.ts`, which needs the binary.
 */
import { describe, expect, it } from "vitest";

import type { DocumentHandle, EditOp, EditOptions, HwpEngine, StyleTable } from "@hwp-editor/core";

import { createHwpEditorHandler } from "../src/routes.js";
import { hwpxBytes, multipartRequest } from "./helpers.js";

const DOC: DocumentHandle = { name: "sample.hwpx", data: hwpxBytes() };

const ATTRS = {
  char: {
    bold: false,
    italic: false,
    size_pt: 12,
    color: "#000000",
    faces: ["함초롬바탕", null, null, null, null, null, null],
    face_ids: [1, 0, 0, 0, 0, 0, 0],
  },
  para: { alignment: "justify", indent: 0, line_spacing: 160, line_spacing_type: 0 },
  // `StyleAttrs` is the PROJECTED shape: the wire's `char_shape_id` has
  // already become `charShapeId` by the time the route answers.
  charShapeId: 0,
  paraShapeId: 0,
};

const TABLE: StyleTable = {
  version: "1.0",
  styles: [
    { id: 0, name: "바탕글", english_name: "Normal", kind: "paragraph", next_style: 0, attrs: ATTRS, used_by: ["p1"] },
  ],
};

function stubEngine(overrides: Partial<HwpEngine> = {}): HwpEngine {
  return {
    async read() {
      return { markdown: "# hi", segments: [] };
    },
    async edit(document: DocumentHandle, _ops: EditOp[], _options?: EditOptions) {
      return { name: document.name, data: new Uint8Array([9]) };
    },
    async render() {
      return [];
    },
    async compose(_spec, name: string) {
      return { document: { name, data: new Uint8Array([7]) } };
    },
    async validate() {
      return { valid: true, errors: [] };
    },
    async capabilities() {
      return { version: "1.4.0", editable: true, format: ["hwp"], formats: ["hwp", "hwpx"] } as never;
    },
    ...overrides,
  };
}

const BASE = "http://localhost/api/hwp-editor";

describe("styles route", () => {
  it("returns the projected table and re-validates it on the way out", async () => {
    const engine = stubEngine({
      async capabilities() {
        return { version: "1.6.1", editable: true, styles: "v1" as const, formats: ["hwp", "hwpx"] };
      },
      async styles() {
        return TABLE;
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/styles`, { file: DOC }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TABLE);
  });

  it("advertises styles only when the binary is at the floor AND the engine answers the method", async () => {
    const withoutMethod = createHwpEditorHandler({
      engine: stubEngine({
        async capabilities() {
          return { version: "1.6.1", editable: true, styles: "v1" as const, formats: ["hwp"] };
        },
      }),
      sessions: false,
    });
    const noMethod = await (await withoutMethod(new Request(`${BASE}/capabilities`))).json();
    expect(noMethod.styles).toBeUndefined();

    const belowFloor = createHwpEditorHandler({
      engine: stubEngine({
        async capabilities() {
          return { version: "1.3.1", editable: true, styles: "v1" as const, formats: ["hwp"] };
        },
        async styles() {
          return TABLE;
        },
      }),
      sessions: false,
    });
    const old = await (await belowFloor(new Request(`${BASE}/capabilities`))).json();
    expect(old.styles).toBeUndefined();
  });

  it("refuses the route when the engine does not answer styles", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(multipartRequest(`${BASE}/styles`, { file: DOC }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("unavailable");
  });
});

describe("edit with a preset", () => {
  it("passes styleTables through and sends no ops", async () => {
    let seen: { ops: EditOp[]; options: EditOptions | undefined } | undefined;
    const engine = stubEngine({
      async edit(document, ops, options) {
        seen = { ops, options };
        return { name: document.name, data: new Uint8Array([9]) };
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, styleTables: "report" }));
    expect(res.status).toBe(200);
    expect(seen?.ops).toEqual([]);
    expect(seen?.options?.styleTables).toBe("report");
  });

  it("refuses an unknown preset and a preset beside ops", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const unknown = await handler(multipartRequest(`${BASE}/edit`, { file: DOC, styleTables: "fancy" }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.message).toContain("official");

    const both = await handler(multipartRequest(`${BASE}/edit`, {
      file: DOC,
      styleTables: "official",
      ops: JSON.stringify([{ kind: "update-style", style: "바탕글", size: "13" }]),
    }));
    expect(both.status).toBe(400);
    expect((await both.json()).error.message).toContain("either");
  });
});
