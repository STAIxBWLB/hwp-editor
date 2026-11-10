import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { LintProfile, LintReport } from "@hwp-editor/core";
import { ErrorLine } from "./ErrorLine.js";
import { toEditorError } from "./errors.js";
import { useHwpEditorContext } from "./context.js";
import { templateMethodStatus, templateStatusReason } from "./template-support.js";

export function LintPanel(): JSX.Element {
  const { engine, store, state, capabilities, onError, t } = useHwpEditorContext();
  const status = templateMethodStatus(engine, capabilities, "lint");
  const [profile, setProfile] = useState<LintProfile>("gongmun");
  const [report, setReport] = useState<LintReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toEditorError> | null>(null);
  const generation = useRef(0);
  const document = state.document;

  useEffect(() => {
    generation.current += 1;
    setReport(null);
    setBusy(false);
  }, [document, profile]);
  useEffect(() => () => { generation.current += 1; }, []);

  const run = async (): Promise<void> => {
    if (document === null || engine.lint === undefined || !status.supported) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setReport(null);
    try {
      const result = await engine.lint(document, profile);
      if (generation.current === current && store.getState().document === document) setReport(result);
    } catch (e) {
      if (generation.current === current) setError(toEditorError(e));
      onError?.(e);
    } finally { if (generation.current === current) setBusy(false); }
  };

  const errors = report?.findings.filter((item) => item.severity === "error") ?? [];
  const warnings = report?.findings.filter((item) => item.severity === "warning") ?? [];

  return (
    <div className="hwped-panel" role="region" aria-label={t("lint.panelAria")}>
      {!status.supported && <p className="hwped-hint">{t("lint.disabled", { reason: templateStatusReason(t, status, "lint"), remedy: t("templates.remedy") })}</p>}
      {status.supported && (
        <>
          <div className="hwped-row">
            <label className="hwped-label" htmlFor="hwped-lint-profile">{t("lint.profile")}</label>
            <select id="hwped-lint-profile" className="hwped-input" value={profile} onChange={(e) => setProfile(e.target.value as LintProfile)}>
              <option value="gongmun">{t("lint.gongmun")}</option>
              <option value="report">{t("lint.report")}</option>
            </select>
          </div>
          <button type="button" className="hwped-btn hwped-btn-primary" disabled={document === null || busy} onClick={() => void run()}>
            {busy ? t("lint.running") : t("lint.run")}
          </button>
          {report !== null && report.findings.length === 0 && <p className="hwped-hint">{t("lint.clean")}</p>}
          {errors.length > 0 && <section aria-label={t("lint.errors", { count: errors.length })}>
            <h3>{t("lint.errors", { count: errors.length })}</h3>
            <ul className="hwped-fields">{errors.map((finding, index) => <li className="hwped-field-item" key={`${finding.rule_id}-${index}`}>
              <strong>{finding.rule_id}</strong> <span>{t("lint.location", { line: finding.line, col: finding.col })}</span>
              <p>{finding.message}</p><small>{finding.context ?? t("lint.noContext")}</small>
            </li>)}</ul>
          </section>}
          {warnings.length > 0 && <section aria-label={t("lint.warnings", { count: warnings.length })}>
            <h3>{t("lint.warnings", { count: warnings.length })}</h3>
            <ul className="hwped-fields">{warnings.map((finding, index) => <li className="hwped-field-item" key={`${finding.rule_id}-${index}`}>
              <strong>{finding.rule_id}</strong> <span>{t("lint.location", { line: finding.line, col: finding.col })}</span>
              <p>{finding.message}</p><small>{finding.context ?? t("lint.noContext")}</small>
            </li>)}</ul>
          </section>}
        </>
      )}
      {error !== null && <ErrorLine prefix={t("error.prefix.lint")} {...error} />}
    </div>
  );
}
