import { describe, expect, it } from "vitest";
import type { DocumentSpecV2, TemplateSpecV1 } from "@hwp-editor/core";
import { createCliEngine } from "../src/cli-engine.js";
import { createHwpEditorHandler } from "../src/routes.js";
import { BIN, describeBin, jsonRequest, multipartRequest } from "./helpers.js";

const spec = {version:"2.0",document:{version:"1.0",sections:[{blocks:[
  {type:"paragraph",runs:[{type:"text",text:"제목 {{title}}"}]},
  {type:"paragraph",runs:[{type:"field",name:"approval",value:"대기"}]},
]}]}} as unknown as DocumentSpecV2;
const templateSpec = {version:"1.0",variables:{title:{type:"string",required:true}},source:{mode:"compose",document:{version:"1.0",sections:[{blocks:[{type:"paragraph",runs:[{type:"text",text:{node:"value",pointer:"/values/title"}}]}]}]}}} as TemplateSpecV1;

describeBin("template commands (real hwp-cli 1.4.0)", () => {
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
  it("rejects malformed CLI slots rather than publishing guessed inputs", async () => {
    const { createTemplateCommands } = await import("../src/template-engine.js");
    const commands = createTemplateCommands({version:async()=>"1.4.0",work:async fn=>fn("/unused"),stage:async()=>"/unused/input.hwpx",run:async()=>JSON.stringify({placeholders:[{name:"title",occurrences:"many"}],fields:[]})});
    await expect(commands.slots({name:"x.hwpx",data:new Uint8Array()})).rejects.toThrow(/placeholder.occurrences.*upgrade/);
  });
});
