import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHttpEngine } from "../src/http-engine.js";
import { createTauriEngine, type TauriInvoke } from "../src/tauri.js";
import { parseCatEnvelope, segmentText } from "../src/segments.js";

const doc = { name: "metadata.hwpx", data: new Uint8Array([1]) };
const fixture = parseCatEnvelope(readFileSync(new URL("./fixtures/cat-segments-basic.json", import.meta.url), "utf8"));
const segment = { kind: "para", id: "para", section: 0, para: 0, start: 0, end: 2 };
const transports = [
  ["HTTP", (raw: unknown) => createHttpEngine("/api", { fetch: (async () => new Response(JSON.stringify(raw))) as typeof fetch })],
  ["Tauri", (raw: unknown) => createTauriEngine((async <T>() => raw as T) as TauriInvoke)],
] as const;

describe.each(transports)("%s selection metadata", (_name, engineFor) => {
  it("preserves direct properties and scalar Markdown offsets", async () => {
    const raw = { markdown: "😀A", segments: [{ ...segment,
      directChar: fixture.segments[0]!.directChar,
      directPara: fixture.segments[0]!.directPara,
    }] };
    const envelope = await engineFor(raw).read(doc);
    expect(envelope.segments[0]!.start).toBe(0);
    expect(envelope.segments[0]!.end).toBe(2);
    expect(segmentText(envelope, envelope.segments[0]!)).toBe("😀A");
    expect(envelope.segments[0]!.directChar).toEqual(raw.segments[0]!.directChar);
  });
  it("keeps older hosts without optional formatting metadata usable", async () => {
    const raw = { markdown: "😀A", segments: [segment] };
    await expect(engineFor(raw).read(doc)).resolves.toEqual(raw);
  });
  it.each([
    { directChar: { ...fixture.segments[0]!.directChar, bold: "yes" }, field: "direct.char" },
    { directPara: { ...fixture.segments[0]!.directPara, line_spacing: "large" }, field: "direct.para" },
  ])("refuses malformed present $field before selection behavior", async ({ field, ...metadata }) => {
    const failure = engineFor({ markdown: "😀A", segments: [{ ...segment, ...metadata }] }).read(doc);
    await expect(failure).rejects.toThrow(field);
    await expect(failure).rejects.toThrow(/upgrade the host adapter/);
  });
});
