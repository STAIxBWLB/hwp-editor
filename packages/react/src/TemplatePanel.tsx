import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, JSX } from "react";
import type {
  DocumentHandle,
  PageImage,
  TemplateDataV1,
  TemplateInput,
  TemplateInputs,
  TemplateSpecV1,
} from "@hwp-editor/core";
import { base64 } from "@hwp-editor/core";
import { ErrorLine } from "./ErrorLine.js";
import { toEditorError } from "./errors.js";
import { useHwpEditorContext } from "./context.js";
import { templateMethodStatus, templateStatusReason } from "./template-support.js";

type LoadedVariable = NonNullable<TemplateSpecV1["variables"][string]>;
type ScalarVariable = Extract<LoadedVariable, { type: "string" | "number" | "date" | "enum" | "bool" }>;
type ListVariable = Extract<LoadedVariable, { type: "list" }>;
type SupportedVariable = ScalarVariable | ListVariable;

function safeSpecKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !["__proto__", "prototype", "constructor"].includes(key);
}

function initialListRow(fields: ListVariable["fields"], supplied: Record<string, unknown> = {}): Record<string, unknown> {
  const defaults = Object.fromEntries(Object.entries(fields).flatMap(([key, field]) => {
    if (field === undefined) return [];
    if (field.default !== undefined) return [[key, field.default]];
    return field.type === "bool" ? [[key, false]] : [];
  }));
  return { ...defaults, ...supplied };
}

function pageData(page: PageImage): string {
  const mime = page.format === "svg" ? "image/svg+xml" : `image/${page.format}`;
  return `data:${mime};base64,${base64.encode(page.data)}`;
}

function kindLabel(input: TemplateInput, t: ReturnType<typeof useHwpEditorContext>["t"]): string {
  if (input.kind === "slot") return t("templates.kindSlot");
  if (input.kind === "field") return t("templates.kindField");
  return t("templates.kindForm");
}

