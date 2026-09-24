/**
 * Typed edit operations mirroring every repeatable flag of `hwp edit`.
 *
 * Two serializations of the same `EditOp` union live here:
 *
 * - `opsToJson` emits the published `edit-ops-v1` JSON shape (hwp-cli
 *   schemas/edit-ops-v1.schema.json, pinned to hwp-cli v0.20.0): a flat array
 *   of flat tagged entries whose field names match the CLI's ops-channel
 *   names. `@hwp-editor/server`'s CliEngine writes this into the per-call
 *   work directory and passes it to `hwp edit --ops`. String payloads cross
 *   as data, so values containing `=>`, `=` or `:` are kept verbatim — the
 *   ambiguity the argv form's own caveat below warns about does not exist on
 *   this path.
 * - `opsToArgv`/`argvToOps` emit the separator-delimited `--flag value` argv
 *   form (flag spellings pinned to crates/hwp-cli/src/cli.rs `EditArgs`,
 *   lines ~569-676). The tauri host still crosses its bridge this way; its
 *   migration to the ops file is host work, not engine adoption.
 */

export type ParagraphAlignment =
  | "left"
  | "right"
  | "center"
  | "justify"
  | "distribute";

export type MetaKey = "title" | "author" | "subject" | "keywords";

export type CloneTableMode = "blank" | "keep";

/** Keys accepted by `--set-para` (cli.rs EditArgs::set_para doc). */
export type ParaShapeKey =
  | "line-spacing"
  | "indent"
  | "left"
  | "right"
  | "top"
  | "bottom";

/** Keys accepted by `--set-page` (cli.rs EditArgs::set_page doc). */
export type PageSetupKey =
  | "width"
  | "height"
  | "margin-left"
  | "margin-right"
  | "margin-top"
  | "margin-bottom"
  | "orientation";

export type EditOp =
  /** `--replace "find=>replace"` — replaces every match. */
  | { kind: "replace"; find: string; replace: string }
  /** `--set-cell "table:row:col=value"` — 0-based indices. */
  | { kind: "set-cell"; table: number; row: number; col: number; value: string }
  /** `--set-field "name=value"`. */
  | { kind: "set-field"; name: string; value: string }
  /** `--set-meta "key=value"`. */
  | { kind: "set-meta"; key: MetaKey; value: string }
  /** `--create-field "anchor=>name" | "anchor=>name=value"`. */
  | { kind: "create-field"; anchor: string; name: string; value?: string }
  /** `--create-bookmark "anchor=>name"`. */
  | { kind: "create-bookmark"; anchor: string; name: string }
  /** `--create-hyperlink "anchor=>URL" | "anchor=>text=>URL"`. */
  | { kind: "create-hyperlink"; anchor: string; url: string; text?: string }
  /** `--insert-image "anchor=>path" | "anchor=>path@WxH"` (mm). */
  | {
      kind: "insert-image";
      anchor: string;
      path: string;
      width?: number;
      height?: number;
    }
  /** `--seal "anchor=>path" | "anchor=>path@size"` (mm). */
  | { kind: "seal"; anchor: string; path: string; size?: number }
  /** `--set-format "find:property=value,..."`. */
  | { kind: "set-format"; find: string; props: Record<string, string> }
  /** `--set-align "find=alignment"`. */
  | { kind: "set-align"; find: string; alignment: ParagraphAlignment }
  /** `--insert-para "anchor=>text"` — after the anchor paragraph. */
  | { kind: "insert-para"; anchor: string; text: string }
  /** `--insert-para-before "anchor=>text"`. */
  | { kind: "insert-para-before"; anchor: string; text: string }
  /** `--delete-para "text"`. */
  | { kind: "delete-para"; text: string }
  /** `--add-row "table[:at[:count[:template_row]]]"` — at omitted or "end" appends. */
  | {
      kind: "add-row";
      table: number;
      at?: number | "end";
      count?: number;
      templateRow?: number;
    }
  /** `--add-col "table[:at[:count]]"`. */
  | { kind: "add-col"; table: number; at?: number | "end"; count?: number }
  /** `--delete-row "table:row"`. */
  | { kind: "delete-row"; table: number; row: number }
  /** `--delete-col "table:col"`. */
  | { kind: "delete-col"; table: number; col: number }
  /** `--merge-cells "table:r1:c1:r2:c2"`. */
  | {
      kind: "merge-cells";
      table: number;
      r1: number;
      c1: number;
      r2: number;
      c2: number;
    }
  /** `--split-cell "table:row:col"`. */
  | { kind: "split-cell"; table: number; row: number; col: number }
  /** `--add-table "anchor=>json"` — json is an array of row arrays. */
  | { kind: "add-table"; anchor: string; rows: string[][] }
  /** `--clone-table "source_table=>anchor[=>blank|keep]"`. */
  | {
      kind: "clone-table";
      sourceTable: number;
      anchor: string;
      mode?: CloneTableMode;
    }
  /** `--set-para "find=>key:value"`. */
  | { kind: "set-para"; find: string; key: ParaShapeKey; value: string }
  /** `--set-page "key:value"`. */
  | { kind: "set-page"; key: PageSetupKey; value: string }
  /** `--delete-image "anchor"`. */
  | { kind: "delete-image"; anchor: string }
  /** `--delete-table "n" | "anchor"`. */
  | { kind: "delete-table"; target: number | string }
  /** `--delete-field "name"`. */
  | { kind: "delete-field"; name: string }
  /** `--delete-bookmark "name"`. */
  | { kind: "delete-bookmark"; name: string };

