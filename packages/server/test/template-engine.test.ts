import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { templateVersionSupported } from "@hwp-editor/core";
import type { DocumentSpecV2, TemplateSpecV1 } from "@hwp-editor/core";
import { createCliEngine } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import type { createTemplateCommands } from "../src/template-engine.js";
import { createFakeBin, disposeFakeBins } from "./fake-bin.js";
import { BIN, jsonRequest, multipartRequest } from "./helpers.js";

afterEach(disposeFakeBins);

const spec = {version:"2.0",document:{version:"1.0",sections:[{blocks:[
  {type:"paragraph",runs:[{type:"text",text:"제목 {{title}}"}]},
  {type:"paragraph",runs:[{type:"field",name:"approval",value:"대기"}]},
]}]}} as unknown as DocumentSpecV2;
const templateSpec = {version:"1.0",variables:{title:{type:"string",required:true}},source:{mode:"compose",document:{version:"1.0",sections:[{blocks:[{type:"paragraph",runs:[{type:"text",text:{node:"value",pointer:"/values/title"}}]}]}]}}} as TemplateSpecV1;

let templateBinaryAvailable = false;
try {
  const version = execFileSync(BIN,["--version"],{encoding:"utf8"}).match(/\d+\.\d+\.\d+/)?.[0] ?? "";
  templateBinaryAvailable = templateVersionSupported(version);
} catch { /* The base integration suite reports a missing binary. */ }
const describeTemplates = templateBinaryAvailable ? describe : describe.skip;
describeTemplates("template commands (requires real hwp-cli >= 1.4.0)", () => {
  it("lists slots and native fields, fills both, and retains the original bytes", async () => {
    const engine = createCliEngine({bin:BIN});
    const original = (await engine.compose(spec,"inputs.hwpx")).document;
    const before = original.data.slice();
    expect((await engine.slots(original)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({key:"title",kind:"slot"}), expect.objectContaining({key:"approval",kind:"field"}),
    ]));
    const result = await engine.fill(original,{title:"최종 제목",approval:"완료"});
    expect(result.report.replaced).toBeGreaterThanOrEqual(2);
    const text = (await engine.read(result.document)).markdown;
    expect(text).toContain("최종 제목"); expect(text).toContain("완료"); expect(text).not.toContain("{{title}}");
    expect(original.data).toEqual(before);
    await expect(engine.fill(original,{unknown:"value"})).rejects.toThrow(/unknown input key.*refresh/i);
  });
  it("creates embedded templates, lints a document, and renders a typed template", async () => {
    const engine = createCliEngine({bin:BIN});
    expect(await engine.listTemplates()).toEqual(expect.arrayContaining([expect.objectContaining({id:"gongmun-basic"})]));
    const created = await engine.create("gongmun-basic","official.hwpx");
    const lint = await engine.lint(created,"gongmun");
    expect(lint.findings.filter(f=>f.severity==="error")).toEqual([]);
    const rendered = await engine.template(templateSpec,{version:"1.0",values:{title:"템플릿 제목"}},"typed.hwpx");
    expect((await engine.read(rendered.document)).markdown).toContain("템플릿 제목");
    expect(rendered.report).toEqual({schema_version:"1.0",mode:"compose",deterministic:true});
    expect((await engine.render(rendered.document,{format:"svg"})).length).toBeGreaterThan(0);
  });
  it("accepts a scalar template variable named path", async () => {
    const engine = createCliEngine({ bin: BIN });
    const pathSpec = {
      version: "1.0", variables: { path: { type: "string", required: true } },
      source: { mode: "compose", document: { version: "1.0", sections: [{ blocks: [
        { type: "paragraph", runs: [{ type: "text", text: { node: "value", pointer: "/values/path" } }] },
      ] }] } },
    } as TemplateSpecV1;
    const rendered = await engine.template(pathSpec, { version: "1.0", values: { path: "Safe scalar text" } }, "path.hwpx");
    expect((await engine.read(rendered.document)).markdown).toContain("Safe scalar text");
  });
  it("refuses HWP placeholder fill and host file references with a next step", async () => {
    const engine = createCliEngine({bin:BIN});
    const hwp = (await engine.compose(spec,"inputs.hwp")).document;
    await expect(engine.fill(hwp,{title:"x"})).rejects.toThrow(/HWPX.*open an HWPX/);
    await expect(engine.template({...templateSpec,source:{mode:"reference_hwpx",path:"private.hwpx",bindings:[]}} as unknown as TemplateSpecV1,{version:"1.0",values:{}},"x.hwpx")).rejects.toThrow(/self-contained.*compose/);
  });
  it("round trips the new HTTP routes through the real binary", async () => {
    const engine = createCliEngine({bin:BIN}); const handler=createHwpEditorHandler({engine});
    const original=(await engine.compose(spec,"wire.hwpx")).document;
    const slots=await handler(multipartRequest("http://test/slots",{file:original}));
    expect(slots.status).toBe(200); expect((await slots.json()).items).toHaveLength(2);
    const fill=await handler(multipartRequest("http://test/fill",{file:original,values:JSON.stringify({title:"HTTP",approval:"OK"})}));
    expect(fill.status).toBe(200);
    const payload=await fill.json(); expect(payload.report.replaced).toBeGreaterThanOrEqual(2);
    const templates=await handler(new Request("http://test/templates")); expect(templates.status).toBe(200);
    const created=await handler(jsonRequest("http://test/create",{templateId:"gongmun-basic",name:"new.hwpx"})); expect(created.status).toBe(200);
  });
});

