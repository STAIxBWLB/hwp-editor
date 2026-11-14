import { describe, expect, it } from "vitest";
import { formGrowthWithoutReflow, formBindingSupported, parseFormBindingPlan, parseFormDiscovery, parseFormPreview, parseFormReceipt, validateFormValues } from "../src/forms.js";

const h = "a".repeat(64), id = `occ-${h}`;
const plan = (extra: Record<string, unknown> = {}) => ({ version: 1, source_sha256: h, structural_sha256: h, bindings: [{ key: "amount", targets: [{ occurrence_id: id, max_chars: 20, allow_reflow: false }] }], ...extra });
const discovery = () => ({version:1,source_sha256:h,structural_sha256:h,occurrences:[{id,kind:"placeholder",label:"Amount",paragraph_id:"p1",section:0,indices:[],model_route:"body",table_id:null,table_index:null,row:null,col:null,start:0,end:6,old_text:"Amount",prior_sha256:h,bindable:true,cause:null,next_step:null,label_occurrences:1,label_ambiguous:false}]});

describe("form contracts", () => {
  it("compares no-reflow growth in native UTF-16 units, separately from the scalar budget", () => {
    expect(formGrowthWithoutReflow("", "ABCDE", false)).toBe(true);
    expect(formGrowthWithoutReflow("AB", "ABCDE", false)).toBe(true);
    expect(formGrowthWithoutReflow("AB", "😀", false)).toBe(false);
    expect(formGrowthWithoutReflow("A", "😀", false)).toBe(true);
    expect(formGrowthWithoutReflow("", "ABCDE", true)).toBe(false);
  });
  it("supports engine releases from 2.0.0", () => { expect(formBindingSupported("2.0.0")).toBe(true); expect(formBindingSupported("2.0.1")).toBe(true); expect(formBindingSupported("3.0.0")).toBe(true); expect(formBindingSupported("2.0.0-rc.1")).toBe(false); expect(formBindingSupported("1.9.9")).toBe(false); expect(formBindingSupported("not-a-version")).toBe(false); });
  it("parses closed discovery and plan shapes", () => { expect(parseFormDiscovery(discovery()).occurrences).toHaveLength(1); expect(parseFormBindingPlan(plan()).bindings[0]?.targets[0]?.copies ?? [0]).toEqual([0]); });
  it("rejects malformed versions, duplicate IDs, and duplicate target ownership", () => {
    expect(() => parseFormDiscovery({...discovery(),version:2})).toThrow();
    expect(() => parseFormDiscovery({...discovery(),occurrences:[...discovery().occurrences,...discovery().occurrences]})).toThrow();
    expect(() => parseFormBindingPlan(plan({bindings:[{key:"a",targets:[{occurrence_id:id,max_chars:3,allow_reflow:true}]},{key:"b",targets:[{occurrence_id:id,max_chars:3,allow_reflow:true}]}]}))).toThrow();
    expect(() => parseFormBindingPlan(plan({repeats:[{table_id:"t",after_paragraph_id:"p",copies:2,profile_ids:["x"]}]}))).toThrow();
  });
  it("requires exact value membership and checks Unicode scalar limits and controls", () => {
    const p=parseFormBindingPlan(plan());
    expect(validateFormValues(p,{amount:"😀"})).toEqual({amount:"😀"});
    expect(() => validateFormValues(p,{amount:"ok",extra:"x"})).toThrow();
    expect(() => validateFormValues(p,{amount:"\r"})).toThrow();
    expect(() => validateFormValues(p,{amount:"\ud800"})).toThrow();
  });
  it("checks integer constraints without exposing keys or values in errors", () => {
    const p=parseFormBindingPlan({version:1,source_sha256:h,structural_sha256:h,bindings:[{key:"a",targets:[{occurrence_id:id,max_chars:20,allow_reflow:true}]},{key:"b",targets:[{occurrence_id:`occ-${"b".repeat(64)}`,max_chars:20,allow_reflow:true}]}],constraints:[{kind:"equal",left:"a",right:"b"}]});
    expect(validateFormValues(p,{a:"1,000",b:"1000"})).toBeTruthy();
    try { validateFormValues(p,{a:"SECRET",b:"2"}); throw new Error("expected refusal"); } catch (e) { expect((e as Error).message).not.toContain("SECRET"); expect((e as Error).message).not.toContain("values.a"); }
  });
  it("preserves prototype-like keys as ordinary value data", () => {
    const p = parseFormBindingPlan({version:1,source_sha256:h,structural_sha256:h,bindings:[
      {key:"__proto__",targets:[{occurrence_id:id,max_chars:20,allow_reflow:true}]},
      {key:"constructor",targets:[{occurrence_id:`occ-${"b".repeat(64)}`,max_chars:20,allow_reflow:true}]},
    ]});
    const raw = Object.fromEntries([["__proto__","safe"],["constructor","also safe"]]);
    const result = validateFormValues(p, raw);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result,"__proto__")).toBe(true);
    expect(result["__proto__"]).toBe("safe");
    expect(result["constructor"]).toBe("also safe");
  });
  it("validates content-free receipts and strips local warning text from previews", () => {
    const receipt={version:1,source_sha256:h,plan_sha256:h,values_sha256:h,output_sha256:h,published:false,occurrence_ids:[id],targets:1,cloned_profiles:0,semantic_budget:"selected_text_and_declared_clones_only",render_font_native:"unverified",native_warning_count:0};
    expect(parseFormReceipt(receipt)).toEqual(receipt);
    const preview={version:1,source_sha256:h,plan_sha256:h,values_sha256:h,copies:[],changes:[],native_warnings:["failed at /private/form.hwp"]};
    expect(parseFormPreview(preview).native_warnings).toEqual([]);
    const change={occurrence_id:id,copy:16,profile_id:null,paragraph_id:"p",section:0,indices:[],row:null,col:null,start:2,end:1,old_text:"",new_text:"x",max_chars:1,allow_reflow:true};
    expect(() => parseFormPreview({...preview,changes:[change]})).toThrow();
    expect(() => parseFormPreview({...preview,changes:[{...change,copy:0}]})).toThrow();
    expect(() => parseFormPreview({...preview,copies:[{source_table_id:"t",copy:16,profile_id:"x",table_id:"t2",section:0,indices:[]}]})).toThrow();
  });
});