/**
 * `--flag` spelling for each op kind (cli.rs EditArgs long names).
 *
 * Consumed by the tauri host's argv bridge. The CLI server's startup
 * handshake no longer reads this table — it checks the flags the engine
 * actually emits (`--ops` first), now that the server edit path crosses as
 * an edit-ops-v1 JSON file rather than as per-op argv.
 */
export const OP_FLAGS: Record<EditOp["kind"], string> = {
  "replace": "--replace",
  "set-cell": "--set-cell",
  "set-field": "--set-field",
  "set-meta": "--set-meta",
  "create-field": "--create-field",
  "create-bookmark": "--create-bookmark",
  "create-hyperlink": "--create-hyperlink",
  "insert-image": "--insert-image",
  "seal": "--seal",
  "set-format": "--set-format",
  "set-align": "--set-align",
  "insert-para": "--insert-para",
  "insert-para-before": "--insert-para-before",
  "delete-para": "--delete-para",
  "add-row": "--add-row",
  "add-col": "--add-col",
  "delete-row": "--delete-row",
  "delete-col": "--delete-col",
  "merge-cells": "--merge-cells",
  "split-cell": "--split-cell",
  "add-table": "--add-table",
  "clone-table": "--clone-table",
  "set-para": "--set-para",
  "set-page": "--set-page",
  "delete-image": "--delete-image",
  "delete-table": "--delete-table",
  "delete-field": "--delete-field",
  "delete-bookmark": "--delete-bookmark",
};

