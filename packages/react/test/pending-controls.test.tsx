import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HwpEditor } from "../src/HwpEditor.js";
import { en, ko } from "../src/messages.js";
import { createMockEngine } from "./mock-engine.js";
afterEach(cleanup);

describe.each([["en",en],["ko",ko]] as const)("pending removal (%s)",(locale,messages)=>{
  it("removes individual ops and clears the queue after a refused Apply",async()=>{
    const engine=createMockEngine();
    engine.edit=vi.fn(async()=>{throw new Error("edit refused");});
    render(<HwpEditor engine={engine} file={{name:"x.hwpx",data:new Uint8Array([1])}} locale={locale} />);
    fireEvent.click(await screen.findByRole("tab",{name:messages["tabs.document"]}));
    fireEvent.change(screen.getByLabelText(messages["document.metaTitle"]),{target:{value:"Title"}});
    const queue=screen.getAllByRole("button",{name:messages["document.setMeta"]})[0]!;
    fireEvent.click(queue); fireEvent.click(queue);
    fireEvent.click(screen.getByRole("button",{name:messages["toolbar.applyWithCount"]({count:2})}));
    expect((await screen.findByRole("alert")).textContent).toContain("edit refused");
    const list=screen.getByRole("list",{name:messages["toolbar.pendingList"]});
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list.textContent).toContain(`${messages["pending.kind.set-meta"]}: ${messages["document.metaTitle"]}`);
    // A row is read, not parsed: no identifier and no JSON reaches it.
    expect(list.textContent).not.toContain("{");
    expect(list.textContent).not.toContain("set-meta");
    fireEvent.click(screen.getByRole("button",{name:messages["toolbar.removePending"]({index:1})}));
    await waitFor(()=>expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button",{name:messages["toolbar.clearPending"]}));
    await waitFor(()=>expect(screen.queryByRole("list",{name:messages["toolbar.pendingList"]})).toBeNull());
    expect(engine.edit).toHaveBeenCalledTimes(1);
  });
});
