import type { DocumentHandle } from "./engine.js";
import { HwpEngineError } from "./errors.js";
import { parseFormReceipt, parseFormPreview, type FormApplyOptions, type FormApplyResult } from "./forms.js";
import { decodeTemplateDocument } from "./http-engine.js";

export function formApplyOptions(document: DocumentHandle, options: FormApplyOptions): { dryRun: boolean; name: string } {
  const name = options.name ?? document.name;
  const format = (value: string) => /[.](hwpx|hwp)$/i.exec(value)?.[1]?.toLowerCase();
  if (typeof name !== "string" || !format(document.name) || format(name) !== format(document.name) || (options.dryRun !== undefined && typeof options.dryRun !== "boolean")) throw new HwpEngineError("bad_request", "Form binding requires same-format output and a boolean dryRun flag; correct the options and retry.");
  return { name, dryRun: options.dryRun === true };
}

export function decodeFormResult(raw: unknown, dryRun: boolean, source: string): FormApplyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HwpEngineError("failed", "Invalid form result; upgrade the host adapter and retry.");
  const value = raw as Record<string, unknown>;
  const receipt = parseFormReceipt(value.receipt), preview = parseFormPreview(value.preview);
  if (receipt.published !== !dryRun || receipt.source_sha256 !== source || preview.source_sha256 !== source || receipt.plan_sha256 !== preview.plan_sha256 || receipt.values_sha256 !== preview.values_sha256 || (dryRun && (value.dataBase64 !== undefined || value.name !== undefined))) throw new HwpEngineError("failed", "Form receipt identity or publication mode mismatch; rediscover targets and preview again.");
  return { receipt, preview, ...(dryRun ? {} : { document: decodeTemplateDocument(value, "form.document") }) };
}
