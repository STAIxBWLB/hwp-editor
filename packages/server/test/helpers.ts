import { existsSync } from "node:fs";

import { describe } from "vitest";

/**
 * The 0.8.7 debug binary (PATH carries 0.8.6, which is too old for
 * edit/compose --report/render --report). HWP_EDITOR_BIN overrides.
 */
export const DEBUG_BIN = "/Users/yj.lee/workspace/work/dev/hwp-cli/target/debug/hwp";

export const BIN = process.env.HWP_EDITOR_BIN ?? DEBUG_BIN;

export const HAS_BIN = existsSync(BIN);

if (!HAS_BIN) {
  console.warn(
    `[hwp-editor/server tests] hwp-cli 0.8.7 binary not found at ${BIN} — ` +
      "real-binary integration tests are skipped. Build hwp-cli or set HWP_EDITOR_BIN.",
  );
}

/** describe block that skips with a clear message when the binary is absent. */
export const describeBin = HAS_BIN
  ? describe
  : (name: string, fn: () => void) =>
      describe.skip(`${name} [skipped: no hwp-cli 0.8.7 binary at ${BIN}]`, fn);

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

export function multipartRequest(
  url: string,
  fields: { file?: { name: string; data: Uint8Array }; [key: string]: unknown },
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (key === "file") continue;
    if (typeof value === "string") form.append(key, value);
  }
  if (fields.file !== undefined) {
    form.append("file", new Blob([fields.file.data as BlobPart]), fields.file.name);
  }
  return new Request(url, { method: "POST", body: form });
}
