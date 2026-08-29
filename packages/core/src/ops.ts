/**
 * Typed edit operations mirroring every repeatable flag of `hwp edit`.
 *
 * Flag spellings and value formats are pinned to hwp-cli v0.8.8,
 * crates/hwp-cli/src/cli.rs `EditArgs` (lines ~414-511). Each op serializes
 * to exactly one `--flag value` argv pair; repeatability is expressed by
 * emitting the flag once per op of that kind.
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
 * Published data, not an internal detail: `@hwp-editor/server`'s startup
 * handshake reads this table to check that the resolved binary actually
 * accepts every flag the grammar emits. Reading it here rather than copying
 * it there is the point — a hand-maintained second list would drift from the
 * grammar it is supposed to protect, and the drift would surface as a runtime
 * CLI failure instead of a refused binary. Adding an op kind therefore widens
 * the handshake automatically.
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