/** Serialize one op to its CLI value string (the part after the flag). */
function opValue(op: EditOp): string {
  switch (op.kind) {
    case "replace":
      return `${op.find}=>${op.replace}`;
    case "set-cell":
      return `${op.table}:${op.row}:${op.col}=${op.value}`;
    case "set-field":
      return `${op.name}=${op.value}`;
    case "set-meta":
      return `${op.key}=${op.value}`;
    case "create-field":
      return op.value === undefined
        ? `${op.anchor}=>${op.name}`
        : `${op.anchor}=>${op.name}=${op.value}`;
    case "create-bookmark":
      return `${op.anchor}=>${op.name}`;
    case "create-hyperlink":
      return op.text === undefined
        ? `${op.anchor}=>${op.url}`
        : `${op.anchor}=>${op.text}=>${op.url}`;
    case "insert-image": {
      const size =
        op.width === undefined || op.height === undefined
          ? ""
          : `@${op.width}x${op.height}`;
      return `${op.anchor}=>${op.path}${size}`;
    }
    case "seal":
      return op.size === undefined
        ? `${op.anchor}=>${op.path}`
        : `${op.anchor}=>${op.path}@${op.size}`;
    case "set-format": {
      const props = Object.entries(op.props)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      return `${op.find}:${props}`;
    }
    case "set-align":
      return `${op.find}=${op.alignment}`;
    case "insert-para":
    case "insert-para-before":
      return `${op.anchor}=>${op.text}`;
    case "delete-para":
      return op.text;
    case "add-row": {
      const parts: string[] = [String(op.table)];
      if (op.at !== undefined || op.count !== undefined || op.templateRow !== undefined) {
        parts.push(op.at === undefined ? "end" : String(op.at));
        if (op.count !== undefined || op.templateRow !== undefined) {
          parts.push(String(op.count ?? 1));
          if (op.templateRow !== undefined) parts.push(String(op.templateRow));
        }
      }
      return parts.join(":");
    }
    case "add-col": {
      const parts: string[] = [String(op.table)];
      if (op.at !== undefined || op.count !== undefined) {
        parts.push(op.at === undefined ? "end" : String(op.at));
        if (op.count !== undefined) parts.push(String(op.count));
      }
      return parts.join(":");
    }
    case "delete-row":
      return `${op.table}:${op.row}`;
    case "delete-col":
      return `${op.table}:${op.col}`;
    case "merge-cells":
      return `${op.table}:${op.r1}:${op.c1}:${op.r2}:${op.c2}`;
    case "split-cell":
      return `${op.table}:${op.row}:${op.col}`;
    case "add-table":
      return `${op.anchor}=>${JSON.stringify(op.rows)}`;
    case "clone-table":
      return op.mode === undefined
        ? `${op.sourceTable}=>${op.anchor}`
        : `${op.sourceTable}=>${op.anchor}=>${op.mode}`;
    case "set-para":
      return `${op.find}=>${op.key}:${op.value}`;
    case "set-page":
      return `${op.key}:${op.value}`;
    case "delete-image":
      return op.anchor;
    case "delete-table":
      return String(op.target);
    case "delete-field":
    case "delete-bookmark":
      return op.name;
  }
}

/**
 * Serialize ops to the exact `hwp edit` argv fragment: one `--flag value`
 * pair per op, in op order. The caller prepends
 * `["edit", input, "-o", output]` (and optionally `--verify` /
 * `--allow-partial`). Array form — no shell quoting is applied or needed.
 */
export function opsToArgv(ops: EditOp[]): string[] {
  const argv: string[] = [];
  for (const op of ops) {
    argv.push(OP_FLAGS[op.kind], opValue(op));
  }
  return argv;
}

/** One edit-ops-v1 array entry: a flat object tagged by its `op` field. */
type OpsEntry = Record<string, unknown>;

/**
 * A bare number gains the unit the CLI flag on this path already implies
 * (`--set-format size=16` is points, `--set-page width=210` is millimetres);
 * an already-suffixed value passes through. edit-ops-v1's `unit` fields are
 * suffixed strings, so this is where the two spellings meet.
 */
function withUnit(value: string, unit: "mm" | "pt" | "%"): string {
  return /^-?\d+(\.\d+)?$/.test(value) ? `${value}${unit}` : value;
}

/** set-format props: same keys as the CLI flag; only `size` needs a unit. */
function formatPropsEntry(props: Record<string, string>): OpsEntry {
  const out: OpsEntry = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = key === "size" ? withUnit(value, "pt") : value;
  }
  return out;
}

/** set-para: edit-ops-v1 keeps the two line-spacing spellings apart. */
function paraShapeEntry(key: ParaShapeKey, value: string): OpsEntry {
  switch (key) {
    case "line-spacing":
      return value.endsWith("pt")
        ? { line_spacing_pt: value }
        : { line_spacing_pct: withUnit(value, "%") };
    case "indent":
      return { indent_mm: withUnit(value, "mm") };
    case "left":
      return { left_mm: withUnit(value, "mm") };
    case "right":
      return { right_mm: withUnit(value, "mm") };
    case "top":
      return { top_mm: withUnit(value, "mm") };
    case "bottom":
      return { bottom_mm: withUnit(value, "mm") };
  }
}

