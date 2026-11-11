import { useState } from "react";
import type { JSX } from "react";
import type { MetaKey, PageSetupKey } from "@hwp-editor/core";
import { useHwpEditorContext } from "./context.js";

const META: { key: MetaKey; label: "document.metaTitle" | "document.metaAuthor" | "document.metaSubject" | "document.metaKeywords" }[] = [
  { key: "title", label: "document.metaTitle" },
  { key: "author", label: "document.metaAuthor" },
  { key: "subject", label: "document.metaSubject" },
  { key: "keywords", label: "document.metaKeywords" },
];
const PAGE_KEYS: { key: PageSetupKey; label: "document.page.width" | "document.page.height" | "document.page.marginLeft" | "document.page.marginRight" | "document.page.marginTop" | "document.page.marginBottom" | "document.page.orientation" }[] = [
  { key: "width", label: "document.page.width" }, { key: "height", label: "document.page.height" },
  { key: "margin-left", label: "document.page.marginLeft" }, { key: "margin-right", label: "document.page.marginRight" },
  { key: "margin-top", label: "document.page.marginTop" }, { key: "margin-bottom", label: "document.page.marginBottom" },
  { key: "orientation", label: "document.page.orientation" },
];

/** Document metadata and page setup ops. */
export function DocumentPanel(): JSX.Element {
  const { store, editable, state, envelope, t } = useHwpEditorContext();
  const [meta, setMeta] = useState<Record<MetaKey, string>>({ title: "", author: "", subject: "", keywords: "" });
  const [pageKey, setPageKey] = useState<PageSetupKey>("width");
  const [pageValue, setPageValue] = useState("");
  const disabled = !editable || state.document === null || envelope === null || state.status === "applying";

  return <div className="hwped-panel" role="region" aria-label={t("document.panelAria")}>
    <div className="hwped-field">
      <span className="hwped-label">{t("document.metadata")}</span>
      {META.map(({ key, label }) => <div className="hwped-row" key={key}>
        <label className="hwped-label" htmlFor={`hwped-meta-${key}`}>{t(label)}</label>
        <input id={`hwped-meta-${key}`} className="hwped-input" value={meta[key]} disabled={disabled}
          placeholder={t("document.valuePlaceholder")} onChange={(e) => setMeta((prev) => ({ ...prev, [key]: e.target.value }))} />
        <button type="button" className="hwped-btn" disabled={disabled || meta[key] === ""}
          onClick={() => store.dispatch({ type: "queueOp", op: { kind: "set-meta", key, value: meta[key] } })}>{t("document.setMeta")}</button>
      </div>)}
    </div>
    <div className="hwped-field">
      <span className="hwped-label">{t("document.pageSetup")}</span>
      <div className="hwped-row">
        <select className="hwped-input" value={pageKey} disabled={disabled} aria-label={t("document.pageKeyAria")}
          onChange={(e) => { const key = e.target.value as PageSetupKey; setPageKey(key); setPageValue(key === "orientation" ? "portrait" : ""); }}>
          {PAGE_KEYS.map(({ key, label }) => <option key={key} value={key}>{t(label)}</option>)}
        </select>
        {pageKey === "orientation" ? <select className="hwped-input" value={pageValue || "portrait"} disabled={disabled} aria-label={t("document.pageValueAria")} onChange={(e) => setPageValue(e.target.value)}>
          <option value="portrait">{t("document.orientation.portrait")}</option><option value="landscape">{t("document.orientation.landscape")}</option>
        </select> : <input className="hwped-input" type="number" min="0" step="0.1" value={pageValue} disabled={disabled}
          placeholder="mm" aria-label={t("document.pageValueAria")} onChange={(e) => setPageValue(e.target.value)} />}
        <button type="button" className="hwped-btn" disabled={disabled || pageValue === ""}
          onClick={() => store.dispatch({ type: "queueOp", op: { kind: "set-page", key: pageKey, value: pageValue || "portrait" } })}>{t("document.setPage")}</button>
      </div>
    </div>
  </div>;
}
