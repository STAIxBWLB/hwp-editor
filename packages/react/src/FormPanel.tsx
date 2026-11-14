import { useEffect, useId, useRef, useState } from "react";
import { parseFormBindingPlan, validateFormValues, type FormDiscovery, type FormBindingPlan, type FormPreview, type DocumentHandle } from "@hwp-editor/core";
import { useHwpEditorContext } from "./context.js";

interface Choice { selected: boolean; value: string; max: number; reflow: boolean }
interface Reviewed { plan: FormBindingPlan; values: Record<string, string>; preview: FormPreview; source: DocumentHandle; epoch: number }

/** The catalogue is loaded once by the editor, before revealing the tab. */
export function FormPanel({ discovery }: { discovery: FormDiscovery }) {
  const { engine, state, store, editable, replaceDocument, loadEpoch, loadSettled, t, onError } = useHwpEditorContext();
  const id = useId();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const document = state.document;
  useEffect(() => { generation.current++; setChoices({}); setReviewed(null); setError(null); setBusy(false); }, [discovery, document]);
  useEffect(() => { if (error !== null) errorRef.current?.focus(); }, [error]);
  const choice = (target: FormDiscovery["occurrences"][number]): Choice => choices[target.id] ?? { selected: false, value: target.old_text, max: Math.max(1, [...target.old_text].length), reflow: false };
  const update = (target: FormDiscovery["occurrences"][number], delta: Partial<Choice>) => {
    generation.current++; setReviewed(null); setError(null);
    setChoices(previous => ({ ...previous, [target.id]: { ...choice(target), ...delta } }));
  };
  const blocked = !editable || busy || state.status === "applying" || state.pendingOps.length > 0;
  const showError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "";
    const reason = /values\[|character_budget/.test(message) ? t("forms.invalidValue")
      : /stale_source/.test(message) ? t("forms.stale")
      : /overlapping_targets/.test(message) ? t("forms.overlap")
      : /numeric_constraint|constraints\[/.test(message) ? t("forms.constraint")
      : /unsupported_target/.test(message) ? t("forms.unsupported")
      : /Invalid form data/.test(message) ? t("forms.invalidPlan") : message;
    setError(t("forms.refused") + " " + reason + " " + t("forms.retry"));
    onError?.(cause);
  };
  const preview = async () => {
    if (blocked || document === null || !loadSettled() || !engine.applyFormBindings) return;
    const request = ++generation.current, epoch = loadEpoch();
    setReviewed(null); setError(null);
    try {
      const selected = discovery.occurrences.filter(target => choice(target).selected && target.bindable);
      if (selected.length === 0) throw new Error(t("forms.selectTarget"));
      const plan = parseFormBindingPlan({ version: 1, source_sha256: discovery.source_sha256, structural_sha256: discovery.structural_sha256,
        bindings: selected.map(target => ({ key: target.id, targets: [{ occurrence_id: target.id, copies: [0], max_chars: choice(target).max, allow_reflow: choice(target).reflow }] })), repeats: [], constraints: [] });
      const values = validateFormValues(plan, Object.fromEntries(selected.map(target => [target.id, choice(target).value])));
      setBusy(true);
      const result = await engine.applyFormBindings(document, plan, values, { dryRun: true });
      if (request !== generation.current || store.getState().document !== document || epoch !== loadEpoch()) return;
      if (result.receipt.published || result.document !== undefined) throw new Error(t("forms.retry"));
      setReviewed({ plan, values, preview: result.preview, source: document, epoch });
    } catch (cause) { if (request === generation.current) showError(cause); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const apply = async () => {
    if (reviewed === null || blocked || !engine.applyFormBindings) return;
    if (!loadSettled() || reviewed.epoch !== loadEpoch() || store.getState().document !== reviewed.source || store.getState().pendingOps.length > 0) { setReviewed(null); setError(t("forms.stale")); return; }
    const request = ++generation.current;
    setBusy(true); setError(null);
    try {
      await replaceDocument(async current => {
        if (current !== reviewed.source || reviewed.epoch !== loadEpoch()) throw new Error(t("forms.stale"));
        const result = await engine.applyFormBindings!(current, reviewed.plan, reviewed.values, { dryRun: false });
        if (!result.receipt.published || !result.document) throw new Error(t("forms.retry"));
        return result.document;
      });
      if (request === generation.current) setReviewed(null);
    } catch (cause) { if (request === generation.current) showError(cause); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <div className="hwped-panel" role="region" aria-label={t("forms.title")}>
    <h3 id={`${id}-heading`}>{t("forms.title")}</h3>
    <p className="hwped-hint">{t("forms.instructions")}</p>
    {state.pendingOps.length > 0 && <p>{t("forms.pending")}</p>}
    <form aria-labelledby={`${id}-heading`} onSubmit={event => { event.preventDefault(); void preview(); }}>
      {discovery.occurrences.map((target, index) => {
        const item = choice(target), prefix = `${id}-${index}`;
        return <fieldset key={target.id} disabled={blocked || !target.bindable} className="hwped-field">
          <legend>{target.label || target.kind} ({index + 1})</legend>
          <small className="hwped-form-identity">{target.id}</small>
          <p>{target.old_text}</p>
          {!target.bindable ? <p>{t("forms.unsupported")} ({target.cause}). {target.next_step}</p> : <>
            <div><input id={`${prefix}-select`} name={`${index}-selected`} type="checkbox" checked={item.selected} onChange={event => update(target, { selected: event.target.checked })} /><label htmlFor={`${prefix}-select`}>{t("forms.select")}</label></div>
            {target.label_ambiguous && <p className="hwped-hint">{t("forms.ambiguous")}</p>}
            <label htmlFor={`${prefix}-value`}>{t("forms.value")}</label>
            <textarea id={`${prefix}-value`} name={`${index}-value`} className="hwped-input" value={item.value} disabled={!item.selected} aria-describedby={`${prefix}-budget`} onChange={event => update(target, { value: event.target.value })} />
            <small id={`${prefix}-budget`}>{t("forms.budgetHint")} {Array.from(item.value).length}/{item.max}</small>
            <label htmlFor={`${prefix}-max`}>{t("forms.maxChars")}</label>
            <input id={`${prefix}-max`} name={`${index}-max`} type="number" className="hwped-input" min={1} max={20000} step={1} required disabled={!item.selected} value={item.max} onChange={event => update(target, { max: event.target.valueAsNumber })} />
            <div><input id={`${prefix}-reflow`} name={`${index}-reflow`} type="checkbox" checked={item.reflow} disabled={!item.selected} onChange={event => update(target, { reflow: event.target.checked })} /><label htmlFor={`${prefix}-reflow`}>{t("forms.reflow")}</label></div>
          </>}
        </fieldset>;
      })}
      <button className="hwped-btn" type="submit" disabled={blocked}>{t("forms.preview")}</button>
    </form>
    {reviewed !== null && <div aria-label={t("forms.preview")}>
      <p role="status">{t("forms.previewReady")}</p>
      <p className="hwped-hint">{t("forms.layoutUnverified")}</p>
      {reviewed.preview.changes.map((change, index) => <div key={index}><small className="hwped-form-identity">{change.occurrence_id} ({change.copy})</small><p><del>{change.old_text}</del> → <ins>{change.new_text}</ins></p></div>)}
      <button className="hwped-btn hwped-btn-primary" type="button" disabled={blocked} onClick={() => void apply()}>{t("forms.apply")}</button>
    </div>}
    {error !== null && <p role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
  </div>;
}