function pageSetupEntry(key: PageSetupKey, value: string): OpsEntry {
  switch (key) {
    case "width":
      return { width_mm: withUnit(value, "mm") };
    case "height":
      return { height_mm: withUnit(value, "mm") };
    case "margin-left":
      return { margin_left_mm: withUnit(value, "mm") };
    case "margin-right":
      return { margin_right_mm: withUnit(value, "mm") };
    case "margin-top":
      return { margin_top_mm: withUnit(value, "mm") };
    case "margin-bottom":
      return { margin_bottom_mm: withUnit(value, "mm") };
    case "orientation":
      return { orientation: value };
  }
}

/** Serialize one op to its edit-ops-v1 entry. */
function opsEntry(op: EditOp): OpsEntry {
  switch (op.kind) {
    case "replace":
      return { op: "replace", from: op.find, to: op.replace };
    case "set-cell":
      return { op: "set_cell", table: op.table, row: op.row, col: op.col, text: op.value };
    case "set-field":
      return { op: "set_field", name: op.name, value: op.value };
    case "set-meta":
      return { op: "set_meta", key: op.key, value: op.value };
    case "create-field":
      return {
        op: "create_field",
        anchor: op.anchor,
        name: op.name,
        ...(op.value === undefined ? {} : { value: op.value }),
      };
    case "create-bookmark":
      return { op: "create_bookmark", anchor: op.anchor, name: op.name };
    case "create-hyperlink":
      return {
        op: "create_hyperlink",
        anchor: op.anchor,
        url: op.url,
        ...(op.text === undefined ? {} : { display: op.text }),
      };
    case "insert-image":
      return {
        op: "insert_image",
        anchor: op.anchor,
        path: op.path,
        ...(op.width === undefined || op.height === undefined
          ? {}
          : { width_mm: `${op.width}mm`, height_mm: `${op.height}mm` }),
      };
    case "seal":
      return {
        op: "seal",
        anchor: op.anchor,
        path: op.path,
        ...(op.size === undefined ? {} : { size_mm: `${op.size}mm` }),
      };
    case "set-format":
      return { op: "set_format", pattern: op.find, ...formatPropsEntry(op.props) };
    case "set-align":
      return { op: "set_align", pattern: op.find, align: op.alignment };
    case "insert-para":
      return { op: "insert_para", anchor: op.anchor, text: op.text };
    case "insert-para-before":
      return { op: "insert_para", anchor: op.anchor, text: op.text, before: true };
    case "delete-para":
      return { op: "delete_para", matching: op.text };
    case "add-row":
      return {
        op: "add_row",
        table: op.table,
        // The CLI's bare "end" is the schema's omitted `at`: both append.
        ...(typeof op.at === "number" ? { at: op.at } : {}),
        ...(op.count === undefined ? {} : { count: op.count }),
        ...(op.templateRow === undefined ? {} : { template_row: op.templateRow }),
      };
    case "add-col":
      return {
        op: "add_col",
        table: op.table,
        ...(typeof op.at === "number" ? { at: op.at } : {}),
        ...(op.count === undefined ? {} : { count: op.count }),
      };
    case "delete-row":
      return { op: "delete_row", table: op.table, row: op.row };
    case "delete-col":
      return { op: "delete_col", table: op.table, col: op.col };
    case "merge-cells":
      return {
        op: "merge_cells",
        table: op.table,
        r1: op.r1,
        c1: op.c1,
        r2: op.r2,
        c2: op.c2,
      };
    case "split-cell":
      return { op: "split_cell", table: op.table, row: op.row, col: op.col };
    case "add-table":
      return { op: "add_table", anchor: op.anchor, rows: op.rows };
    case "clone-table":
      return {
        op: "clone_table",
        source_table: op.sourceTable,
        anchor: op.anchor,
        ...(op.mode === undefined ? {} : { text_mode: op.mode }),
      };
    case "set-para":
      return { op: "set_para", pattern: op.find, ...paraShapeEntry(op.key, op.value) };
    case "set-page":
      return { op: "set_page", ...pageSetupEntry(op.key, op.value) };
    case "delete-image":
      return { op: "delete_image", anchor: op.anchor };
    case "delete-table":
      return typeof op.target === "number"
        ? { op: "delete_table", index: op.target }
        : { op: "delete_table", anchor: op.target };
    case "delete-field":
      return { op: "delete_field", name: op.name };
    case "delete-bookmark":
      return { op: "delete_bookmark", name: op.name };
  }
}

