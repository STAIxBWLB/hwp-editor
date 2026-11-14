import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formGrowthWithoutReflow, formBindingSupported, parseFormDiscovery, parseFormBindingPlan, parseFormReceipt, parseFormPreview, validateFormValues,
  type DocumentHandle, type FormBindingPlan, type FormApplyOptions, type FormApplyResult,
} from "@hwp-editor/core";
import { HwpCliError, type CliCallOptions } from "./cli-engine.js";

interface Dependencies {
  version(): Promise<string>;
  work<T>(fn: (dir: string) => Promise<T>): Promise<T>;
  stage(dir: string, document: DocumentHandle): Promise<string>;
  run(args: string[], call?: CliCallOptions): Promise<string>;
}

export function createFormCommands(deps: Dependencies) {
  async function run(args: string[], call?: CliCallOptions): Promise<string> {
    try { return await deps.run(args, call); }
    catch (error) {
      // ahwp 2.0.0 rejects --report for binding and emits no refused report.
      // No diagnostic prose is allowed to supply a class in its absence.
      if (error instanceof HwpCliError && error.reason === "failed") {
        const command = args[0] === "edit" ? "ahwp edit" : "ahwp slots";
        throw new HwpCliError("failed", `Form binding refused (engine_refused); ${command} failed without a supported structured refusal. Rediscover targets, review the plan and values, then preview again.`);
      }
      throw error;
    }
  }
  async function ready() {
    if (!formBindingSupported(await deps.version())) throw new HwpCliError("version", "Form binding requires agent-hwp 2.0.0; upgrade the engine and rediscover targets.");
  }
  function parse<T>(raw: string, parser: (value: unknown) => T): T {
    try { return parser(JSON.parse(raw)); }
    catch { throw new HwpCliError("failed", "Invalid form payload from engine; upgrade the adapter and rediscover targets."); }
  }
  return {
    async discoverForms(document: DocumentHandle, call?: CliCallOptions) {
      await ready();
      return deps.work(async dir => parse(await run(["slots", await deps.stage(dir, document), "--forms", "--occurrences", "--json"], call), parseFormDiscovery));
    },
    async applyFormBindings(document: DocumentHandle, rawPlan: FormBindingPlan, rawValues: Record<string, string>, options: FormApplyOptions = {}, call?: CliCallOptions): Promise<FormApplyResult> {
      await ready();
      let plan: FormBindingPlan, values: Record<string, string>;
      try { plan = parseFormBindingPlan(rawPlan); values = validateFormValues(plan, rawValues); }
      catch (error) { throw new HwpCliError("bad_request", error instanceof Error ? error.message : "Invalid binding plan; rediscover targets and retry."); }
      if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") throw new HwpCliError("bad_request", "Invalid dryRun flag; send a boolean and retry.");
      const ext = path.extname(document.name).toLowerCase();
      const name = options.name ?? document.name;
      if (typeof name !== "string" || ![".hwp", ".hwpx"].includes(ext) || path.extname(name).toLowerCase() !== ext) throw new HwpCliError("bad_request", "Form binding requires same-format output; choose the source format and retry.");
      const safeName = path.basename(name).replace(/[^\w.가-힣-]/g, "_") || `bound${ext}`;
      return deps.work(async dir => {
        const input = await deps.stage(dir, document);
        // Magic-byte staging is authoritative; a misleading file extension cannot convert formats.
        if (path.extname(input) !== ext) throw new HwpCliError("bad_request", "Form source name and bytes disagree; use the actual source format and retry.");
        // A typed preflight supplies the reflow cause without reading diagnostics.
        // Only a fresh, identical source catalogue can supply an original length.
        const discovery = parse(await run(["slots", input, "--forms", "--occurrences", "--json"], call), parseFormDiscovery);
        if (discovery.source_sha256 === plan.source_sha256 && discovery.structural_sha256 === plan.structural_sha256) {
          const occurrences = new Map(discovery.occurrences.map(item => [item.id, item]));
          for (const binding of plan.bindings) for (const target of binding.targets) {
            const occurrence = occurrences.get(target.occurrence_id);
            if (occurrence?.bindable && formGrowthWithoutReflow(occurrence.old_text, values[binding.key]!, target.allow_reflow)) {
              throw new HwpCliError("bad_request", `Form binding refused (growth_without_reflow; limit=${occurrence.old_text.length}); allow reflow, or keep the value within ${occurrence.old_text.length} characters (UTF-16 units), then preview again.`);
            }
          }
        }
        const output = path.join(dir, `bound${ext}`), receipt = path.join(dir, "receipt.json"), preview = path.join(dir, "preview.json"), ops = path.join(dir, "bindings.json");
        await writeFile(ops, JSON.stringify([{ op: "apply_form_bindings", plan, values, receipt, preview }]), { mode: 0o600 });
        await run(["edit", input, "-o", output, "--ops", ops, "--verify", ...(options.dryRun === true ? ["--dry-run"] : [])], call);
        const parsedReceipt = parse(await readFile(receipt, "utf8"), parseFormReceipt);
        const parsedPreview = parse(await readFile(preview, "utf8"), parseFormPreview);
        if (parsedReceipt.published !== (options.dryRun !== true)) throw new HwpCliError("failed", "Form publication receipt disagrees with requested mode; rediscover targets and retry.");
        return { receipt: parsedReceipt, preview: parsedPreview, ...(options.dryRun === true ? {} : { document: { name: safeName, data: new Uint8Array(await readFile(output)) } }) };
      });
    },
  };
}
