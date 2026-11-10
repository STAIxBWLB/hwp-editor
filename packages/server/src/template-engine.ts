import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TEMPLATE_MIN_VERSION, templateVersionSupported,
  parseFillReport, parseLintReport, parseTemplateReport, reportArray, reportCount, reportObject, reportString,
  opsToJson,
  type ComposeResult, type DocumentHandle, type EmbeddedTemplate, type FillResult,
  type LintProfile, type LintReport, type TemplateInputs, type TemplateSpecV1, type TemplateDataV1,
} from "@hwp-editor/core";
import { HwpCliError, type CliCallOptions } from "./cli-engine.js";

interface Dependencies {
  version(): Promise<string>;
  work<T>(fn: (dir: string) => Promise<T>): Promise<T>;
  stage(dir: string, document: DocumentHandle): Promise<string>;
  run(args: string[], call?: CliCallOptions): Promise<string>;
}

function bad(message: string): never {
  throw new HwpCliError("bad_request", message);
}
function parse<T>(stdout: string, parser: (raw: unknown) => T): T {
  try { return parser(JSON.parse(stdout)); }
  catch (error) {
    throw new HwpCliError("failed", error instanceof SyntaxError
      ? "hwp template command returned invalid JSON; use hwp-cli 1.4.0 and retry."
      : error instanceof Error ? error.message : "Invalid template report; upgrade hwp-cli and retry.");
  }
}
function outputName(name: string): string {
  // These new commands create HWPX output; caller names cannot name host paths.
  const base = path.basename(name).replace(/[^\w.가-힣-]/g, "_") || "document.hwpx";
  return base.replace(/\.(?:hwp|hwpx)$/i, "") + ".hwpx";
}
function valuesObject(values: Record<string, string>): void {
  if (typeof values !== "object" || values === null || Array.isArray(values) || Object.values(values).some(value => typeof value !== "string")) {
    bad("Fill values must be an object of strings; enter text values for the template inputs and retry.");
  }
}

function rejectAssetPaths(root: unknown): void {
  const pending: unknown[] = [root];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Object.hasOwn(value, "path")) bad("Template assets cannot name host files; use self-contained compose data without local asset paths.");
    pending.push(...Object.values(value));
  }
}

