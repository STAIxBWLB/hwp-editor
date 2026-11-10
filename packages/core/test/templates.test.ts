import { describe, expect, it } from "vitest";
import { parseEmbeddedTemplates, parseFillReport, parseLintReport, parseTemplateInputs, parseTemplateMethods, parseTemplateReport, templateVersionSupported } from "../src/templates.js";

describe("template report boundaries", () => {
  it("accepts the normalized wire reports and drops unconsumed host paths", () => {
    expect(parseTemplateInputs({ items: [{key:"title",label:"제목",kind:"slot",required:true}] }).items[0]!.label).toBe("제목");
    expect(parseTemplateReport({ schema_version:"1.0",mode:"compose",deterministic:true,output:"/private/output.hwpx" })).toEqual({schema_version:"1.0",mode:"compose",deterministic:true});
    expect(parseFillReport({replaced:2,counts:{title:2}})).toEqual({replaced:2,counts:{title:2}});
    expect(parseLintReport({findings:[{rule_id:"rule",severity:"warning",line:1,col:1,message:"Check",context:"text"}]}).findings).toHaveLength(1);
    expect(parseEmbeddedTemplates([{id:"report",label:"보고서"}])).toHaveLength(1);
    expect(parseTemplateMethods(["slots","create"])).toEqual(["slots","create"]);
  });
  it.each([
    () => parseTemplateInputs({items:[{key:"x",label:"X",kind:"guess",required:false}]}),
    () => parseFillReport({replaced:1,counts:{x:-1}}),
    () => parseFillReport({replaced:NaN,counts:{}}),
    () => parseLintReport({findings:[{rule_id:"x",severity:"info",line:1,col:1,message:"x"}]}),
    () => parseLintReport({findings:[{rule_id:"x",severity:"error",line:1,col:1,message:42}]}),
    () => parseTemplateReport({schema_version:"2.0",mode:"compose",deterministic:true}),
    () => parseEmbeddedTemplates([{id:"../../file",label:"X"}]),
    () => parseTemplateMethods(["unknown"]),
  ])("refuses malformed consumed fields with cause and remedy", parse => {
    expect(parse).toThrow(/Invalid template report: .+; upgrade the host\/client/);
  });
  it("handles count keys that collide with object prototypes as data", () => {
    const report = parseFillReport(JSON.parse('{"replaced":1,"counts":{"__proto__":1,"constructor":0}}'));
    expect(Object.hasOwn(report.counts,"__proto__")).toBe(true);
    expect(report.counts.constructor).toBe(0);
    expect(Object.getPrototypeOf(report.counts)).toBe(Object.prototype);
  });
  it("gates the verified version, failing closed on malformed version text", () => {
    expect(templateVersionSupported("1.3.1")).toBe(false);
    expect(templateVersionSupported("1.4.0")).toBe(true);
    expect(templateVersionSupported("unknown")).toBe(false);
  });
});