describe("template CLI failure guidance", () => {
  const document = { name: "sample.hwpx", data: new Uint8Array([1]) };
  const cases = [
    ["slots", (engine: ReturnType<typeof createCliEngine>) => engine.slots(document), "hwp info"],
    ["fields", (engine: ReturnType<typeof createCliEngine>) => engine.slots(document), "hwp info"],
    ["fill", (engine: ReturnType<typeof createCliEngine>) => engine.fill(document, { title: "Hello" }), "form values"],
    ["template", (engine: ReturnType<typeof createCliEngine>) => engine.template(templateSpec, { version: "1.0", values: { title: "Hello" } }, "out.hwpx"), "TemplateSpec"],
    ["lint", (engine: ReturnType<typeof createCliEngine>) => engine.lint(document), "hwp info"],
    ["list-templates", (engine: ReturnType<typeof createCliEngine>) => engine.listTemplates(), "hwp new --list-templates"],
    ["create", (engine: ReturnType<typeof createCliEngine>) => engine.create("gongmun-basic", "out.hwpx"), "hwp new --list-templates"],
    ["edit", (engine: ReturnType<typeof createCliEngine>) => engine.fill(document, { approval: "ok" }), "field names exist"],
  ] as const;

  it.each(cases)("gives command-specific guidance when %s fails through createCliEngine", async (failure, invoke, guidance) => {
    const { bin } = createFakeBin({ version: "1.4.0", failTemplateCommand: failure });
    const engine = createCliEngine({ bin });
    const error = await invoke(engine).then(() => null, (reason: unknown) => reason);
    expect(error).toMatchObject({ message: expect.stringContaining(guidance) });
    expect((error as Error).message).not.toContain("/private/fake/document.hwpx");
  });

  /**
   * `lint` was the one command whose exit 1 the wrapper read as success (#58
   * item 31). hwp-cli's `lint::run` returns an anyhow `Result` and exits 1 only
   * on that `Err` (an unreadable document, or input over the size cap), while
   * findings move the code only under `--strict`, which this engine never
   * passes; measured identical at v0.20.0 and v1.4.0. Tolerating it handed
   * `parse` empty stdout, so the host was told the report was invalid JSON and
   * that its next step was an upgrade.
   */
  it("refuses a lint that exits 1 with the lint sentence, not an invalid-JSON one", async () => {
    const { bin } = createFakeBin({ version: "1.4.0", failTemplateCommand: "lint", templateFailureCode: 1 });
    const error = await createCliEngine({ bin }).lint(document).then(() => null, (reason: unknown) => reason);
    expect(error).toMatchObject({ reason: "failed" });
    expect((error as Error).message).toContain("hwp lint could not inspect this document");
    expect((error as Error).message).toContain("hwp info");
    expect((error as Error).message).not.toContain("invalid JSON");
    expect((error as Error).message).not.toContain("/private/fake/document.hwpx");
    // lint rides runCliOk now, so the family sentence is a rewrite of the
    // generic failure rather than a replacement for it: the engine's own text
    // stays on `detail` for a host that logs it (#45 review t45-n1).
    expect((error as { detail?: string }).detail).toContain("lint failed at /private/fake/document.hwpx");
  });
});

