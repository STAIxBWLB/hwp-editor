/**
 * Component library tests. The shipped starter set is the format's first real
 * user, so it is validated here: a typo in one of the seven JSON files has to
 * fail in this package rather than in a host's palette.
 *
 * The compose suite runs the real `hwp` binary and skips when none is
 * runnable, exactly like `packages/server/test/helpers.ts` — hosted CI
 * provisions no hwp (D-04), so a missing binary must read as "skipped", never
 * as a green compose.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it, afterAll } from "vitest";

import {
  documentSpecFromComponents,
  loadComponents,
  OFFICIAL_PROFILE,
  STARTER_COMPONENTS,
  substituteParams,
  validateComponent,
} from "../src/components.js";
import type {
  Component,
  ComponentFetch,
  ComponentFetchResponse,
  ComponentIndex,
} from "../src/components.js";
import type { Blocks } from "../src/generated/document-spec-v2.js";

/** Which binary the real-binary suite runs against (mirrors the server's helper). */
const BIN =
  process.env.HWP_EDITOR_BIN?.trim() || process.env.HWP_CLI?.trim() || "hwp";

function runnable(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_BIN = BIN.includes(sep) ? existsSync(BIN) : runnable(BIN);

if (!HAS_BIN) {
  console.warn(
    `[hwp-editor/core tests] no runnable hwp binary at ${BIN} — the compose ` +
      "suite is skipped. Install hwp-cli, or set HWP_EDITOR_BIN / HWP_CLI.",
  );
}

const describeBin = HAS_BIN
  ? describe
  : (name: string, fn: () => void) =>
      describe.skip(`${name} [skipped: no runnable hwp binary at ${BIN}]`, fn);

const PROFILE_NAMES = ["바탕글", "개요 1", "개요 2", "개요 3", "개요 4", "개요 5", "개요 6"];

function textsOf(blocks: Blocks): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const run of block.runs) {
        if (run.type === "text") texts.push(run.text);
        if (run.type === "field" && run.value !== undefined) texts.push(run.value);
      }
    }
    if (block.type === "field" && block.value !== undefined) texts.push(block.value);
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (cell.blocks !== undefined) texts.push(...textsOf(cell.blocks));
        }
      }
    }
  }
  return texts;
}

function styleRefsOf(blocks: Blocks): string[] {
  const refs: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      if (block.style !== undefined) refs.push(block.style);
      for (const run of block.runs) {
        if ("style" in run && run.style !== undefined) refs.push(run.style);
      }
    }
    if (block.type === "field" && block.style !== undefined) refs.push(block.style);
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (cell.blocks !== undefined) refs.push(...styleRefsOf(cell.blocks));
        }
      }
    }
  }
  return refs;
}

function placeholdersIn(value: string): string[] {
  return Array.from(value.matchAll(/\{\{([^{}]*)\}\}/g), (match) => (match[1] ?? "").trim());
}

const starter = (name: string): Component => {
  const found = STARTER_COMPONENTS.find((component) => component.name === name);
  if (found === undefined) throw new Error(`no starter named ${name}`);
  return found;
};

const BASE_COMPONENT: Record<string, unknown> = {
  name: "시험",
  description: "시험용 구성요소",
  params: { 항목: "기본값" },
  blocks: [{ type: "paragraph", runs: [{ type: "text", text: "{{항목}}" }] }],
};

const REFUSAL_SOURCE = "src/components/broken.json";

describe("starter components", () => {
  it("ships the seven starters #54 names, in palette order", () => {
    expect(STARTER_COMPONENTS.map((component) => component.name)).toEqual([
      "결재란",
      "붙임",
      "두문",
      "개조식",
      "결문",
      "일정표",
      "요약표",
    ]);
  });

  it("survives a validate round trip unchanged", () => {
    for (const component of STARTER_COMPONENTS) {
      expect(validateComponent(component, component.name)).toEqual(component);
    }
  });

  it("declares every placeholder it uses, and uses every param it declares", () => {
    for (const component of STARTER_COMPONENTS) {
      const used = new Set(
        textsOf(component.blocks).flatMap((value) => placeholdersIn(value)),
      );
      expect([...used].sort()).toEqual(Object.keys(component.params).sort());
      for (const value of Object.values(component.params)) expect(typeof value).toBe("string");
    }
  });

  it("names only official profile styles, and defines only what the profile lacks", () => {
    for (const component of STARTER_COMPONENTS) {
      for (const [name, style] of Object.entries(component.styles ?? {})) {
        expect({ name, defined: PROFILE_NAMES.includes(name) }).toEqual({
          name,
          defined: false,
        });
        expect(PROFILE_NAMES).toContain(style.based_on);
      }
      for (const ref of styleRefsOf(component.blocks)) {
        const own = Object.hasOwn(component.styles ?? {}, ref);
        expect({ ref, resolved: own || PROFILE_NAMES.includes(ref) }).toEqual({
          ref,
          resolved: true,
        });
      }
    }
  });

  it("keeps ordered lists out of the starters (hwp-cli#472)", () => {
    for (const component of STARTER_COMPONENTS) {
      expect(JSON.stringify(component.blocks)).not.toContain('"list":');
    }
  });
});

