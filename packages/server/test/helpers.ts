import { existsSync } from "node:fs";

import { describe } from "vitest";

/**
 * The 0.8.8 debug binary (PATH carries 0.8.6, which is too old for
 * edit/compose --report/render --report). HWP_EDITOR_BIN overrides.
 */
export const DEBUG_BIN = "/Users/yj.lee/workspace/work/dev/hwp-cli/target/debug/hwp";

export const BIN = process.env.HWP_EDITOR_BIN ?? DEBUG_BIN;

export const HAS_BIN = existsSync(BIN);

if (!HAS_BIN) {
  console.warn(
    `[hwp-editor/server tests] hwp-cli 0.8.8 binary not found at ${BIN} — ` +
      "real-binary integration tests are skipped. Build hwp-cli or set HWP_EDITOR_BIN.",
  );
}

/** describe block that skips with a clear message when the binary is absent. */
export const describeBin = HAS_BIN
  ? describe
  : (name: string, fn: () => void) =>
      describe.skip(`${name} [skipped: no hwp-cli 0.8.8 binary at ${BIN}]`, fn);

/** DocumentSpec v2 fixture: one replaceable paragraph + one 2x2 table. */
export function sampleSpec() {
  return {
    version: "2.0",
    document: {
      version: "1.0",
      sections: [
        {
          blocks: [
            {
              type: "paragraph",
              runs: [{ type: "text", text: "안녕하세요, hwp-editor 통합 테스트 문서입니다." }],
            },
            {
              type: "table",
              columns: [{ width_mm: 60 }, { width_mm: 60 }],
              rows: [
                {
                  cells: [
                    { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "A1" }] }] },
                    { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "B1" }] }] },
                  ],
                },
                {
                  cells: [
                    { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "A2" }] }] },
                    { blocks: [{ type: "paragraph", runs: [{ type: "text", text: "B2" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  } as const;
}

let boundarySeq = 0;

/**
 * Multipart POST carrying an explicit Content-Length.
 *
 * The body is assembled by hand rather than through `FormData` because
 * `new Request(url, { body: form })` sets no `content-length` — the real
 * fetch transport adds it at send time, and the routes.ts admission gate
 * requires it (measured: a live `fetch` of the same FormData sends the
 * header, an in-process Request does not). A `Blob` exposes `.size`
 * synchronously, so the declared length is exact.
 */
export function multipartRequest(
  url: string,
  fields: { file?: { name: string; data: Uint8Array }; [key: string]: unknown },
): Request {
  const boundary = `----hwpEditorTest${(boundarySeq++).toString(16).padStart(8, "0")}`;
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const text = (s: string) => parts.push(encoder.encode(s));
  for (const [key, value] of Object.entries(fields)) {
    if (key === "file" || typeof value !== "string") continue;
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  if (fields.file !== undefined) {
    text(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="${fields.file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    parts.push(fields.file.data as BlobPart);
    text("\r\n");
  }
  text(`--${boundary}--\r\n`);
  const body = new Blob(parts);
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.size),
    },
  });
}

/** JSON POST carrying an explicit Content-Length, for the compose route. */
export function jsonRequest(url: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}