function variableInput(
  key: string,
  variable: ScalarVariable,
  value: unknown,
  update: (key: string, value: unknown) => void,
  t: ReturnType<typeof useHwpEditorContext>["t"],
  disabled: boolean,
): JSX.Element {
  const id = `hwped-template-${key}`;
  const label = (
    <label className="hwped-label" htmlFor={id}>
      {key}
    </label>
  );
  if (variable.type === "bool") {
    return (
      <div className="hwped-field" key={key}>
        {label}
        <input id={id} type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => update(key, e.target.checked)} />
      </div>
    );
  }
  if (variable.type === "enum") {
    return (
      <div className="hwped-field" key={key}>
        {label}
        <select id={id} className="hwped-input" disabled={disabled} required={variable.required === true} value={typeof value === "string" ? value : ""} onChange={(e) => update(key, e.target.value)}>
          <option value="">{t("templates.chooseValue")}</option>
          {variable.values.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
    );
  }
  const type = variable.type === "number" ? "number" : variable.type === "date" ? "date" : "text";
  return (
    <div className="hwped-field" key={key}>
      {label}
      <input
          id={id}
          className="hwped-input"
          type={type}
          disabled={disabled}
          required={variable.required === true}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => update(key, variable.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
        />
    </div>
  );
}

function listFieldInput(
  field: Exclude<ListVariable["fields"][string], undefined>,
  value: unknown,
  update: (value: unknown) => void,
  ariaLabel: string,
  disabled: boolean,
): JSX.Element {
  if (field.type === "bool") return <input type="checkbox" aria-label={ariaLabel} disabled={disabled} checked={value === true} onChange={(e) => update(e.target.checked)} />;
  if (field.type === "enum") return (
    <select className="hwped-input" aria-label={ariaLabel} disabled={disabled} value={typeof value === "string" ? value : ""} required={field.required === true} onChange={(e) => update(e.target.value)}>
      <option value="">--</option>{field.values.map((item) => <option key={item} value={item}>{item}</option>)}
    </select>
  );
  const type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
  return <input className="hwped-input" type={type} aria-label={ariaLabel} disabled={disabled} required={field.required === true} value={value === undefined || value === null ? "" : String(value)} onChange={(e) => update(field.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />;
}

export function TemplatePanel(): JSX.Element {
  const { engine, state, store, capabilities, editable, replaceDocument, onError, t } = useHwpEditorContext();
  const document = state.document;
  const open = document !== null;
  const status = templateMethodStatus(engine, capabilities, "slots");
  const fillStatus = templateMethodStatus(engine, capabilities, "fill");
  const templateStatus = templateMethodStatus(engine, capabilities, "template");
  const fillFileSupported = document?.name.toLowerCase().endsWith(".hwpx") ?? false;
  const fillReason = !fillFileSupported ? t("templates.hwpOnly") : templateStatusReason(t, fillStatus, "fill");
  const disabledReason = [
    !status.supported ? templateStatusReason(t, status, "slots") : "",
    !fillStatus.supported || (open && !fillFileSupported) ? fillReason : "",
    !templateStatus.supported ? templateStatusReason(t, templateStatus, "template") : "",
  ].filter(Boolean).join(" ");
  const [inputs, setInputs] = useState<TemplateInputs | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [spec, setSpec] = useState<TemplateSpecV1 | null>(null);
  const [specValues, setSpecValues] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<{ source: DocumentHandle; document: DocumentHandle; pages: PageImage[]; kind: "fill" | "spec"; generation: number } | null>(null);
  const [previewBusy, setBusy] = useState(false);
  const busy = previewBusy || state.status === "applying";
  const [error, setError] = useState<ReturnType<typeof toEditorError> | null>(null);
  const request = useRef(0);
  const previewRequest = useRef(0);
  const specReadRequest = useRef(0);
  const fillInputs = useMemo(() => inputs?.items ?? [], [inputs]);
  const variableEntries = useMemo(
    () => Object.entries(spec?.variables ?? {}).filter((entry): entry is [string, SupportedVariable] => entry[1] !== undefined && entry[1].type !== "rich_blocks"),
    [spec],
  );
  const variableSignature = JSON.stringify(specValues);

  useEffect(() => {
    const generation = ++request.current;
    setInputs(null);
    setValues({});
    setPreview(null);
    setBusy(false);
    setError(null);
    if (document === null || !status.supported || engine.slots === undefined) return;
    void engine.slots(document).then((result) => {
      if (request.current === generation) setInputs(result);
    }).catch((e: unknown) => {
      if (request.current !== generation) return;
      setError(toEditorError(e));
      onError?.(e);
    });
    return () => { request.current += 1; };
  }, [document, engine, onError, status.supported]);

  // Any source document or form edit makes a previously rendered preview stale.
  useEffect(() => {
    previewRequest.current += 1;
    setPreview(null);
    setBusy(false);
  }, [document, values, variableSignature, spec]);
  useEffect(() => () => { request.current += 1; previewRequest.current += 1; specReadRequest.current += 1; }, []);
  useEffect(() => { specReadRequest.current += 1; }, [document]);

  const updateSpecValue = (key: string, value: unknown): void => {
    setSpecValues((previous) => ({ ...previous, [key]: value }));
  };

  const loadSpec = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    const generation = ++specReadRequest.current;
    setError(null);
    setPreview(null);
    try {
      let source: string;
      try {
        source = await file.text();
      } catch {
        throw new Error(t("templates.readSpecFailed"));
      }
      if (generation !== specReadRequest.current) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(source) as unknown;
      } catch {
        throw new Error(t("templates.invalidJson"));
      }
      if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== "1.0" || !("variables" in parsed) || typeof parsed.variables !== "object" || parsed.variables === null || Array.isArray(parsed.variables)) {
        throw new Error(t("templates.invalidSpec"));
      }
      if (!("source" in parsed) || typeof parsed.source !== "object" || parsed.source === null || Array.isArray(parsed.source)) {
        throw new Error(t("templates.invalidSpecSource"));
      }
      for (const [key, rawVariable] of Object.entries(parsed.variables)) {
        if (!safeSpecKey(key)) throw new Error(t("templates.invalidVariableKey", { variable: key }));
        if (typeof rawVariable !== "object" || rawVariable === null || !("type" in rawVariable) || !["string", "number", "date", "enum", "bool", "list"].includes(String(rawVariable.type))) {
          throw new Error(t("templates.invalidVariable", { variable: key }));
        }
        if (rawVariable.type === "enum" && (!Array.isArray(rawVariable.values) || rawVariable.values.some((item: unknown) => typeof item !== "string"))) {
          throw new Error(t("templates.invalidEnum", { variable: key }));
        }
        if (rawVariable.type === "list" && (typeof rawVariable.fields !== "object" || rawVariable.fields === null || Array.isArray(rawVariable.fields))) {
          throw new Error(t("templates.invalidList", { variable: key }));
        }
        if (rawVariable.type === "list") {
          if (rawVariable.default !== undefined && (!Array.isArray(rawVariable.default) || rawVariable.default.some((row: unknown) => typeof row !== "object" || row === null || Array.isArray(row)))) {
            throw new Error(t("templates.invalidList", { variable: key }));
          }
          const fields = rawVariable.fields as Record<string, unknown>;
          for (const [fieldKey, rawField] of Object.entries(fields)) {
            if (!safeSpecKey(fieldKey)) throw new Error(t("templates.invalidListFieldKey", { field: fieldKey }));
            if (typeof rawField !== "object" || rawField === null || !("type" in rawField)) {
              throw new Error(t("templates.invalidList", { variable: key }));
            }
            const field = rawField as Record<string, unknown>;
            if (!["string", "number", "date", "enum", "bool"].includes(String(field.type)) || (field.type === "enum" && (!Array.isArray(field.values) || field.values.some((item: unknown) => typeof item !== "string")))) throw new Error(t("templates.invalidList", { variable: key }));
          }
        }
      }
      const loaded = parsed as TemplateSpecV1;
      const initial: Record<string, unknown> = {};
      for (const [key, variable] of Object.entries(loaded.variables)) {
        if (variable === undefined) continue;
        if (variable.type === "bool") initial[key] = variable.default === undefined ? false : variable.default;
        else if (variable.type === "list" && variable.default !== undefined) initial[key] = variable.default.map(row => initialListRow(variable.fields, row));
        else if (variable.default !== undefined) initial[key] = variable.default;
      }
      setSpec(loaded);
      setSpecValues(initial);
    } catch (e) {
      if (generation === specReadRequest.current) setError(toEditorError(e));
    }
  };

  const previewFill = async (): Promise<void> => {
    if (document === null || engine.fill === undefined || !fillStatus.supported) return;
    const generation = ++previewRequest.current;
    setBusy(true); setError(null); setPreview(null);
    try {
      const result = await engine.fill(document, values);
      const pages = await engine.render(result.document, { format: "svg" });
      if (previewRequest.current === generation && store.getState().document === document) setPreview({ source: document, document: result.document, pages, kind: "fill", generation });
    } catch (e) {
      if (previewRequest.current === generation) { setError(toEditorError(e)); onError?.(e); }
    } finally { if (previewRequest.current === generation) setBusy(false); }
  };

  const previewSpec = async (): Promise<void> => {
    if (document === null || spec === null || engine.template === undefined || !templateStatus.supported) return;
    const generation = ++previewRequest.current;
    setBusy(true); setError(null); setPreview(null);
    try {
      const data: TemplateDataV1 = { version: "1.0", values: { ...specValues } };
      const result = await engine.template(spec, data, document.name);
      const pages = await engine.render(result.document, { format: "svg" });
      if (previewRequest.current === generation && store.getState().document === document) setPreview({ source: document, document: result.document, pages, kind: "spec", generation });
    } catch (e) {
      if (previewRequest.current === generation) { setError(toEditorError(e)); onError?.(e); }
    } finally { if (previewRequest.current === generation) setBusy(false); }
  };

  const applyPreview = async (): Promise<void> => {
    if (preview === null || document === null || !editable || busy || state.pendingOps.length > 0) return;
    const result = preview;
    if (store.getState().document !== result.source || previewRequest.current !== result.generation) {
      setPreview(null);
      return;
    }
    setBusy(true); setError(null);
    try {
      await replaceDocument(async () => result.document);
      if (store.getState().document === document) setPreview(null);
    } catch (e) {
      setError(toEditorError(e));
    } finally { setBusy(false); }
  };

  const hasFillInputs = fillInputs.length > 0;

  return (
    <div className="hwped-panel" role="region" aria-label={t("templates.panelAria")}>
      {disabledReason !== "" && (
        <p className="hwped-hint">{t("templates.disabled", { reason: disabledReason, remedy: t("templates.remedy") })}</p>
      )}
      {state.pendingOps.length > 0 && <p className="hwped-hint">{t("templates.pendingEdits")}</p>}
      {!open && <p className="hwped-hint">{t("templates.openDocument")}</p>}
      {open && status.supported && fillStatus.supported && (
        <>
          {inputs === null ? <p className="hwped-hint">{t("templates.loading")}</p> : hasFillInputs ? (
            <>
              <h3>{t("templates.documentInputs")}</h3>
              {fillInputs.map((input) => (
                <div className="hwped-field" key={`${input.kind}:${input.key}`}>
                  <label className="hwped-label" htmlFor={`hwped-fill-${input.kind}-${input.key}`}>{input.label === "" ? input.key : input.label}</label>
                  <input
                    id={`hwped-fill-${input.kind}-${input.key}`}
                    className="hwped-input"
                    type="text"
                    required={input.required}
                    disabled={!editable || busy}
                    value={Object.hasOwn(values, input.key) ? values[input.key] : ""}
                    onChange={(e) => setValues((previous) => ({ ...previous, [input.key]: e.target.value }))}
                  />
                  <small>{kindLabel(input, t)}</small>
                </div>
              ))}
              <button type="button" className="hwped-btn hwped-btn-primary" disabled={!editable || busy || !fillFileSupported || !fillStatus.supported || fillInputs.some((item) => item.required && (!Object.hasOwn(values, item.key) || !values[item.key]!.trim()))} onClick={() => void previewFill()}>
                {busy ? t("templates.rendering") : t("templates.previewFill")}
              </button>
            </>
          ) : <p className="hwped-hint">{t("templates.noInputs")}</p>}
        </>
      )}
      {open && (
        <>
          <hr />
          <div className="hwped-field">
            <label className="hwped-label" htmlFor="hwped-template-spec">{t("templates.specLabel")}</label>
            <input id="hwped-template-spec" type="file" accept="application/json,.json" disabled={!templateStatus.supported || busy} onChange={(event) => void loadSpec(event)} />
            {spec !== null && variableEntries.map(([key, variable]) => {
              if (variable.type !== "list") return variableInput(key, variable, specValues[key] ?? variable.default, updateSpecValue, t, !editable || busy);
              const rows = (Array.isArray(specValues[key]) ? specValues[key] : variable.default ?? []) as Record<string, unknown>[];
              return (
                <div className="hwped-field" key={key}>
                  <span className="hwped-label">{key}</span>
                  {rows.map((row, rowIndex) => (
                    <div className="hwped-field-item" key={rowIndex}>
                      {Object.entries(variable.fields).map(([fieldKey, field]) => field === undefined ? null : (
                        <div className="hwped-field" key={fieldKey}>
                          <label className="hwped-label">{fieldKey}</label>
                          {listFieldInput(field, row[fieldKey], (value) => updateSpecValue(key, rows.map((item, index) => index === rowIndex ? { ...item, [fieldKey]: value } : item)), t("templates.listFieldAria", { row: rowIndex + 1, field: fieldKey }), !editable || busy)}
                        </div>
                      ))}
                      <button type="button" className="hwped-btn" disabled={!editable || busy} onClick={() => updateSpecValue(key, rows.filter((_, index) => index !== rowIndex))}>{t("templates.listRemove", { row: rowIndex + 1 })}</button>
                    </div>
                  ))}
                  <button type="button" className="hwped-btn" disabled={!editable || busy} onClick={() => {
                    const row = initialListRow(variable.fields);
                    updateSpecValue(key, [...rows, row]);
                  }}>{t("templates.listAdd")}</button>
                </div>
              );
            })}
            {spec !== null && <button type="button" className="hwped-btn" disabled={!editable || busy || !templateStatus.supported} onClick={() => void previewSpec()}>{t("templates.previewSpec")}</button>}
          </div>
        </>
      )}
      {preview !== null && (
        <div className="hwped-template-preview" aria-label={t("templates.previewAria")}>
          <p>{t("templates.previewReady", { pages: preview.pages.length })}</p>
          {preview.pages.map((page) => <img key={page.page} src={pageData(page)} alt={t("templates.previewPage", { page: page.page })} style={{ width: "100%", border: "1px solid var(--_hwped-hairline)" }} />)}
          <button type="button" className="hwped-btn hwped-btn-primary" disabled={!editable || busy || state.document !== preview.source || state.pendingOps.length > 0} onClick={() => void applyPreview()}>{t("templates.apply")}</button>
        </div>
      )}
      {error !== null && <ErrorLine prefix={t("error.prefix.template")} {...error} />}
    </div>
  );
}