/**
 * The five subcommands whose stdout `template-engine.ts` parses itself. A
 * producer that answers one of them with something other than JSON must be
 * named: "hwp template" for a `slots` failure sends the reader to the wrong
 * command (#58 item 4).
 */
describe("template CLI invalid JSON names its command", () => {
  type Commands = ReturnType<typeof createTemplateCommands>;
  const document = { name: "sample.hwpx", data: new Uint8Array([1]) };
  const goodSlots = JSON.stringify({ placeholders: [{ name: "title", occurrences: 1 }], fields: [] });
  const cases: Array<[string, (commands: Commands) => Promise<unknown>]> = [
    ["slots", (commands) => commands.slots(document)],
    ["fields", (commands) => commands.slots(document)],
    ["fill", (commands) => commands.fill(document, { title: "Hello" })],
    ["template", (commands) => commands.template(templateSpec, { version: "1.0", values: { title: "Hello" } }, "out.hwpx")],
    ["lint", (commands) => commands.lint(document)],
  ];

  it.each(cases)("names %s, not a fixed command, when its output is not JSON", async (broken, invoke) => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    const dir = await mkdtemp(join(tmpdir(), "hwp-bad-json-"));
    try {
      const commands = createTemplateCommands({
        version: async () => "1.4.0",
        work: async <T>(fn: (dir: string) => Promise<T>) => fn(dir),
        stage: async () => join(dir, "input.hwpx"),
        run: async args => {
          if (args[0] === broken) return "<html>not the JSON contract</html>";
          if (args[0] === "slots") return goodSlots;
          if (args[0] === "fields") return "[]";
          // `fill` and `template` publish a document at their `-o` path.
          const out = args.indexOf("-o");
          if (out >= 0) await writeFile(args[out + 1]!, new Uint8Array([1]));
          return "";
        },
      });
      const error = await invoke(commands).then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ reason: "failed" });
      expect((error as Error).message).toBe(
        `hwp ${broken} returned invalid JSON; check hwp --version, use hwp-cli 1.4.0 or newer, and retry.`,
      );
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("template route admission", () => {
  it("runs host authorization before buffering new POST routes and GET template list", async () => {
    const handler=createHwpEditorHandler({authorize:async()=>null});
    for (const action of ["slots","fill","lint","template","create"]) {
      const request=new Request(`http://test/${action}`,{method:"POST",body:"not JSON"});
      expect((await handler(request)).status).toBe(403); expect(request.bodyUsed).toBe(false);
    }
    expect((await handler(new Request("http://test/templates"))).status).toBe(403);
  });
});

describe("template producer refusal", () => {
  it("rejects old engines before invoking a new command", async () => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    let called = false;
    const commands = createTemplateCommands({version:async()=>"1.3.1",work:async fn=>fn("/unused"),stage:async()=>"/unused/input.hwpx",run:async()=>{called=true;return "{}";}});
    await expect(commands.slots({name:"x.hwpx",data:new Uint8Array()})).rejects.toThrow(/1.4.0.*upgrade/i);
    expect(called).toBe(false);
  });
  it("refuses image paths in rich_blocks defaults before staging or invoking template", async () => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    let staged = false;
    const commands = createTemplateCommands({
      version: async () => "1.4.0",
      work: async fn => { staged = true; return fn("/unused"); },
      stage: async () => "/unused/input.hwpx", run: async () => { throw new Error("must not invoke template"); },
    });
    const defaultImageSpec = {
      version: "1.0",
      variables: { content: { type: "rich_blocks", default: [{ type: "image", path: "/unused/server-image.png" }] } },
      source: { mode: "compose", document: { version: "1.0", sections: [{ blocks: [
        { node: "value", pointer: "/values/content", as: "native" },
      ] }] } },
    } as TemplateSpecV1;
    await expect(commands.template(defaultImageSpec, { version: "1.0", values: {} }, "out.hwpx"))
      .rejects.toThrow(/host files.*self-contained/);
    expect(staged).toBe(false);
  });
  it("rejects malformed CLI slots rather than publishing guessed inputs", async () => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    const commands = createTemplateCommands({version:async()=>"1.4.0",work:async fn=>fn("/unused"),stage:async()=>"/unused/input.hwpx",run:async()=>JSON.stringify({placeholders:[{name:"title",occurrences:"many"}],fields:[]})});
    await expect(commands.slots({name:"x.hwpx",data:new Uint8Array()})).rejects.toThrow(/placeholder.occurrences.*upgrade/);
  });
});