describe("substituteParams", () => {
  it("fills the defaults and leaves no placeholder behind", () => {
    for (const component of STARTER_COMPONENTS) {
      const filled = substituteParams(component);
      expect(filled.params).toEqual(component.params);
      expect(textsOf(filled.blocks).join("\n")).not.toContain("{{");
    }
  });

  it("applies an override over the default and reports the merged params", () => {
    const filled = substituteParams(starter("개조식"), {
      "표제": "추진 경과",
      "항목2": "세부 내용",
    });
    expect(textsOf(filled.blocks)).toEqual([
      "추진 경과",
      "□ 추진 배경",
      "○ 세부 내용",
      "- 기대 효과",
      "· 향후 계획",
    ]);
    expect(filled.params["표제"]).toBe("추진 경과");
    expect(filled.params["항목1"]).toBe("추진 배경");
  });

  it("leaves the component itself untouched", () => {
    const component = starter("붙임");
    const before = JSON.stringify(component);
    substituteParams(component, { "표제": "붙임 자료" });
    expect(JSON.stringify(component)).toBe(before);
  });

  it("inserts a value literally, never re-scanning it", () => {
    const filled = substituteParams(starter("개조식"), { "항목1": "{{항목2}}" });
    expect(textsOf(filled.blocks)[1]).toBe("□ {{항목2}}");
  });

  it("refuses a value for a param the component does not declare", () => {
    expect(() => substituteParams(starter("개조식"), { "없는항목": "값" })).toThrow(
      /components: 개조식: params\.없는항목: is not a param of this component/,
    );
  });

  it("substitutes inside table cells as well as paragraphs", () => {
    const filled = substituteParams(starter("요약표"), { "내용2": "2026. 3. ~ 2026. 6." });
    expect(textsOf(filled.blocks)).toContain("2026. 3. ~ 2026. 6.");
  });
});