/**
 * Serialize ops to the published `edit-ops-v1` JSON document: a flat array
 * of flat tagged entries, in op order, whose field names match the hwp-cli
 * ops-channel names (schemas/edit-ops-v1.schema.json). `@hwp-editor/server`
 * writes the result into the per-call work directory and passes it to
 * `hwp edit --ops`; hwp-cli validates the file against the schema before
 * applying anything.
 */
export function opsToJson(ops: EditOp[]): string {
  return JSON.stringify(ops.map(opsEntry));
}

/** Split `s` on the first occurrence of `sep`; null when absent. */
function splitFirst(s: string, sep: string): [string, string] | null {
  const i = s.indexOf(sep);
  if (i < 0) return null;
  return [s.slice(0, i), s.slice(i + sep.length)];
}

/**
 * Parse an `hwp edit` argv fragment (as produced by opsToArgv) back into
 * typed ops. Inverse of opsToArgv for the structured value forms.
 *
 * Caveat: free-text fields (find/anchor/text/value) that themselves contain
 * the separators `=>`, `=`, or `:` are ambiguous — the CLI splits on those
 * separators too, so round-tripping such values is not guaranteed. Parsing
 * splits on the FIRST `=>` and the LAST `=` where the CLI grammar anchors
 * the left side.
 */
export function argvToOps(argv: string[]): EditOp[] {
  const ops: EditOp[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`argvToOps: flag ${flag} has no value`);
    }
    ops.push(parseOp(flag, value));
  }
  return ops;
}

function need<T>(v: T | null, flag: string | undefined, value: string): T {
  if (v === null) throw new Error(`argvToOps: malformed ${flag} value: ${value}`);
  return v;
}