export function createTemplateCommands(deps: Dependencies) {
  async function requireVersion(): Promise<void> {
    if (!templateVersionSupported(await deps.version())) {
      throw new HwpCliError("version", `Template commands require hwp-cli >= ${TEMPLATE_MIN_VERSION}; upgrade HWP_EDITOR_BIN and retry.`);
    }
  }
  async function rawInputs(input: string, call?: CliCallOptions): Promise<TemplateInputs & { fieldCounts: Map<string, number> }> {
    const slots = parse(await deps.run(["slots", input, "--json", "--forms"], call), raw => {
      const value = reportObject(raw, "slots");
      const placeholders = reportArray(value.placeholders, "slots.placeholders").map(entry => {
        const row = reportObject(entry, "placeholder");
        const key = reportString(row.name, "placeholder.name");
        reportCount(row.occurrences, "placeholder.occurrences");
        return { key, label: key, kind: "slot" as const, required: false };
      });
      const forms = reportArray(value.fields, "slots.fields").map(entry => {
        const row = reportObject(entry, "form");
        const key = reportString(row.key, "form.key");
        const label = reportString(row.label, "form.label");
        const source = reportString(row.source, "form.source");
        reportCount(row.occurrences, "form.occurrences");
        if (typeof row.required !== "boolean" || typeof row.confidence !== "number" || !Number.isFinite(row.confidence)) throw new Error("Invalid template report: form.required/confidence; upgrade hwp-cli to 1.4.0 and retry.");
        return { key, label, kind: source === "placeholder" ? "slot" as const : "form" as const, required: row.required };
      });
      const byKey = new Map<string, TemplateInputs["items"][number]>(placeholders.map(item => [item.key, item]));
      for (const item of forms) byKey.set(item.key, item);
      return { items: [...byKey.values()] } as TemplateInputs;
    });
    const fields = parse(await deps.run(["fields", input, "--json"], call), raw => reportArray(raw, "fields").map(entry => {
      const field = reportObject(entry, "fields[]");
      const key = reportString(field.name, "field.name");
      reportString(field.kind, "field.kind");
      reportString(field.ctrl_id, "field.ctrl_id");
      reportString(field.value, "field.value");
      return { key, label: key, kind: "field" as const, required: false };
    }));
    const fieldCounts = new Map<string, number>();
    for (const field of fields) fieldCounts.set(field.key, (fieldCounts.get(field.key) ?? 0) + 1);
    const uniqueFields = [...new Map(fields.map(field => [field.key, field])).values()];
    return { items: [...slots.items, ...uniqueFields.filter(field => !slots.items.some(item => item.key === field.key))], fieldCounts };
  }
  return {
    async slots(document: DocumentHandle, call?: CliCallOptions): Promise<TemplateInputs> {
      await requireVersion();
      return deps.work(async dir => ({ items: (await rawInputs(await deps.stage(dir, document), call)).items }));
    },
    async fill(document: DocumentHandle, values: Record<string, string>, call?: CliCallOptions): Promise<FillResult> {
      await requireVersion();
      valuesObject(values);
      return deps.work(async dir => {
        const input = await deps.stage(dir, document);
        if (path.extname(input) !== ".hwpx") bad("hwp fill accepts HWPX input only; open an HWPX template before filling slots.");
        const inputs = await rawInputs(input, call);
        const keys = new Set(inputs.items.map(item => item.key));
        if (Object.keys(values).some(key => !keys.has(key))) bad("Fill contains an unknown input key; refresh the template inputs and retry.");
        const fieldNames = new Set(inputs.fieldCounts.keys());
        const slotValues = Object.fromEntries(Object.entries(values).filter(([key]) => inputs.items.some(item => item.key === key && item.kind !== "field")));
        const fieldOps = Object.entries(values).filter(([key]) => fieldNames.has(key)).map(([name, value]) => ({ kind: "set-field" as const, name, value }));
        let output = input;
        let report: FillResult["report"] = { replaced: 0, counts: {} };
        if (Object.keys(slotValues).length) {
          const data = path.join(dir, "data.json");
          output = path.join(dir, "filled.hwpx");
          await writeFile(data, JSON.stringify(slotValues), { mode: 0o600 });
          report = parse(await deps.run(["fill", input, "-o", output, "--data", data, "--forms", "--json"], call), parseFillReport);
        }
        if (fieldOps.length) {
          const opsFile = path.join(dir, "fields.json");
          const edited = path.join(dir, "fields.hwpx");
          await writeFile(opsFile, opsToJson(fieldOps), { mode: 0o600 });
          await deps.run(["edit", output, "-o", edited, "--ops", opsFile, "--verify"], call);
          output = edited;
          const counts = { ...report.counts };
          let replaced = report.replaced;
          for (const op of fieldOps) {
            const count = inputs.fieldCounts.get(op.name) ?? 0;
            Object.defineProperty(counts, op.name, { value: (Object.hasOwn(counts, op.name) ? counts[op.name]! : 0) + count, enumerable: true, configurable: true, writable: true });
            replaced += count;
          }
          report = { replaced, counts };
        }
        return { document: { name: outputName(document.name), data: new Uint8Array(await readFile(output)) }, report };
      });
    },
    async template(spec: TemplateSpecV1, data: TemplateDataV1, name: string, call?: CliCallOptions): Promise<ComposeResult> {
      await requireVersion();
      if (typeof spec !== "object" || spec === null || spec.version !== "1.0" || spec.source?.mode !== "compose") {
        bad("Only self-contained compose-mode TemplateSpec v1 is supported; load a spec with source.mode compose instead of a host file reference.");
      }
      if (typeof data !== "object" || data === null || data.version !== "1.0" || typeof data.values !== "object" || data.values === null) bad("TemplateData v1 requires version 1.0 and a values object; supply form values and retry.");
      rejectAssetPaths(spec.source.document);
      rejectAssetPaths(data.values);
      return deps.work(async dir => {
        const specFile = path.join(dir, "template.json"), dataFile = path.join(dir, "data.json");
        const output = path.join(dir, "template.hwpx");
        await writeFile(specFile, JSON.stringify(spec), { mode: 0o600 });
        await writeFile(dataFile, JSON.stringify(data), { mode: 0o600 });
        const report = parse(await deps.run(["template", specFile, "--data", dataFile, "-o", output, "--report"], call), parseTemplateReport);
        return { document: { name: outputName(name), data: new Uint8Array(await readFile(output)) }, report };
      });
    },
    async lint(document: DocumentHandle, profile: LintProfile = "gongmun", call?: CliCallOptions): Promise<LintReport> {
      await requireVersion();
      if (profile !== "gongmun" && profile !== "report") bad("Unknown lint profile; select gongmun or report and retry.");
      return deps.work(async dir => {
        const input = await deps.stage(dir, document);
        return parse(await deps.run(["lint", input, "--json", "--profile", profile], call), raw => {
          const value = reportObject(raw, "lint");
          if (value.contract !== "hwp-lint-report-v1" || value.schema_version !== "1.0") throw new Error("Invalid lint contract/schema_version; use hwp-cli 1.4.0 and retry.");
          return parseLintReport(value);
        });
      });
    },
    async listTemplates(call?: CliCallOptions): Promise<EmbeddedTemplate[]> {
      await requireVersion();
      const stdout = await deps.run(["new", "--list-templates"], call);
      const rows = stdout.trim().split(/\r?\n/).map(line => {
        const [id, label, ...rest] = line.split("\t");
        if (id === undefined || !/^[a-z][a-z0-9-]*$/.test(id) || !label || rest.length) throw new HwpCliError("failed", "Invalid embedded-template list; use hwp-cli 1.4.0 and retry.");
        return { id, label };
      });
      return rows;
    },
    async create(templateId: string, name: string, call?: CliCallOptions): Promise<DocumentHandle> {
      await requireVersion();
      if (!(await this.listTemplates(call)).some(item => item.id === templateId)) bad("Unknown embedded template; select an id from listTemplates and retry.");
      return deps.work(async dir => {
        const output = path.join(dir, "new.hwpx");
        await deps.run(["new", "--template", templateId, "-o", output], call);
        return { name: outputName(name), data: new Uint8Array(await readFile(output)) };
      });
    },
  };
}