describe("validateComponent refusals", () => {
  const refusalFor = (patch: (value: Record<string, unknown>) => void): string => {
    const value = JSON.parse(JSON.stringify(BASE_COMPONENT)) as Record<string, unknown>;
    patch(value);
    try {
      validateComponent(value, REFUSAL_SOURCE);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected a refusal");
  };

  it("refuses an unknown key, naming the field and the file", () => {
    expect(refusalFor((value) => (value["lists"] = []))).toBe(
      "components: src/components/broken.json: lists: is not a field of this object",
    );
  });

  it("refuses a missing description", () => {
    expect(refusalFor((value) => delete value["description"])).toBe(
      "components: src/components/broken.json: description: must be a non-empty string",
    );
  });

  it("refuses a placeholder no param declares, naming the text field", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          { type: "paragraph", runs: [{ type: "text", text: "{{모름}}" }] },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].runs[0].text: " +
        "uses {{모름}}, which is not a declared param",
    );
  });

  it("refuses an empty placeholder", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [{ type: "paragraph", runs: [{ type: "text", text: "{{}}" }] }];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].runs[0].text: " +
        "has an empty {{}} placeholder",
    );
  });

  it("refuses a param name carrying braces", () => {
    expect(refusalFor((value) => (value["params"] = { "{{항목}}": "값" }))).toBe(
      "components: src/components/broken.json: params.{{항목}}: " +
        "must be a param name without braces or surrounding spaces",
    );
  });

  it("refuses a non-string default", () => {
    expect(refusalFor((value) => (value["params"] = { 항목: 1 }))).toBe(
      "components: src/components/broken.json: params.항목: must be a string",
    );
  });

  it("refuses a colour outside #RRGGBB", () => {
    expect(
      refusalFor((value) => {
        value["styles"] = { 강조: { based_on: "바탕글", color: "#12345" } };
      }),
    ).toBe(
      "components: src/components/broken.json: styles.강조.color: must be a #RRGGBB colour",
    );
  });

  it("refuses a line height outside the schema range", () => {
    expect(
      refusalFor((value) => {
        value["styles"] = { 강조: { line_height_percent: 49 } };
      }),
    ).toBe(
      "components: src/components/broken.json: styles.강조.line_height_percent: " +
        "must be an integer between 50 and 1000",
    );
  });

  it("refuses a table with no columns", () => {
    expect(
      refusalFor((value) => {
        value["blocks"] = [
          {
            type: "table",
            columns: [],
            rows: [{ cells: [{ blocks: [{ type: "paragraph", runs: [{ type: "text", text: "값" }] }] }] }],
          },
        ];
      }),
    ).toBe(
      "components: src/components/broken.json: blocks[0].columns: " +
        "must be an array of at least 1 column",
    );
  });

  it("refuses a block type outside the v1 set", () => {
    expect(refusalFor((value) => (value["blocks"] = [{ type: "heading" }]))).toBe(
      "components: src/components/broken.json: blocks[0].type: " +
        "must be one of paragraph, table, image, equation, field, break",
    );
  });

  it("refuses an empty block list", () => {
    expect(refusalFor((value) => (value["blocks"] = []))).toBe(
      "components: src/components/broken.json: blocks: must be an array of at least 1 block",
    );
  });
});

describe("documentSpecFromComponents", () => {
  it("wraps the merged blocks in the v2 envelope, in list order", () => {
    const spec = documentSpecFromComponents(STARTER_COMPONENTS, { title: "시험 문서" });
    expect(spec.version).toBe("2.0");
    expect(spec.document.version).toBe("1.0");
    expect(spec.document.metadata).toEqual({ title: "시험 문서" });
    expect(spec.document.sections).toHaveLength(1);
    const blocks = spec.document.sections[0].blocks;
    expect(blocks).toEqual(STARTER_COMPONENTS.flatMap((component) => component.blocks));
    expect(blocks).toHaveLength(
      STARTER_COMPONENTS.reduce((count, component) => count + component.blocks.length, 0),
    );
  });

  it("carries the profile styles the components name, and nothing else", () => {
    const spec = documentSpecFromComponents([starter("개조식")]);
    expect(Object.keys(spec.document.styles ?? {})).toEqual(["바탕글", "개요 2"]);
    expect(spec.document.styles?.["개요 2"]).toEqual(OFFICIAL_PROFILE["개요 2"]);
  });

  it("adds a component's own style next to the profile one it derives from", () => {
    const spec = documentSpecFromComponents([starter("두문")]);
    const styles = spec.document.styles ?? {};
    expect(Object.keys(styles)).toEqual(["바탕글", "개요 3", "두문 기관명"]);
    expect(styles["두문 기관명"]).toEqual(starter("두문").styles?.["두문 기관명"]);
  });

  it("refuses an empty component list", () => {
    expect(() => documentSpecFromComponents([])).toThrow(
      /components: at least one component is needed to compose a document/,
    );
  });

  it("refuses one style name defined two different ways", () => {
    const first = validateComponent(
      {
        ...BASE_COMPONENT,
        name: "첫째",
        styles: { 같은: { based_on: "바탕글", bold: true } },
        blocks: [{ type: "paragraph", style: "같은", runs: [{ type: "text", text: "가" }] }],
      },
      "첫째",
    );
    const second = validateComponent(
      {
        ...BASE_COMPONENT,
        name: "둘째",
        styles: { 같은: { based_on: "바탕글", bold: false } },
        blocks: [{ type: "paragraph", style: "같은", runs: [{ type: "text", text: "나" }] }],
      },
      "둘째",
    );
    expect(() => documentSpecFromComponents([first, second])).toThrow(
      /components: 둘째: styles\.같은: is defined differently by 첫째 and this component/,
    );
  });

  it("refuses a style reference neither a component nor the profile supplies", () => {
    const component = validateComponent(
      {
        ...BASE_COMPONENT,
        styles: { 없음: { based_on: "없는 바탕" } },
        blocks: [{ type: "paragraph", style: "없음", runs: [{ type: "text", text: "가" }] }],
      },
      "시험",
    );
    expect(() => documentSpecFromComponents([component])).toThrow(
      /components: 시험: styles\.없음\.based_on: references style 없는 바탕, which no component defines/,
    );
  });
});