describe("lint report schema compatibility", () => {
  it.each(["1.1", "1.12"])("accepts additive lint schema %s", async schema_version => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    const commands=createTemplateCommands({version:async()=>"1.4.0",work:async fn=>fn("/unused"),stage:async()=>"/unused/input.hwpx",run:async()=>JSON.stringify({contract:"hwp-lint-report-v1",schema_version,findings:[]})});
    await expect(commands.lint({name:"x.hwpx",data:new Uint8Array()})).resolves.toEqual({findings:[]});
  });
  it.each([
    {schema_version:"2.0",findings:[]},
    {schema_version:"1.1",findings:[{rule_id:"rule",severity:"unknown",line:1,col:1,message:"x"}]},
  ])("still rejects incompatible schemas and malformed consumed fields", async report => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    const commands=createTemplateCommands({version:async()=>"1.4.0",work:async fn=>fn("/unused"),stage:async()=>"/unused/input.hwpx",run:async()=>JSON.stringify({contract:"hwp-lint-report-v1",...report})});
    await expect(commands.lint({name:"x.hwpx",data:new Uint8Array()})).rejects.toThrow(/Invalid template report: (lint.schema_version|finding.severity).*upgrade/);
  });
});

describe("nullable native field names", () => {
  it("skips an unnamed field while listing and filling its named neighbor", async () => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    const dir=await mkdtemp(join(tmpdir(),"hwp-null-field-"));
    try {
      const commands=createTemplateCommands({version:async()=>"1.4.0",work:async fn=>fn(dir),stage:async()=>join(dir,"input.hwpx"),run:async args=>{
        if(args[0]==="slots") return JSON.stringify({placeholders:[],fields:[]});
        if(args[0]==="fields") return JSON.stringify([
          {name:null,kind:"하이퍼링크",ctrl_id:"%hlk",value:"링크"},
          {name:"approval",kind:"누름틀",ctrl_id:"%clk",value:"대기"},
        ]);
        expect(args[0]).toBe("edit");
        expect(JSON.parse(await readFile(args[args.indexOf("--ops")+1]!,"utf8"))).toEqual([{op:"set_field",name:"approval",value:"완료"}]);
        await writeFile(args[args.indexOf("-o")+1]!,new Uint8Array([7]));
        return "";
      }});
      const document={name:"x.hwpx",data:new Uint8Array()};
      await expect(commands.slots(document)).resolves.toEqual({items:[{key:"approval",label:"approval",kind:"field",required:false}]});
      const filled=await commands.fill(document,{approval:"완료"});
      expect(filled.document.data).toEqual(new Uint8Array([7]));
      expect(filled.report).toEqual({replaced:1,counts:{approval:1}});
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
