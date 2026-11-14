import type { DocumentHandle } from "./engine.js";
export interface FormOccurrence {
    id: string;
    kind: "cell_text" | "placeholder" | "inline_value" | "native_field";
    label: string;
    paragraph_id: string | null;
    section: number;
    indices: number[];
    model_route: string;
    table_id: string | null;
    table_index: number | null;
    row: number | null;
    col: number | null;
    start: number;
    end: number;
    old_text: string;
    prior_sha256: string;
    bindable: boolean;
    cause: "caption_target" | "raw_preserved_target" | "rich_target" | "native_field" | null;
    next_step: string | null;
    label_occurrences: number;
    label_ambiguous: boolean;
}
export interface FormDiscovery {
    version: 1;
    source_sha256: string;
    structural_sha256: string;
    occurrences: FormOccurrence[];
}
export interface FormTarget {
    occurrence_id: string;
    copies?: number[];
    max_chars: number;
    allow_reflow: boolean;
}
export interface FormBinding {
    key: string;
    targets: FormTarget[];
}
export interface FormRepeat {
    table_id: string;
    after_paragraph_id: string;
    copies: number;
    profile_ids: string[];
}
export type FormConstraint = {
    kind: "equal";
    left: string;
    right: string;
} | {
    kind: "sum";
    keys: string[];
    total: string;
};
export interface FormBindingPlan {
    version: 1;
    source_sha256: string;
    structural_sha256: string;
    bindings: FormBinding[];
    repeats?: FormRepeat[];
    constraints?: FormConstraint[];
}
export interface FormReceipt {
    version: 1;
    source_sha256: string;
    plan_sha256: string;
    values_sha256: string;
    output_sha256: string;
    published: boolean;
    occurrence_ids: string[];
    targets: number;
    cloned_profiles: number;
    semantic_budget: "selected_text_and_declared_clones_only";
    render_font_native: "unverified";
    native_warning_count: number;
}
export interface FormPreview {
    version: 1;
    source_sha256: string;
    plan_sha256: string;
    values_sha256: string;
    copies: Array<{
        source_table_id: string;
        copy: number;
        profile_id: string;
        table_id: string;
        section: number;
        indices: number[];
    }>;
    changes: Array<{
        occurrence_id: string;
        copy: number;
        profile_id: string | null;
        paragraph_id: string;
        section: number;
        indices: number[];
        row: number | null;
        col: number | null;
        start: number;
        end: number;
        old_text: string;
        new_text: string;
        max_chars: number;
        allow_reflow: boolean;
    }>;
    native_warnings: string[];
}
export interface FormApplyOptions {
    dryRun?: boolean;
    name?: string;
}
export interface FormApplyResult {
    document?: DocumentHandle;
    receipt: FormReceipt;
    preview: FormPreview;
}
const HASH = /^[0-9a-f]{64}$/;
const OCC = /^occ-[0-9a-f]{64}$/;
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function fail(path: string): never { throw new TypeError(`Invalid form data at ${path}`); }
function obj(x: unknown, path: string, allowed: string[], required: string[] = allowed): Record<string, unknown> {
    if (x === null || typeof x !== "object" || Array.isArray(x))
        fail(path);
    const o = x as Record<string, unknown>;
    if (Object.keys(o).some(k => !allowed.includes(k)) || required.some(k => !own(o, k)))
        fail(path);
    return o;
}
function scalarLength(value: string, path: string): number {
    let count = 0;
    for (let i = 0; i < value.length; i += 1) {
        const unit = value.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                fail(path);
            i += 1;
        }
        else if (unit >= 0xdc00 && unit <= 0xdfff)
            fail(path);
        count += 1;
    }
    return count;
}
function str(x: unknown, path: string, min = 0, max = Infinity): string {
    if (typeof x !== "string")
        fail(path);
    const length = scalarLength(x, path);
    if (length < min || length > max)
        fail(path);
    return x;
}
function int(x: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max)
        fail(path);
    return x;
}
function bool(x: unknown, path: string): boolean { if (typeof x !== "boolean")
    fail(path); return x; }
function nullable<T>(x: unknown, path: string, fn: (x: unknown, p: string) => T): T | null { return x === null ? null : fn(x, path); }
function arr(x: unknown, path: string, max: number): unknown[] { if (!Array.isArray(x) || x.length > max)
    fail(path); return x; }
function hash(x: unknown, path: string): string { const s = str(x, path, 64, 64); if (!HASH.test(s))
    fail(path); return s; }
function unique<T>(xs: T[], path: string): void { if (new Set(xs).size !== xs.length)
    fail(path); }
function key(x: unknown, path: string): string { return str(x, path, 1, 128); }
function identifier(x: unknown, path: string): string { return str(x, path, 1, 1024); }
function version(o: Record<string, unknown>): void { if (o.version !== 1)
    fail("version"); }