describe("loadComponents", () => {
  const respond = (body: string, status = 200): ComponentFetchResponse => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });

  const shipped = (file: string): string =>
    readFileSync(join(import.meta.dirname, "..", "src", "components", file), "utf8");

  it("loads a folder index over an injected transport, resolving entries against it", async () => {
    const requested: string[] = [];
    const transport: ComponentFetch = async (url) => {
      requested.push(url);
      if (url === "https://example.test/lib/index.json") {
        return respond(
          JSON.stringify({
            version: "1.0",
            components: ["dumo.json", { path: "gaejosik.json" }],
          }),
        );
      }
      return respond(shipped(url.slice(url.lastIndexOf("/") + 1)));
    };
    const loaded = await loadComponents("https://example.test/lib/index.json", {
      fetch: transport,
    });
    expect(loaded.map((component) => component.name)).toEqual(["두문", "개조식"]);
    expect(requested).toEqual([
      "https://example.test/lib/index.json",
      "https://example.test/lib/dumo.json",
      "https://example.test/lib/gaejosik.json",
    ]);
  });

  it("loads an index object whose entries are the components themselves", async () => {
    const loaded = await loadComponents({
      version: "1.0",
      components: [starter("붙임"), starter("결재란")],
    });
    expect(loaded.map((component) => component.name)).toEqual(["붙임", "결재란"]);
  });

  it("accepts component objects passed straight in", async () => {
    const loaded = await loadComponents([...STARTER_COMPONENTS]);
    expect(loaded).toEqual([...STARTER_COMPONENTS]);
  });

  it("refuses two entries that carry one name", async () => {
    await expect(
      loadComponents({ version: "1.0", components: [starter("붙임"), starter("붙임")] }),
    ).rejects.toThrow(
      /components: components\[1\]: loads a second component named 붙임/,
    );
  });

  it("refuses an index that is not version 1.0", async () => {
    await expect(
      loadComponents({ version: "2.0", components: [] } as unknown as ComponentIndex),
    ).rejects.toThrow(/components: component index: version: must be "1.0"/);
  });

  it("refuses a relative entry with no baseUrl, naming the entry", async () => {
    await expect(
      loadComponents({ version: "1.0", components: ["dumo.json"] }),
    ).rejects.toThrow(
      /components: component index: components\[0\]: is a relative path, and no baseUrl was given to resolve it/,
    );
  });

  it("resolves a relative entry against a baseUrl", async () => {
    const requested: string[] = [];
    const loaded = await loadComponents(
      { version: "1.0", components: ["dumo.json"] },
      {
        baseUrl: "https://example.test/lib/",
        fetch: async (url) => {
          requested.push(url);
          return respond(shipped("dumo.json"));
        },
      },
    );
    expect(requested).toEqual(["https://example.test/lib/dumo.json"]);
    expect(loaded[0]?.name).toBe("두문");
  });

  it("refuses a failed fetch, naming the URL and the status", async () => {
    await expect(
      loadComponents("https://example.test/missing.json", {
        fetch: async () => respond("", 404),
      }),
    ).rejects.toThrow(
      /components: https:\/\/example\.test\/missing\.json: could not be loaded \(HTTP 404\)/,
    );
  });

  it("refuses a body that is not JSON, naming the URL", async () => {
    await expect(
      loadComponents("https://example.test/bad.json", {
        fetch: async () => respond("{"),
      }),
    ).rejects.toThrow(/components: https:\/\/example\.test\/bad\.json: is not valid JSON/);
  });

  it("names the component URL when a fetched component fails validation", async () => {
    const transport: ComponentFetch = async (url) => {
      if (url === "https://example.test/lib/index.json") {
        return respond(JSON.stringify({ version: "1.0", components: ["bad.json"] }));
      }
      return respond(
        JSON.stringify({
          ...BASE_COMPONENT,
          blocks: [{ type: "paragraph", runs: [{ type: "text", text: "{{모름}}" }] }],
        }),
      );
    };
    await expect(
      loadComponents("https://example.test/lib/index.json", { fetch: transport }),
    ).rejects.toThrow(
      /components: https:\/\/example\.test\/lib\/bad\.json: blocks\[0\]\.runs\[0\]\.text: /,
    );
  });
});

