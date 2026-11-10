import type { DocumentHandle } from "./engine.js";

/** New template commands are verified against hwp-cli 1.4.0. */
export const TEMPLATE_MIN_VERSION = "1.4.0";
export const TEMPLATE_METHODS = ["slots", "fill", "template", "lint", "listTemplates", "create"] as const;
export type TemplateMethod = (typeof TEMPLATE_METHODS)[number];
export type LintProfile = "gongmun" | "report";

export interface TemplateInput {
  key: string;
  label: string;
  kind: "slot" | "field" | "form";
  required: boolean;
}
export interface TemplateInputs { items: TemplateInput[] }
export interface FillReport { replaced: number; counts: Record<string, number> }
export interface FillResult { document: DocumentHandle; report: FillReport }
export interface LintFinding {
  rule_id: string;
  severity: "error" | "warning";
  line: number;
  col: number;
  message: string;
  context?: string;
}
/** Findings have no verified segment coordinate; consumers must not guess links. */
export interface LintReport { findings: LintFinding[] }
export interface EmbeddedTemplate { id: string; label: string }

export function templateVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 1 || (major === 1 && Number(match[2]) >= 4);
}

/** Validator errors name only contract fields, never supplied file paths or payloads. */
function invalid(field: string): never {
  throw new Error(`Invalid template report: ${field}; upgrade the host/client to the hwp-cli 1.4.0 template contract and retry.`);
}
export function reportObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid(field);
  return raw as Record<string, unknown>;
}
export function reportString(raw: unknown, field: string): string {
  if (typeof raw !== "string") invalid(field);
  return raw;
}
export function reportCount(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) invalid(field);
  return raw;
}
export function reportArray(raw: unknown, field: string): unknown[] {
  if (!Array.isArray(raw)) invalid(field);
  return raw;
}
export function parseTemplateInputs(raw: unknown): TemplateInputs {
  const value = reportObject(raw, "inputs");
  const items = reportArray(value.items, "inputs.items").map((entry): TemplateInput => {
    const item = reportObject(entry, "inputs.items[]");
    const key = reportString(item.key, "input.key");
    const label = reportString(item.label, "input.label");
    if (key === "" || !["slot", "field", "form"].includes(String(item.kind)) || typeof item.required !== "boolean") invalid("input key/kind/required");
    return { key, label, kind: item.kind as TemplateInput["kind"], required: item.required };
  });
  return { items };
}
export function parseFillReport(raw: unknown): FillReport {
  const value = reportObject(raw, "fill");
  const counts = reportObject(value.counts, "fill.counts");
  return { replaced: reportCount(value.replaced, "fill.replaced"), counts: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, reportCount(count, "fill.counts[]")])) };
}
export function parseLintReport(raw: unknown): LintReport {
  const value = reportObject(raw, "lint");
  const findings = reportArray(value.findings, "lint.findings").map((entry): LintFinding => {
    const item = reportObject(entry, "lint.findings[]");
    if (item.severity !== "error" && item.severity !== "warning") invalid("finding.severity");
    return {
      rule_id: reportString(item.rule_id, "finding.rule_id"), severity: item.severity,
      line: reportCount(item.line, "finding.line"), col: reportCount(item.col, "finding.col"),
      message: reportString(item.message, "finding.message"),
      ...(item.context === undefined || item.context === null ? {} : { context: reportString(item.context, "finding.context") }),
    };
  });
  return { findings };
}
export function parseEmbeddedTemplates(raw: unknown): EmbeddedTemplate[] {
  return reportArray(raw, "templates").map(entry => {
    const item = reportObject(entry, "templates[]");
    const id = reportString(item.id, "template.id");
    if (!/^[a-z][a-z0-9-]*$/.test(id)) invalid("template.id");
    return { id, label: reportString(item.label, "template.label") };
  });
}
export function parseTemplateMethods(raw: unknown): TemplateMethod[] {
  return reportArray(raw, "capabilities.templateMethods").map(method => {
    if (!TEMPLATE_METHODS.includes(method as TemplateMethod)) invalid("capabilities.templateMethods[]");
    return method as TemplateMethod;
  });
}

export interface TemplateReport { schema_version: "1.0"; mode: "compose"; deterministic: boolean }
export function parseTemplateReport(raw: unknown): TemplateReport {
  const value = reportObject(raw, "template");
  if (value.schema_version !== "1.0" || value.mode !== "compose" || typeof value.deterministic !== "boolean") invalid("template.schema_version/mode/deterministic");
  return { schema_version: "1.0", mode: "compose", deterministic: value.deterministic };
}
