import { describe, expect, it } from "vitest";
import { HwpEngineError } from "../src/errors.js";
import { parsePageLayout, parseRenderLayouts, RENDER_LAYOUT_NEXT_STEP } from "../src/layout.js";
import { malformedLayouts, validLayout } from "./fixtures/layout.js";

describe("shared render-layout validation", () => {
  it("retains duplicate fragments, null geometry and truncation", () => {
    const result = parsePageLayout(validLayout);
    expect(result).toEqual(validLayout);
    expect(result).not.toBe(validLayout);
  });
  it.each(malformedLayouts)("rejects malformed $field with an actionable shared error", ({value,field}) => {
    let failure: unknown;
    try { parsePageLayout(value); } catch(error) { failure=error; }
    expect(failure).toBeInstanceOf(HwpEngineError);
    expect(failure).toMatchObject({code:"failed",message:expect.stringContaining(field)});
    expect((failure as Error).message).toContain(RENDER_LAYOUT_NEXT_STEP);
  });
  it.each(["1.0","1.1"])("validates artifact schema %s using the same page rules", schema_version => {
    const layouts=parseRenderLayouts(JSON.stringify({contract:"hwp-render-layout-v1",schema_version,truncated:true,selected_pages:[3],pages:[{page:3,...validLayout}]}));
    expect(layouts.get(3)).toEqual(validLayout);
  });
  it("rejects malformed present artifact content", () => {
    expect(()=>parseRenderLayouts("not JSON")).toThrow(/artifact is not valid JSON.*render-layout-v1/);
    expect(()=>parseRenderLayouts(JSON.stringify({contract:"hwp-render-layout-v1",schema_version:"2.0"}))).toThrow(/schema_version must be 1.x/);
  });
});
