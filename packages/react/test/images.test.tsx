import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditOptions, ImageAsset } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const document={name:"images.hwpx",data:new Uint8Array([1])};
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
function imageEngine(upload=true){
  const engine=createMockEngine();
  engine.capabilities=async()=>({version:"1.4.0",editable:true,editOps:"v1",formats:["hwpx"],...(upload?{imageAssets:"v1" as const}:{})});
  return engine;
}
function imageFile(){
  const data=png.slice(),file=new File([data],"사진 @=>.png",{type:"image/png"});
  Object.defineProperty(file,"arrayBuffer",{value:async()=>data.buffer,configurable:true});
  return {file,data};
}

describe.each([["en",en],["ko",ko]] as const)("image controls (%s)",(locale,messages)=>{
  it("queues the exact insertion and supplies bytes only on Apply",async()=>{
    vi.stubGlobal("crypto",{randomUUID:()=>"fixed-id"});
    const engine=imageEngine(),edit=engine.edit;
    let assets:ImageAsset[]|undefined;
    engine.edit=vi.fn(async(doc,ops,options?:EditOptions)=>{assets=options?.assets;return edit(doc,ops,options);});
    render(<HwpEditor engine={engine} file={document} locale={locale} />);
    fireEvent.click(await screen.findByRole("tab",{name:messages["tabs.images"]}));
    const {file,data}=imageFile();
    fireEvent.change(screen.getByLabelText(messages["image.file"]),{target:{files:[file]}});
    await screen.findByText(file.name);
    fireEvent.change(screen.getByLabelText(messages["image.anchor"]),{target:{value:"Anchor"}});
    fireEvent.change(screen.getByLabelText(messages["image.width"]),{target:{value:"20"}});
    fireEvent.change(screen.getByLabelText(messages["image.height"]),{target:{value:"15"}});
    fireEvent.click(screen.getByRole("button",{name:messages["image.insert"]}));
    expect(engine.edit).not.toHaveBeenCalled();
    data[0]=0;
    fireEvent.click(screen.getByRole("button",{name:messages["toolbar.applyWithCount"]({count:1})}));
    await waitFor(()=>expect(engine.edit).toHaveBeenCalled());
    expect(engine.calls.edit[0]!.ops).toEqual([{kind:"insert-image",anchor:"Anchor",path:"image-fixed-id.png",width:20,height:15}]);
    expect(assets).toEqual([{name:"image-fixed-id.png",data:png}]);
  });
  it("refuses invalid dimensions and allows natural size with both fields empty", async () => {
    const engine=imageEngine();
    render(<HwpEditor engine={engine} file={document} locale={locale} />);
    fireEvent.click(await screen.findByRole("tab",{name:messages["tabs.images"]}));
    const {file}=imageFile();
    fireEvent.change(screen.getByLabelText(messages["image.file"]),{target:{files:[file]}});
    await screen.findByText(file.name);
    fireEvent.change(screen.getByLabelText(messages["image.anchor"]),{target:{value:"  Anchor  "}});
    fireEvent.change(screen.getByLabelText(messages["image.height"]),{target:{value:"15"}});
    for (const value of ["-5", ".5", "1e2", "1e-7"]) {
      fireEvent.change(screen.getByLabelText(messages["image.width"]),{target:{value}});
      const button=screen.getByRole("button",{name:messages["image.insert"]});
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(screen.getByRole("alert").textContent).toContain(messages["image.invalidDimensions"]);
    }
    fireEvent.change(screen.getByLabelText(messages["image.width"]),{target:{value:""}});
    fireEvent.change(screen.getByLabelText(messages["image.height"]),{target:{value:""}});
    fireEvent.click(screen.getByRole("button",{name:messages["image.insert"]}));
    fireEvent.click(screen.getByRole("button",{name:messages["toolbar.applyWithCount"]({count:1})}));
    await waitFor(()=>expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]!.ops[0]).toMatchObject({kind:"insert-image",anchor:"Anchor"});
    expect(engine.calls.edit[0]!.ops[0]).not.toHaveProperty("width");
    expect(engine.calls.edit[0]!.ops[0]).not.toHaveProperty("height");
  });
  it("keeps deletion available when uploads are unsupported",async()=>{
    const engine=imageEngine(false);
    render(<HwpEditor engine={engine} file={document} locale={locale} />);
    fireEvent.click(await screen.findByRole("tab",{name:messages["tabs.images"]}));
    expect((screen.getByLabelText(messages["image.file"]) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(messages["image.unsupported"])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(messages["image.deleteAnchor"]),{target:{value:"Old image"}});
    fireEvent.click(screen.getByRole("button",{name:messages["image.delete"]}));
    fireEvent.click(screen.getByRole("button",{name:messages["toolbar.applyWithCount"]({count:1})}));
    await waitFor(()=>expect(engine.calls.edit).toHaveLength(1));
    expect(engine.calls.edit[0]!.ops).toEqual([{kind:"delete-image",anchor:"Old image"}]);
  });
  it("clears the native file selection when the document changes so the same file can be selected again",async()=>{
    const engine=imageEngine();
    const view=render(<HwpEditor engine={engine} file={document} locale={locale} />);
    fireEvent.click(await screen.findByRole("tab",{name:messages["tabs.images"]}));
    const {file}=imageFile();
    const input=screen.getByLabelText(messages["image.file"]) as HTMLInputElement;
    fireEvent.change(input,{target:{files:[file]}});
    await screen.findByText(file.name);

    // jsdom does not model the browser's retained native file selection, so
    // seed the selected-path state that a real file input holds after upload.
    Object.defineProperty(input,"value",{configurable:true,writable:true,value:"C:\\fakepath\\"+file.name});
    view.rerender(<HwpEditor engine={engine} file={{name:"replacement.hwpx",data:new Uint8Array([2])}} locale={locale} />);
    await waitFor(()=>expect(input.value).toBe(""));
    expect(screen.queryByText(file.name)).toBeNull();

    fireEvent.change(input,{target:{files:[file]}});
    await screen.findByText(file.name);
  });
});

it("rejects oversized files before reading bytes",async()=>{
  render(<HwpEditor engine={imageEngine()} file={document} />);
  fireEvent.click(await screen.findByRole("tab",{name:en["tabs.images"]}));
  const {file}=imageFile(),read=vi.fn();
  Object.defineProperty(file,"size",{value:10*1024*1024+1});
  Object.defineProperty(file,"arrayBuffer",{value:read});
  fireEvent.change(screen.getByLabelText(en["image.file"]),{target:{files:[file]}});
  expect((await screen.findByRole("alert")).textContent).toContain(en["image.invalidSize"]);
  expect(read).not.toHaveBeenCalled();
});
