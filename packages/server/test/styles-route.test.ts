/**
 * The `/styles` route and the preset's place in the edit body (issue #53,
 * WP3/T5).
 *
 * Stub-engine shape tests: they pin what crosses the wire — the projected
 * table, the capability advertisement, and a preset travelling as an op
 * inside the one `ops` field with `report` and `allowPartial` beside it — and
 * leave the engine behaviour to `styles.test.ts`, which needs the binary.
 */
import { describe, expect, it } from "vitest";

import { createHttpEngine } from "@hwp-editor/core";
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
  /**
   * t12-a1. The preset is an op, and this drives the CLIENT the playground
   * uses against this route: a preset that travelled as its own form field was
   * dropped by `http-engine`'s edit, so the switch failed on every HTTP host
   * while the desktop path worked. A hand-built multipart body cannot see
   * that — only the client's own request can.
   */
  it("carries a client's preset op in one batch, asking for the report and a partial apply", async () => {
    let seen: EditOp[] | undefined;
    let reportFlag: string | null = null;
    let partialFlag: string | null = null;
    const engine = stubEngine({
      async edit(document, ops) {
        seen = ops;
        // The engine answers the report the client asked for: for a preset
        // batch its verdict IS the outcome (core style-batch.ts), and one
        // op applied with a piece touched is a batch that really landed.
        return {
          name: document.name,
          data: new Uint8Array([9]),
          report: {
            schema_version: "1.0",
            contract: "hwp-edit-report-v1",
            output: "x.hwpx",
            dry_run: false,
            ops: [
              { index: 0, op: "update_style", status: "applied", pieces_touched: 1, changed: [], reason: null },
              { index: 1, op: "style_tables", status: "applied", pieces_touched: 1, changed: [], reason: null },
            ],
            applied_count: 2,
            failed_count: 0,
          },
        };
      },
    });
    const handler = createHwpEditorHandler({ engine, sessions: false });
    const client = createHttpEngine(BASE, {
      // The transport, not the client: the client builds the multipart body,
      // and this encodes it the way a socket would, because the route refuses
      // a request that declares no Content-Length. Faking that header over the
      // client's own FormData keeps the request shape honest.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const form = init?.body;
        if (!(form instanceof FormData)) return handler(new Request(url, init));
        if (form.has("ops")) {
          reportFlag = form.get("report") as string | null;
          partialFlag = form.get("allowPartial") as string | null;
        }
        const encoded = new Response(form);
        const body = await encoded.arrayBuffer();
        const headers = new Headers();
        headers.set("content-type", encoded.headers.get("content-type") ?? "multipart/form-data");
        headers.set("content-length", String(body.byteLength));
        return handler(new Request(url, { method: "POST", headers, body }));
      }) as typeof fetch,
    });

    await client.edit(DOC, [
      { kind: "update-style", style: "body", size: "15" },
      { kind: "style-tables", preset: "official" },
    ]);

    expect(seen).toEqual([
      { kind: "update-style", style: "body", size: "15" },
      { kind: "style-tables", preset: "official" },
    ]);
    // The preset's outcome is only visible in the report, so the request has
    // to ask for one even though this caller did not; and without a partial
    // apply the engine aborts the whole batch on a document with no table.
    expect(reportFlag).toBe("true");
    expect(partialFlag).toBe("true");
  });

  it("refuses an unknown preset", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const unknown = await handler(multipartRequest(`${BASE}/edit`, {
      file: DOC,
      ops: JSON.stringify([{ kind: "style-tables", preset: "fancy" }]),
    }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.message).toContain("official");
  });

  it("requires ops: a preset is not a field of its own", async () => {
    const handler = createHwpEditorHandler({ engine: stubEngine(), sessions: false });
    const res = await handler(multipartRequest(`${BASE}/edit`, { file: DOC }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("ops");
  });
});