function parseOp(flag: string | undefined, value: string): EditOp {
  switch (flag) {
    case "--replace": {
      const [find, replace] = need(splitFirst(value, "=>"), flag, value);
      return { kind: "replace", find, replace };
    }
    case "--set-cell": {
      const [coords, cellValue] = need(splitFirst(value, "="), flag, value);
      const [table, row, col] = coords.split(":").map(Number);
      return { kind: "set-cell", table: table!, row: row!, col: col!, value: cellValue };
    }
    case "--set-field": {
      const [name, fieldValue] = need(splitFirst(value, "="), flag, value);
      return { kind: "set-field", name, value: fieldValue };
    }
    case "--set-meta": {
      const [key, metaValue] = need(splitFirst(value, "="), flag, value);
      return { kind: "set-meta", key: key as MetaKey, value: metaValue };
    }
    case "--create-field": {
      const [anchor, rest] = need(splitFirst(value, "=>"), flag, value);
      const eq = splitFirst(rest, "=");
      return eq === null
        ? { kind: "create-field", anchor, name: rest }
        : { kind: "create-field", anchor, name: eq[0], value: eq[1] };
    }
    case "--create-bookmark": {
      const [anchor, name] = need(splitFirst(value, "=>"), flag, value);
      return { kind: "create-bookmark", anchor, name };
    }
    case "--create-hyperlink": {
      const parts = value.split("=>");
      if (parts.length === 3) {
        return { kind: "create-hyperlink", anchor: parts[0]!, text: parts[1]!, url: parts[2]! };
      }
      const [anchor, url] = need(splitFirst(value, "=>"), flag, value);
      return { kind: "create-hyperlink", anchor, url };
    }
    case "--insert-image": {
      const [anchor, rest] = need(splitFirst(value, "=>"), flag, value);
      const at = rest.match(/^(.*)@(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
      return at === null
        ? { kind: "insert-image", anchor, path: rest }
        : { kind: "insert-image", anchor, path: at[1]!, width: Number(at[2]), height: Number(at[3]) };
    }
    case "--seal": {
      const [anchor, rest] = need(splitFirst(value, "=>"), flag, value);
      const at = rest.match(/^(.*)@(\d+(?:\.\d+)?)$/);
      return at === null
        ? { kind: "seal", anchor, path: rest }
        : { kind: "seal", anchor, path: at[1]!, size: Number(at[2]) };
    }
    case "--set-format": {
      const [find, propsStr] = need(splitFirst(value, ":"), flag, value);
      const props: Record<string, string> = {};
      for (const pair of propsStr.split(",")) {
        const kv = splitFirst(pair, "=");
        if (kv !== null) props[kv[0]] = kv[1];
      }
      return { kind: "set-format", find, props };
    }
    case "--set-align": {
      const [find, alignment] = need(splitFirst(value, "="), flag, value);
      return { kind: "set-align", find, alignment: alignment as ParagraphAlignment };
    }
    case "--insert-para":
    case "--insert-para-before": {
      const [anchor, text] = need(splitFirst(value, "=>"), flag, value);
      return {
        kind: flag === "--insert-para" ? "insert-para" : "insert-para-before",
        anchor,
        text,
      };
    }
    case "--delete-para":
      return { kind: "delete-para", text: value };
    case "--add-row": {
      const parts = value.split(":");
      return {
        kind: "add-row",
        table: Number(parts[0]),
        ...(parts[1] !== undefined
          ? { at: parts[1] === "end" ? ("end" as const) : Number(parts[1]) }
          : {}),
        ...(parts[2] !== undefined ? { count: Number(parts[2]) } : {}),
        ...(parts[3] !== undefined ? { templateRow: Number(parts[3]) } : {}),
      };
    }
    case "--add-col": {
      const parts = value.split(":");
      return {
        kind: "add-col",
        table: Number(parts[0]),
        ...(parts[1] !== undefined
          ? { at: parts[1] === "end" ? ("end" as const) : Number(parts[1]) }
          : {}),
        ...(parts[2] !== undefined ? { count: Number(parts[2]) } : {}),
      };
    }
    case "--delete-row": {
      const [table, row] = value.split(":").map(Number);
      return { kind: "delete-row", table: table!, row: row! };
    }
    case "--delete-col": {
      const [table, col] = value.split(":").map(Number);
      return { kind: "delete-col", table: table!, col: col! };
    }
    case "--merge-cells": {
      const [table, r1, c1, r2, c2] = value.split(":").map(Number);
      return { kind: "merge-cells", table: table!, r1: r1!, c1: c1!, r2: r2!, c2: c2! };
    }
    case "--split-cell": {
      const [table, row, col] = value.split(":").map(Number);
      return { kind: "split-cell", table: table!, row: row!, col: col! };
    }
    case "--add-table": {
      const [anchor, json] = need(splitFirst(value, "=>"), flag, value);
      return { kind: "add-table", anchor, rows: JSON.parse(json) as string[][] };
    }
    case "--clone-table": {
      const parts = value.split("=>");
      return {
        kind: "clone-table",
        sourceTable: Number(parts[0]),
        anchor: parts[1]!,
        ...(parts[2] !== undefined ? { mode: parts[2] as CloneTableMode } : {}),
      };
    }
    case "--set-para": {
      const [find, rest] = need(splitFirst(value, "=>"), flag, value);
      const [key, keyValue] = need(splitFirst(rest, ":"), flag, value);
      return { kind: "set-para", find, key: key as ParaShapeKey, value: keyValue };
    }
    case "--set-page": {
      const [key, keyValue] = need(splitFirst(value, ":"), flag, value);
      return { kind: "set-page", key: key as PageSetupKey, value: keyValue };
    }
    case "--delete-image":
      return { kind: "delete-image", anchor: value };
    case "--delete-table": {
      const n = Number(value);
      return { kind: "delete-table", target: Number.isNaN(n) ? value : n };
    }
    case "--delete-field":
      return { kind: "delete-field", name: value };
    case "--delete-bookmark":
      return { kind: "delete-bookmark", name: value };
    default:
      throw new Error(`argvToOps: unknown flag ${flag}`);
  }
}