function indices(x: unknown, path: string): number[] { return arr(x, path, 32).map((v, i) => int(v, `${path}[${i}]`)); }
export function formBindingSupported(version: string): boolean {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    if (match === null)
        return false;
    const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
    if (major > 2 || (major === 2 && minor > 0))
        return true;
    if (major !== 2 || minor !== 0)
        return false;
    return patch > 0 || (patch === 0 && match[4] === undefined);
}
export function parseFormDiscovery(raw: unknown): FormDiscovery {
    const o = obj(raw, "discovery", ["version", "source_sha256", "structural_sha256", "occurrences"]);
    version(o);
    const occurrences = arr(o.occurrences, "occurrences", 20000).map((v, i): FormOccurrence => {
        const p = `occurrences[${i}]`, q = obj(v, p, ["id", "kind", "label", "paragraph_id", "section", "indices", "model_route", "table_id", "table_index", "row", "col", "start", "end", "old_text", "prior_sha256", "bindable", "cause", "next_step", "label_occurrences", "label_ambiguous"]);
        const id = str(q.id, `${p}.id`, 68, 68);
        if (!OCC.test(id))
            fail(`${p}.id`);
        const kind = str(q.kind, `${p}.kind`);
        if (!["cell_text", "placeholder", "inline_value", "native_field"].includes(kind))
            fail(`${p}.kind`);
        const bindable = bool(q.bindable, `${p}.bindable`);
        const cause = nullable(q.cause, `${p}.cause`, (x, z) => { const s = str(x, z); if (!["caption_target", "raw_preserved_target", "rich_target", "native_field"].includes(s))
            fail(z); return s as NonNullable<FormOccurrence["cause"]>; });
        const next_step = nullable(q.next_step, `${p}.next_step`, (x, z) => str(x, z, 1));
        if (bindable ? cause !== null || next_step !== null : cause === null || next_step === null)
            fail(p);
        if (kind === "native_field" && (bindable || next_step !== "hwp fields"))
            fail(p);
        const start = int(q.start, `${p}.start`), end = int(q.end, `${p}.end`);
        if (start > end)
            fail(p);
        const label = str(q.label, `${p}.label`), label_occurrences = int(q.label_occurrences, `${p}.label_occurrences`, 0, 20000), label_ambiguous = bool(q.label_ambiguous, `${p}.label_ambiguous`);
        if ((label === "" && (label_occurrences !== 0 || label_ambiguous)) || label_ambiguous !== (label_occurrences > 1))
            fail(p);
        return { id, kind: kind as FormOccurrence["kind"], label, paragraph_id: nullable(q.paragraph_id, `${p}.paragraph_id`, (x, z) => str(x, z, 1)), section: int(q.section, `${p}.section`), indices: indices(q.indices, `${p}.indices`), model_route: str(q.model_route, `${p}.model_route`, 1), table_id: nullable(q.table_id, `${p}.table_id`, (x, z) => str(x, z, 1)), table_index: nullable(q.table_index, `${p}.table_index`, (x, z) => int(x, z)), row: nullable(q.row, `${p}.row`, (x, z) => int(x, z, 0, 65535)), col: nullable(q.col, `${p}.col`, (x, z) => int(x, z, 0, 65535)), start, end, old_text: str(q.old_text, `${p}.old_text`), prior_sha256: hash(q.prior_sha256, `${p}.prior_sha256`), bindable, cause, next_step, label_occurrences, label_ambiguous };
    });
    unique(occurrences.map(x => x.id), "occurrences.id");
    return { version: 1, source_sha256: hash(o.source_sha256, "source_sha256"), structural_sha256: hash(o.structural_sha256, "structural_sha256"), occurrences };
}
export function parseFormBindingPlan(raw: unknown): FormBindingPlan {
    const o = obj(raw, "plan", ["version", "source_sha256", "structural_sha256", "bindings", "repeats", "constraints"], ["version", "source_sha256", "structural_sha256", "bindings"]);
    version(o);
    const bindings = arr(o.bindings, "bindings", 256).map((v, i): FormBinding => { const p = `bindings[${i}]`, b = obj(v, p, ["key", "targets"]), k = key(b.key, `${p}.key`); const targets = arr(b.targets, `${p}.targets`, 256).map((t, j): FormTarget => { const z = `${p}.targets[${j}]`, q = obj(t, z, ["occurrence_id", "copies", "max_chars", "allow_reflow"], ["occurrence_id", "max_chars", "allow_reflow"]); const copies = q.copies === undefined ? [0] : arr(q.copies, `${z}.copies`, 16).map((n, h) => int(n, `${z}.copies[${h}]`, 0, 15)); if (!copies.length)
        fail(z); unique(copies, `${z}.copies`); return { occurrence_id: identifier(q.occurrence_id, `${z}.occurrence_id`), ...(q.copies === undefined ? {} : { copies }), max_chars: int(q.max_chars, `${z}.max_chars`, 1, 20000), allow_reflow: bool(q.allow_reflow, `${z}.allow_reflow`) }; }); if (!targets.length)
        fail(`${p}.targets`); return { key: k, targets }; });
    unique(bindings.map(b => b.key), "bindings.key");
    const owners = new Set<string>();
    for (const b of bindings)
        for (const t of b.targets)
            for (const c of t.copies ?? [0]) {
                const owner = `${t.occurrence_id}\0${c}`;
                if (owners.has(owner))
                    fail("bindings.targets");
                owners.add(owner);
            }
    const repeats = o.repeats === undefined ? undefined : arr(o.repeats, "repeats", 16).map((v, i): FormRepeat => { const p = `repeats[${i}]`, r = obj(v, p, ["table_id", "after_paragraph_id", "copies", "profile_ids"]), copies = int(r.copies, `${p}.copies`, 1, 16), profiles = arr(r.profile_ids, `${p}.profile_ids`, 16).map((x, j) => key(x, `${p}.profile_ids[${j}]`)); if (profiles.length !== copies)
        fail(`${p}.profile_ids`); unique(profiles, `${p}.profile_ids`); return { table_id: identifier(r.table_id, `${p}.table_id`), after_paragraph_id: identifier(r.after_paragraph_id, `${p}.after_paragraph_id`), copies, profile_ids: profiles }; });
    const constraints = o.constraints === undefined ? undefined : arr(o.constraints, "constraints", 128).map((v, i): FormConstraint => { const p = `constraints[${i}]`; if (v && typeof v === "object" && !Array.isArray(v) && (v as any).kind === "equal") {
        const q = obj(v, p, ["kind", "left", "right"]);
        return { kind: "equal", left: key(q.left, `${p}.left`), right: key(q.right, `${p}.right`) };
    } if (v && typeof v === "object" && !Array.isArray(v) && (v as any).kind === "sum") {
        const q = obj(v, p, ["kind", "keys", "total"]), ks = arr(q.keys, `${p}.keys`, 256).map((x, j) => key(x, `${p}.keys[${j}]`));
        if (!ks.length)
            fail(`${p}.keys`);
        return { kind: "sum", keys: ks, total: key(q.total, `${p}.total`) };
    } return fail(p); });
    return { version: 1, source_sha256: hash(o.source_sha256, "source_sha256"), structural_sha256: hash(o.structural_sha256, "structural_sha256"), bindings, ...(repeats === undefined ? {} : { repeats }), ...(constraints === undefined ? {} : { constraints }) };
}
export function validateFormValues(plan: FormBindingPlan, raw: unknown): Record<string, string> {
    const o = obj(raw, "values", Object.keys(raw && typeof raw === "object" && !Array.isArray(raw) ? raw as object : {}));
    const expected = new Set(plan.bindings.map(b => b.key)), actual = Object.keys(o);
    if (actual.length !== expected.size || actual.some(k => !expected.has(k)))
        fail("values");
    const entries: Array<[
        string,
        string
    ]> = [];
    for (const [i, k] of actual.entries()) {
        const path = `values[${i}]`, v = str(o[k], path, 0, 20000);
        if (/[\u0000-\u0008\u000b-\u001f]/u.test(v))
            fail(path);
        entries.push([k, v]);
        const chars = scalarLength(v, path);
        for (const b of plan.bindings)
            if (b.key === k)
                for (const t of b.targets)
                    if (chars > t.max_chars)
                        fail(path);
    }
    const values = Object.fromEntries(entries) as Record<string, string>;
    const number = (k: string): bigint => { const s = values[k]; if (s === undefined || !/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/u.test(s))
        fail("values.numeric"); const n = BigInt(s.replaceAll(",", "")); if (n > 9223372036854775807n)
        fail("values.numeric"); return n; };
    for (const [i, c] of (plan.constraints ?? []).entries()) {
        const sum = (c.kind === "equal" ? [c.left, c.right] : [...c.keys, c.total]);
        if (sum.some(k => !expected.has(k)))
            fail(`constraints[${i}]`);
        if (c.kind === "equal") {
            if (number(c.left) !== number(c.right))
                fail(`constraints[${i}]`);
        }
        else {
            let n = 0n;
            for (const k of c.keys) {
                n += number(k);
                if (n > 9223372036854775807n)
                    fail(`constraints[${i}]`);
            }
            if (n !== number(c.total))
                fail(`constraints[${i}]`);
        }
    }
    return values;
}
function parseBoundedArtifact(raw: unknown, kind: "receipt" | "preview"): FormReceipt | FormPreview {
    if (kind === "receipt") {
        const o = obj(raw, "receipt", ["version", "source_sha256", "plan_sha256", "values_sha256", "output_sha256", "published", "occurrence_ids", "targets", "cloned_profiles", "semantic_budget", "render_font_native", "native_warning_count"]);
        version(o);
        const ids = arr(o.occurrence_ids, "occurrence_ids", 20000).map((x, i) => { const s = str(x, `occurrence_ids[${i}]`); if (!OCC.test(s))
            fail(`occurrence_ids[${i}]`); return s; });
        return { version: 1, source_sha256: hash(o.source_sha256, "source_sha256"), plan_sha256: hash(o.plan_sha256, "plan_sha256"), values_sha256: hash(o.values_sha256, "values_sha256"), output_sha256: hash(o.output_sha256, "output_sha256"), published: bool(o.published, "published"), occurrence_ids: ids, targets: int(o.targets, "targets"), cloned_profiles: int(o.cloned_profiles, "cloned_profiles"), semantic_budget: o.semantic_budget === "selected_text_and_declared_clones_only" ? o.semantic_budget : fail("semantic_budget"), render_font_native: o.render_font_native === "unverified" ? o.render_font_native : fail("render_font_native"), native_warning_count: int(o.native_warning_count, "native_warning_count") };
    }
    const o = obj(raw, "preview", ["version", "source_sha256", "plan_sha256", "values_sha256", "copies", "changes", "native_warnings"]);
    version(o);
    const copies = arr(o.copies, "copies", 256).map((v, i) => { const p = `copies[${i}]`, q = obj(v, p, ["source_table_id", "copy", "profile_id", "table_id", "section", "indices"]); return { source_table_id: str(q.source_table_id, `${p}.source_table_id`), copy: int(q.copy, `${p}.copy`, 0, 15), profile_id: str(q.profile_id, `${p}.profile_id`), table_id: str(q.table_id, `${p}.table_id`), section: int(q.section, `${p}.section`), indices: indices(q.indices, `${p}.indices`) }; });
    const changes = arr(o.changes, "changes", 20000).map((v, i) => { const p = `changes[${i}]`, q = obj(v, p, ["occurrence_id", "copy", "profile_id", "paragraph_id", "section", "indices", "row", "col", "start", "end", "old_text", "new_text", "max_chars", "allow_reflow"]); const id = str(q.occurrence_id, `${p}.occurrence_id`); if (!OCC.test(id))
        fail(`${p}.occurrence_id`); const old_text = str(q.old_text, `${p}.old_text`), new_text = str(q.new_text, `${p}.new_text`, 0, 20000); if (/[\u0000-\u0008\u000b-\u001f]/u.test(new_text))
        fail(`${p}.new_text`); const newLength = scalarLength(new_text, `${p}.new_text`); const max_chars = int(q.max_chars, `${p}.max_chars`, 1, 20000); if (newLength > max_chars)
        fail(`${p}.new_text`); const start = int(q.start, `${p}.start`), end = int(q.end, `${p}.end`); if (start > end)
        fail(p); return { occurrence_id: id, copy: int(q.copy, `${p}.copy`, 0, 15), profile_id: nullable(q.profile_id, `${p}.profile_id`, (x, z) => str(x, z)), paragraph_id: str(q.paragraph_id, `${p}.paragraph_id`), section: int(q.section, `${p}.section`), indices: indices(q.indices, `${p}.indices`), row: nullable(q.row, `${p}.row`, (x, z) => int(x, z)), col: nullable(q.col, `${p}.col`, (x, z) => int(x, z)), start, end, old_text, new_text, max_chars, allow_reflow: bool(q.allow_reflow, `${p}.allow_reflow`) }; });
    // Warning strings are intentionally omitted: native diagnostics may contain local paths.
    arr(o.native_warnings, "native_warnings", Number.MAX_SAFE_INTEGER).forEach(x => str(x, "native_warnings[]"));
    return { version: 1, source_sha256: hash(o.source_sha256, "source_sha256"), plan_sha256: hash(o.plan_sha256, "plan_sha256"), values_sha256: hash(o.values_sha256, "values_sha256"), copies, changes, native_warnings: [] };
}
export function parseFormReceipt(raw: unknown): FormReceipt { return parseBoundedArtifact(raw, "receipt") as FormReceipt; }
export function parseFormPreview(raw: unknown): FormPreview { return parseBoundedArtifact(raw, "preview") as FormPreview; }

/** Native no-growth permission counts WCHAR/UTF-16 units, unlike max_chars
 * which counts Unicode scalars. Only caller-reviewed source text decides this. */
export function formGrowthWithoutReflow(oldText: string, value: string, allowReflow: boolean): boolean {
    return !allowReflow && value.length > oldText.length;
}