describe("package surface", () => {
  it("re-exports the component library from the package index", async () => {
    const index = await import("../src/index.js");
    expect(index.STARTER_COMPONENTS).toBe(STARTER_COMPONENTS);
    expect(index.OFFICIAL_PROFILE).toBe(OFFICIAL_PROFILE);
    expect(typeof index.validateComponent).toBe("function");
    expect(typeof index.substituteParams).toBe("function");
    expect(typeof index.documentSpecFromComponents).toBe("function");
    expect(typeof index.loadComponents).toBe("function");
  });
});

describeBin("compose with the real hwp", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwp-components-"));
  const out = (name: string) => join(dir, name);

  const compose = (spec: unknown, name: string): Record<string, unknown> => {
    const specPath = out(`${name}.spec.json`);
    const docPath = out(`${name}.hwpx`);
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const stdout = execFileSync(BIN, ["compose", specPath, "-o", docPath, "--report"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The binary prints a one-line human summary before the JSON report.
    return JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;
  };

  const markdown = (name: string): string =>
    execFileSync(BIN, ["cat", out(`${name}.hwpx`), "--format", "markdown"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("reproduces the official profile from OFFICIAL_PROFILE", () => {
    const preset = out("preset.hwpx");
    execFileSync(BIN, ["new", "-o", preset, "--preset", "official"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // `hwp styles` resolves each named style to the attributes the document
    // holds; english_name and face_ids are per-file bookkeeping (a composed
    // file names and registers its own faces), so the comparison keeps the
    // attributes the profile is actually made of.
    const profileOf = (file: string): Record<string, Record<string, unknown>> => {
      const stdout = execFileSync(BIN, ["styles", file, "--format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(stdout) as {
        styles: {
          name: string;
          attrs: {
            char: { bold: boolean; color: string; faces: string[]; italic: boolean; size_pt: number };
            para: { alignment: string; line_spacing: number };
          };
        }[];
      };
      return Object.fromEntries(
        parsed.styles.map((style) => [
          style.name,
          {
            face: style.attrs.char.faces[0],
            size_pt: style.attrs.char.size_pt,
            bold: style.attrs.char.bold,
            italic: style.attrs.char.italic,
            color: style.attrs.char.color,
            align: style.attrs.para.alignment,
            line_spacing: style.attrs.para.line_spacing,
          },
        ]),
      );
    };
    compose(
      documentSpecFromComponents([
        validateComponent(
          {
            name: "프로필",
            description: "프로필 대조용",
            params: {},
            styles: OFFICIAL_PROFILE,
            blocks: PROFILE_NAMES.map((name) => ({
              type: "paragraph",
              style: name,
              runs: [{ type: "text", text: name }],
            })),
          },
          "profile",
        ),
      ]),
      "profile",
    );
    expect(profileOf(out("profile.hwpx"))).toEqual(profileOf(preset));
  });

  it("composes each starter on its own, with no warning", () => {
    STARTER_COMPONENTS.forEach((component, index) => {
      const report = compose(
        documentSpecFromComponents([component], { title: component.name }),
        `starter-${index}`,
      );
      expect({ name: component.name, warnings: report["warnings"] }).toEqual({
        name: component.name,
        warnings: [],
      });
      expect(readFileSync(out(`starter-${index}.hwpx`)).subarray(0, 2).toString("latin1")).toBe(
        "PK",
      );
    });
  });

  it("composes all seven in list order, with the params visible in the output", () => {
    const components = STARTER_COMPONENTS.map((component) => substituteParams(component));
    const gaejosik = components.findIndex((component) => component.name === "개조식");
    components[gaejosik] = substituteParams(starter("개조식"), { "표제": "추진 경과" });
    const report = compose(
      documentSpecFromComponents(components, { title: "구성요소 조립" }),
      "assembly",
    );
    expect(report["warnings"]).toEqual([]);
    expect(report["tables"]).toBe(4);
    const body = markdown("assembly");
    expect(body).toContain("추진 경과");
    expect(body).toContain("□ 추진 배경");
    expect(body).toContain("○ 추진 내용");
    expect(body).toContain("· 향후 계획");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
