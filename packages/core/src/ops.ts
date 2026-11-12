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

import { HwpEngineError } from "./errors.js";
import type { Blocks, Style } from "./generated/document-spec-v2.js";
import type { StyleTablePreset } from "./styles.js";

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

type LegacyEditOp =
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

/** edit-ops-v1 paragraph address; ids retain the engine's drift check. */
export type ParagraphAddress =
  | { id: string; at?: never }
  | { at: { section: number; paragraph: number }; id?: never };

/** WCHAR [start, end) offsets within the source paragraph, not markdown. */
export type EditAddress = (
  | { id: string; at?: never }
  | { at: { section: number; paragraph: number; run: number }; id?: never }
) & { chars?: [number, number] };

export type AddressedEditOp =
  | { kind: "replace"; address: ParagraphAddress; find: string; replace: string }
  | { kind: "set-format"; address: EditAddress; props: Record<string, string> }
  | { kind: "set-align"; address: ParagraphAddress; alignment: ParagraphAlignment }
  | { kind: "set-para"; address: ParagraphAddress; key: ParaShapeKey; value: string }
  | { kind: "insert-para" | "insert-para-before"; address: ParagraphAddress; text: string }
  | { kind: "delete-para" | "indent-para" | "outdent-para"; address: ParagraphAddress }
  | { kind: "move-para"; address: ParagraphAddress;
      to: { address: ParagraphAddress; position: "before" | "after" } }
  /**
   * `insert_blocks`: place DocumentSpec v1 blocks beside the addressed
   * paragraph. Measured on `ahwp 1.6.0`, whose `edit-ops-v1` schema fixes the
   * entry as `{op, address, position, blocks}` plus the optional `styles`,
   * `lists` and `missing_style`. `styles` carries the definitions a target may
   * lack — a component's own `styles` — and a name the target already defines
   * keeps the target's definition; `missing_style: "refuse"` turns a name
   * neither side defines into a refusal instead of a silent creation. The
   * engine answers with an `insert_blocks` outcome whose `changed` pairs carry
   * `before: null` and the ids of every inserted segment, which is the only
   * way the caller learns which ids the insertion created.
   */
  | { kind: "insert-blocks"; address: ParagraphAddress; position: "before" | "after";
      blocks: Blocks; styles?: Record<string, Style>;
      missingStyle?: "create" | "refuse" };

/** Legacy text selectors remain available for explicit search operations. */
export type EditOp = LegacyEditOp | AddressedEditOp | StyleEditOp;

/** A named style as the engine addresses it: exact primary name or header id. */
export type StyleRef = string | number;

/**
 * Character and paragraph properties a named-style op may set, spelled as the
 * edit-ops-v1 flat vocabulary spells them. A style op writes only the fields
 * it carries; the engine keeps the rest of the definition, so an update is a
 * patch rather than a replacement.
 */
export interface StyleProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Points, e.g. "12pt"; a bare decimal is read as points. */
  size?: string;
  /** "#RRGGBB". */
  color?: string;
  /** Font face, written into every language slot. */
  font?: string;
  /** Line height as a percentage, e.g. "160"; exclusive with `lineSpacingPt`. */
  lineSpacingPct?: string;
  /** Absolute line height in points, e.g. "18pt"; exclusive with `lineSpacingPct`. */
  lineSpacingPt?: string;
  indentMm?: string;
  leftMm?: string;
  rightMm?: string;
  topMm?: string;
  bottomMm?: string;
  align?: ParagraphAlignment;
}

/**
 * Named-style operations. They exist only in the edit-ops-v1 JSON channel:
 * `hwp edit` has no per-op flags for them, so the argv bridge refuses them.
 *
 * Character styles are refused by the engine (hwp-cli 1.4.0 T3 supports
 * paragraph kinds only), which is why `styleKind` exists but is not offered by
 * this editor's own controls: a caller that asks for one gets the engine's
 * actionable refusal instead of a silently paragraph-only create.
 *
 * `style-tables` is the preset switch as an op rather than as the
 * `--style-tables` flag, and the difference is load-bearing: the flag and
 * `--ops` are mutually exclusive, so a preset sent that way cannot travel with
 * the body-style update and the engine aborts the whole call when the document
 * has no multi-column table. As an op it shares one batch with the style ops,
 * so both land in one atomic edit, and a document with nothing to style is one
 * unapplied op the caller can report instead of a lost edit.
 */
export type StyleEditOp =
  | ({ kind: "create-style"; name: string; basedOn?: StyleRef; styleKind?: "paragraph" | "character" } & StyleProps)
  | ({ kind: "update-style"; style: StyleRef } & StyleProps)
  | { kind: "apply-style"; address: ParagraphAddress; style: StyleRef; clearDirect?: boolean }
  | { kind: "style-tables"; preset: StyleTablePreset };

/**
 * `--flag` spelling for each op kind (cli.rs EditArgs long names).
 *
 * Consumed by the tauri host's argv bridge. The CLI server's startup
 * handshake no longer reads this table — it checks the flags the engine
 * actually emits (`--ops` first), now that the server edit path crosses as
 * an edit-ops-v1 JSON file rather than as per-op argv.
 */
export const OP_FLAGS: Record<LegacyEditOp["kind"], string> = {
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

type ArgvSeparatorField = {
  field: string;
  value: string | undefined;
  separator: string;
  when?: (value: string) => boolean;
};

/** Structural separators consumed by the v1.4.0 hwp-cli argv parsers. */
function argvSeparatorFields(op: LegacyEditOp): ArgvSeparatorField[] {
  switch (op.kind) {
    case "replace":
      return [{ field: "find", value: op.find, separator: "=>" }];
    case "set-field":
      return [{ field: "name", value: op.name, separator: "=" }];
    case "set-meta":
      return [{ field: "key", value: op.key, separator: "=" }];
    case "create-field":
      return [
        { field: "anchor", value: op.anchor, separator: "=>" },
        { field: "name", value: op.name, separator: "=>" },
        { field: "name", value: op.name, separator: "=" },
      ];
    case "create-bookmark":
      // `--create-bookmark` is split once, into anchor and name, so the name is
      // the tail and may hold the separator itself (edit.rs
      // `EditOperation::CreateBookmark`: `split_once("=>")`).
      return [{ field: "anchor", value: op.anchor, separator: "=>" }];
    case "create-hyperlink":
      return [
        { field: "anchor", value: op.anchor, separator: "=>" },
        { field: "text", value: op.text, separator: "=>" },
        { field: "url", value: op.url, separator: "=>" },
      ];
    case "insert-image": {
      const fields: ArgvSeparatorField[] = [{ field: "anchor", value: op.anchor, separator: "=>" }];
      if (op.width === undefined || op.height === undefined) {
        fields.push({
          field: "path", value: op.path, separator: "@",
          when: path => imagePathHasDimensionSuffix(path),
        });
      }
      return fields;
    }
    case "seal": {
      const fields: ArgvSeparatorField[] = [{ field: "anchor", value: op.anchor, separator: "=>" }];
      if (op.size === undefined) {
        fields.push({
          field: "path", value: op.path, separator: "@",
          when: path => sealPathHasSizeSuffix(path),
        });
      }
      return fields;
    }
    case "set-format":
      return [
        { field: "find", value: op.find, separator: ":" },
        ...Object.entries(op.props).flatMap(([key, value]) => [
          { field: `props.${key}.key`, value: key, separator: "=" },
          { field: `props.${key}.key`, value: key, separator: "," },
          { field: `props.${key}.value`, value, separator: "," },
        ]),
      ];
    case "set-align":
      return [{ field: "find", value: op.find, separator: "=" }];
    case "insert-para":
    case "insert-para-before":
      return [{ field: "anchor", value: op.anchor, separator: "=>" }];
    case "add-table":
      return [{ field: "anchor", value: op.anchor, separator: "=>" }];
    case "clone-table":
      return [{ field: "anchor", value: op.anchor, separator: "=>" }];
    case "set-para":
      return [
        { field: "find", value: op.find, separator: "=>" },
        { field: "value", value: op.value, separator: "," },
      ];
    // Kinds whose value joins nothing: every field they carry is positional
    // (set-cell, merge-cells, add-row, set-page) or a single value the engine
    // reads whole (delete-image, delete-field, delete-bookmark). `delete-table`
    // takes one value too, and the index/anchor ambiguity that value has is
    // refused in `argvDeleteTableTarget`.
    case "set-cell":
    case "delete-para":
    case "add-row":
    case "add-col":
    case "delete-row":
    case "delete-col":
    case "merge-cells":
    case "split-cell":
    case "set-page":
    case "delete-image":
    case "delete-table":
    case "delete-field":
    case "delete-bookmark":
      return [];
    default: {
      // Exhaustive on purpose: a new op kind has to say what its value joins
      // on, because a fallback here would let it join on a structural
      // separator that this guard never sees.
      const unhandled: never = op;
      throw new Error(`argvSeparatorFields: unhandled op kind ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The split `parse_image_size` makes of one `--insert-image` value (#108): the
 * last `@` separates the path, the first `x` or `X` separates the two
 * dimensions, and each side is trimmed the way `w.trim().parse::<f32>()` trims
 * it. A side f32 cannot read, a missing `@` or a missing `x` leaves the whole
 * value as a natural-size path, which is what the engine does.
 */
function imageSizeText(value: string): { path: string; width: string; height: string } | null {
  const at = value.lastIndexOf("@");
  if (at < 0) return null;
  const dims = value.slice(at + 1);
  const x = dims.search(/[xX]/);
  if (x < 0) return null;
  const width = rustTrim(dims.slice(0, x));
  const height = rustTrim(dims.slice(x + 1));
  if (!isRustFloat(width) || !isRustFloat(height)) return null;
  return { path: value.slice(0, at), width, height };
}

/**
 * The split `parse_seal_size` makes of one `--seal` value (#108): the last `@`
 * separates the path, then one case-sensitive `mm` comes off the trimmed suffix
 * and the rest is trimmed and read as f32 (`raw.trim().strip_suffix("mm")`, then
 * `num.trim().parse::<f32>()`, in `edit.rs`). Without a number there, the whole
 * value is the path and the size stays the engine's default.
 */
function sealSizeText(value: string): { path: string; size: string } | null {
  const at = value.lastIndexOf("@");
  if (at < 0) return null;
  const trimmed = rustTrim(value.slice(at + 1));
  const size = rustTrim(trimmed.endsWith("mm") ? trimmed.slice(0, -2) : trimmed);
  return isRustFloat(size) ? { path: value.slice(0, at), size } : null;
}

/** Whether the engine reads a size out of this path, so writing it whole would be split. */
function imagePathHasDimensionSuffix(path: string): boolean {
  return imageSizeText(path) !== null;
}

function sealPathHasSizeSuffix(path: string): boolean {
  return sealSizeText(path) !== null;
}

/** The `insert-image` fields `parse_image_size` fills, or null when it reads no dimensions (#108). */
function splitImageSize(value: string): { path: string; width: number; height: number } | null {
  const split = imageSizeText(value);
  return split === null
    ? null
    : { path: split.path, width: rustFloat(split.width), height: rustFloat(split.height) };
}

/** The `seal` fields `parse_seal_size` fills, or null when it reads no size (#108). */
function splitSealSize(value: string): { path: string; size: number } | null {
  const split = sealSizeText(value);
  return split === null ? null : { path: split.path, size: rustFloat(split.size) };
}

/**
 * The f64 reading of a size text `isRustFloat` accepted; the engine reads that
 * value rounded to f32 (#108, #110).
 *
 * `f32::from_str` is a correctly rounded read of the text, so the two agree
 * only where rounding to f32 does not move the value, which is not the same as
 * "inside the f32 range": `0.1` is 0.1 here and 0.10000000149011612 to the
 * engine, `stamp@1e39` is infinity there, and `stamp@1e-50` is 0. None of that
 * changes what this side decides, because the path and size split only asks
 * whether the text is a number, and `opsToArgv` prints the number back for the
 * engine to read. That print is the shortest decimal for the f64 value, so it
 * lands on the same f32 unless the text sits within about half an f64 ulp of an
 * f32 midpoint, where it can double-round: the 17-digit `1.0000000596046447` is
 * 1 to the engine, this side reads 1+2^-24, prints 1.0000000596046448, and the
 * engine reads 1.0000001.
 *
 * The infinite spellings are mapped by hand because `Number("inf")` is NaN,
 * which is a different value the engine never produces: `inf` and `infinity`,
 * either case and either sign, are sizes there. `nan` needs no mapping.
 *
 * No f32 overflow is mapped here: this value also feeds the edit-ops-v1
 * channel's `numericUnit`, where narrowing `stamp@1e39` to Infinity would turn
 * a size the engine accepts into `withUnit`'s refusal. A non-finite size has no
 * plain-decimal form, so that channel refuses it anyway; the argv channel
 * carries it because the engine does.
 */
function rustFloat(text: string): number {
  if (/^[+-]?inf(?:inity)?$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  return Number(text);
}

/**
 * The `str::trim` hwp-cli applies before it reads a value: the Unicode
 * White_Space set, which JavaScript's `trim()` does not match.
 *
 * `\s` and `String.prototype.trim` exclude U+0085 and include U+FEFF, while
 * Rust does the opposite, so each of those two characters makes the engine read
 * a value differently than this guard does: `"3\u0085"` is the index 3 to the
 * engine and an anchor letter here, and `"\uFEFF3"` is the anchor it looks like
 * here but not an index to the engine (#103 item 2). The set below is the 25
 * code points `char::is_whitespace` returns, enumerated with `rustc` 1.99:
 * U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000..U+200A, U+2028,
 * U+2029, U+202F, U+205F, U+3000.
 */
const RUST_WHITESPACE = new Set<number>([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function rustTrim(value: string): string {
  // Each end is scanned once. A regex alternation over the same set instead
  // backtracks across a long interior whitespace run, which a hostile or
  // generated anchor can carry (#103 review t47-a1). Every code point in the
  // set is in the BMP, so `charCodeAt` reads one scalar per step and a
  // surrogate half at either end is never stripped.
  let start = 0;
  let end = value.length;
  while (start < end && RUST_WHITESPACE.has(value.charCodeAt(start))) start += 1;
  while (end > start && RUST_WHITESPACE.has(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function isRustFloat(value: string): boolean {
  return /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i.test(value);
}

/** `usize::MAX`: every platform hwp-cli ships a binary for is 64-bit. */
const USIZE_MAX = 18_446_744_073_709_551_615n;

/**
 * Whether hwp-cli would read this `--delete-table` value as a table index.
 *
 * The flag carries one value and the engine decides what it means by whether
 * it parses as a `usize` (`edit.rs` `EditOperation::DeleteTable`:
 * `spec.trim().parse::<usize>()` selects `ObjectKind::TableNth(n)`, anything
 * else is an anchor), which `cli.rs` documents as `"n" (0-based index) or
 * "anchor"`. Rust's `usize` grammar is an optional `+` and then decimal
 * digits, so `3`, `+3` and `007` are indices while `3.5`, `-1` and the empty
 * string are anchors.
 */
function parsesAsUsize(value: string): boolean {
  if (!/^\+?[0-9]+$/.test(value)) return false;
  return BigInt(value.replace(/^\+/, "")) <= USIZE_MAX;
}

/**
 * The index `parse::<usize>` makes of a value `parsesAsUsize` accepted, so a
 * refusal can print the table the engine would act on rather than the text:
 * `+3` and `007` both reach table 3 (#103 item 4).
 */
function usizeValue(value: string): string {
  return BigInt(value).toString();
}

/**
 * The one value `--delete-table` can carry for this target.
 *
 * The argv form has no way to say "this anchor is the text 3": the engine reads
 * a value that parses as a `usize` as a 0-based index, so such an anchor would
 * silently delete another table. A number that is not a `usize` is the same
 * problem from the other side, because the engine would read it as an anchor
 * name and match no paragraph. Both are refused before serialization, and the
 * edit-ops-v1 JSON transport carries either form without the ambiguity.
 */
function argvDeleteTableTarget(target: number | string): string {
  const value = String(target);
  const trimmed = rustTrim(value);
  if (typeof target === "string" && parsesAsUsize(trimmed)) {
    const cause = new Error(`delete-table anchor ${JSON.stringify(target)} is read as table index ${usizeValue(trimmed)}`);
    throw new HwpEngineError(
      "bad_request",
      `${cause.message}, so the anchor cannot be addressed in the argv form; pick an anchor that is not a number or upgrade the host to the edit-ops-v1 JSON transport.`,
      { cause },
    );
  }
  if (typeof target === "number" && !parsesAsUsize(value)) {
    const cause = new Error(`delete-table target ${value} is not a 0-based table index`);
    throw new HwpEngineError(
      "bad_request",
      `${cause.message}, so the argv form would read it as an anchor paragraph name; use a non-negative integer index or upgrade the host to the edit-ops-v1 JSON transport.`,
      { cause },
    );
  }
  return value;
}

function validateArgvSeparators(op: LegacyEditOp): void {
  for (const { field, value, separator, when } of argvSeparatorFields(op)) {
    if (value !== undefined && value.includes(separator) && (when === undefined || when(value))) {
      const cause = new Error(`${op.kind} ${field} contains the structural argv separator ${JSON.stringify(separator)}`);
      throw new HwpEngineError(
        "bad_request",
        `${cause.message}; remove the separator or upgrade the host to the edit-ops-v1 JSON transport.`,
        { cause },
      );
    }
  }
}

/** One caller-supplied field of an argv op, named for a refusal message. */
type ArgvLineBreakField = { field: string; value: string };

/**
 * The argv fields whose value the engine prints with `Display`, which is the
 * only way a CR or LF in one of them reaches stderr as a line of its own
 * (#115 item 2). Everything else is echoed with `{:?}`, which escapes a line
 * break onto the engine's own line, or is not echoed at all.
 *
 * Measured kind by kind against `crates/hwp-cli/src/commands/edit.rs` and
 * ahwp 1.6.1, reading how each confirmation line interpolates the caller's
 * text:
 *
 * - `Display`, so refused: `set-meta`, whose `:1394` line is
 *   `메타데이터 설정: {spec}` with `spec` the raw `key=value`. A LF in the
 *   value is printed verbatim, so `--set-meta "author=a<LF>Error: <sentence>"`
 *   puts a line of the caller's text on stderr, above the line Termination
 *   writes when a later op fails.
 * - `Debug` (`{:?}`, escaped onto one line): every other kind that echoes a
 *   value, namely `replace` (:1216), `set-cell` (:1235), `set-field` (:1377),
 *   `create-field` (:1294), `create-bookmark` (:1310), `create-hyperlink`
 *   (:1332), `insert-image` (:1348), `seal` (:1361), `set-format` (:1416),
 *   `set-align` (:1441), `insert-para` and `insert-para-before` (:1480,
 *   :1463), `delete-para` (:1498), `add-table` (:1599), `clone-table` (:1616),
 *   `delete-image` (:1704), `delete-table` (:1726), `delete-field` (:1740),
 *   `delete-bookmark` (:1757), plus the unapplied list any kind can land in
 *   (`:2021`, whose `{request}` is built with `{:?}` fields).
 * - Parsed numbers only, so nothing of the caller's reaches a line: `add-row`,
 *   `add-col`, `delete-row`, `delete-col`, `merge-cells`, `split-cell`, and
 *   `set-page`, which prints a count (`:1682`).
 *
 * Two fields sit on a raw insertion but are not refused here, because the
 * engine's own validator answers first with a `{:?}`-quoted message and the
 * echo is never reached. Both were measured on ahwp 1.6.1:
 *
 * - `set-meta`'s `key`: `--set-meta "auth<LF>or=v"` is refused as
 *   `Error: 메타데이터 키는 title|author|subject|keywords 입니다: "auth\nor"`,
 *   so the spec is never printed.
 * - `set-para`'s `value`, which arrives inside the raw `kv` tail of
 *   `문단 모양: {pattern:?} {kv}` (`:1632`). Reaching that line means
 *   `parse::<f32>` already read the value, and a LF inside it makes that
 *   refuse (`Error: mm 값이 숫자가 아닙니다: "1\nError: ..."`). A trailing LF
 *   alone survives `str::trim` and adds a blank line after text the engine
 *   wrote, which plants nothing.
 *
 * Nothing beyond those is scoped in. `--insert-para "anchor=>a<LF>b"` is
 * accepted by the engine and stores a real paragraph break, echoing it with
 * `{:?}`, so paragraph text is a value a line break legitimately belongs to
 * and `opsToArgv` keeps serializing it.
 *
 * Exhaustive on purpose (the `never` default), like `argvSeparatorFields`: a
 * new op kind has to say whether its echo is `Display`, because a fallback
 * would let one reach stderr unrefused.
 */
function argvLineBreakFields(op: LegacyEditOp): ArgvLineBreakField[] {
  switch (op.kind) {
    case "set-meta":
      return [{ field: "value", value: op.value }];
    // `{:?}`-escaped echoes: a CR or LF stays inside one line of the engine's.
    case "replace":
    case "set-cell":
    case "set-field":
    case "create-field":
    case "create-bookmark":
    case "create-hyperlink":
    case "insert-image":
    case "seal":
    case "set-format":
    case "set-align":
    case "insert-para":
    case "insert-para-before":
    case "delete-para":
    case "add-table":
    case "clone-table":
    case "set-para":
    case "delete-image":
    case "delete-table":
    case "delete-field":
    case "delete-bookmark":
    // Parsed numbers, or a count: no caller text on the line at all.
    case "add-row":
    case "add-col":
    case "delete-row":
    case "delete-col":
    case "merge-cells":
    case "split-cell":
    case "set-page":
      return [];
    default: {
      const unhandled: never = op;
      throw new Error(`argvLineBreakFields: unhandled op kind ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Refuse a line break in a value the engine would print with `Display`, before
 * serialization, the same way a value that joins on a structural separator is.
 *
 * The value is never echoed: it is caller text, and repeating it is the very
 * thing this guard exists to stop reaching a message.
 */
function validateArgvLineBreaks(op: LegacyEditOp): void {
  for (const { field, value } of argvLineBreakFields(op)) {
    if (!/[\r\n]/u.test(value)) continue;
    const cause = new Error(`${op.kind} ${field} on the argv path cannot carry a line break`);
    throw new HwpEngineError(
      "bad_request",
      `${cause.message}: the engine prints this field as text of its own line on stderr, so a CR or LF in it would stand there as a line the engine never wrote; remove the line break.`,
      { cause },
    );
  }
}

/** Serialize one op to its CLI value string (the part after the flag). */
function opValue(op: LegacyEditOp): string {
  validateArgvSeparators(op);
  validateArgvLineBreaks(op);
  return serializeArgvValue(op);
}

function serializeArgvValue(op: LegacyEditOp): string {
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
      return argvDeleteTableTarget(op.target);
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
    if (isStyleOp(op) || "address" in op) {
      throw new Error("Addressed and named-style edits require the edit-ops-v1 JSON transport; the argv bridge cannot represent them. Update the host and Tauri client to use the edit-ops-v1 JSON channel (docs/integration-maru.md)");
    }
    argv.push(OP_FLAGS[op.kind], opValue(op));
  }
  return argv;
}

/** One edit-ops-v1 array entry: a flat object tagged by its `op` field. */
type OpsEntry = Record<string, unknown>;

/**
 * Bare nonnegative plain decimals gain the unit the CLI flag on this path
 * implies. Suffixed values must match the edit-ops-v1 unit grammar exactly.
 */
function withUnit(value: string, unit: "mm" | "pt" | "%", field: string): string {
  if (/^\d+(\.\d+)?$/.test(value)) return `${value}${unit}`;
  if (/^\d+(\.\d+)?(mm|pt|%)$/.test(value)) return value;
  const cause = new Error(`Invalid unit value ${JSON.stringify(value)} for ${field}`);
  throw new HwpEngineError(
    "bad_request",
    `${cause.message}; provide a nonnegative decimal with an optional mm, pt, or % suffix.`,
    { cause },
  );
}

/** Convert Number.toString() exponent notation to the equivalent plain decimal. */
function plainDecimal(value: number): string {
  const encoded = String(value);
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(encoded);
  if (!match) return encoded;
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  const digits = whole + fraction;
  const decimalAt = whole.length + Number(match[3]);
  if (decimalAt <= 0) return `0.${"0".repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return `${digits}${"0".repeat(decimalAt - digits.length)}`;
  return `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
}

/** Numeric dimensions use a plain decimal JSON unit even for tiny/large numbers. */
function numericUnit(value: number, unit: "mm", field: string): string {
  if (!Number.isFinite(value) || value < 0) return withUnit(String(value), unit, field);
  return withUnit(plainDecimal(value), unit, field);
}

/** set-format props: same keys as the CLI flag; only `size` needs a unit. */
function formatPropsEntry(props: Record<string, string>): OpsEntry {
  const out: OpsEntry = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = key === "size" ? withUnit(value, "pt", "set_format.size") : value;
  }
  return out;
}

/** set-para: edit-ops-v1 keeps the two line-spacing spellings apart. */
function paraShapeEntry(key: ParaShapeKey, value: string): OpsEntry {
  switch (key) {
    case "line-spacing":
      return value.endsWith("pt")
        ? { line_spacing_pt: withUnit(value, "pt", "set_para.line_spacing_pt") }
        : { line_spacing_pct: withUnit(value, "%", "set_para.line_spacing_pct") };
    case "indent":
      return { indent_mm: withUnit(value, "mm", "set_para.indent_mm") };
    case "left":
      return { left_mm: withUnit(value, "mm", "set_para.left_mm") };
    case "right":
      return { right_mm: withUnit(value, "mm", "set_para.right_mm") };
    case "top":
      return { top_mm: withUnit(value, "mm", "set_para.top_mm") };
    case "bottom":
      return { bottom_mm: withUnit(value, "mm", "set_para.bottom_mm") };
  }
}

function pageSetupEntry(key: PageSetupKey, value: string): OpsEntry {
  switch (key) {
    case "width":
      return { width_mm: withUnit(value, "mm", "set_page.width_mm") };
    case "height":
      return { height_mm: withUnit(value, "mm", "set_page.height_mm") };
    case "margin-left":
      return { margin_left_mm: withUnit(value, "mm", "set_page.margin_left_mm") };
    case "margin-right":
      return { margin_right_mm: withUnit(value, "mm", "set_page.margin_right_mm") };
    case "margin-top":
      return { margin_top_mm: withUnit(value, "mm", "set_page.margin_top_mm") };
    case "margin-bottom":
      return { margin_bottom_mm: withUnit(value, "mm", "set_page.margin_bottom_mm") };
    case "orientation":
      return { orientation: value };
  }
}

function addressedEntry(op: AddressedEditOp): OpsEntry {
  const target = { address: op.address };
  switch (op.kind) {
    case "replace":
      return { op: "replace", ...target, from: op.find, to: op.replace };
    case "set-format": {
      const props = formatPropsEntry(op.props);
      // Never let free-form props smuggle in a text selector or change the target.
      delete props.pattern;
      return { ...props, op: "set_format", ...target };
    }
    case "set-align":
      return { op: "set_align", ...target, align: op.alignment };
    case "set-para":
      return { op: "set_para", ...target, ...paraShapeEntry(op.key, op.value) };
    case "insert-para":
    case "insert-para-before":
      return { op: "insert_para", ...target, text: op.text,
        ...(op.kind === "insert-para-before" ? { before: true } : {}) };
    case "move-para":
      return { op: "move_para", ...target, to: op.to };
    case "insert-blocks":
      return {
        op: "insert_blocks",
        ...target,
        position: op.position,
        blocks: op.blocks,
        ...(op.styles === undefined ? {} : { styles: op.styles }),
        ...(op.missingStyle === undefined ? {} : { missing_style: op.missingStyle }),
      };
    case "delete-para":
    case "indent-para":
    case "outdent-para":
      return { op: op.kind.replaceAll("-", "_"), ...target };
  }
}

/** Named-style ops are JSON-only, and each has its own entry shape. */
function isStyleOp(op: EditOp): op is StyleEditOp {
  return op.kind === "create-style" || op.kind === "update-style" || op.kind === "apply-style" ||
    op.kind === "style-tables";
}

/** A colour the edit-ops-v1 schema accepts, or a refusal naming the field. */
function styleColor(value: string, field: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    const cause = new Error(`Invalid colour ${JSON.stringify(value)} for ${field}`);
    throw new HwpEngineError("bad_request", `${cause.message}; provide #RRGGBB.`, { cause });
  }
  return value;
}

/** A font face name the edit-ops-v1 schema accepts. */
function styleFont(value: string, field: string): string {
  if (value === "" || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    const cause = new Error(`Invalid font name for ${field}`);
    throw new HwpEngineError("bad_request", `${cause.message}; provide a non-empty font family without control characters.`, { cause });
  }
  return value;
}

/**
 * The flat property fields a create/update entry carries, in the schema's
 * spelling. Units go through the same helper the addressed ops use, so a bare
 * decimal and a suffixed value read alike and a malformed one is refused
 * before the engine sees it.
 */
function stylePropEntry(op: StyleProps): OpsEntry {
  const out: OpsEntry = {};
  if (op.bold !== undefined) out.bold = op.bold ? "on" : "off";
  if (op.italic !== undefined) out.italic = op.italic ? "on" : "off";
  if (op.underline !== undefined) out.underline = op.underline ? "on" : "off";
  if (op.strike !== undefined) out.strike = op.strike ? "on" : "off";
  if (op.size !== undefined) out.size = withUnit(op.size, "pt", "style.size");
  if (op.color !== undefined) out.color = styleColor(op.color, "style.color");
  if (op.font !== undefined) out.font = styleFont(op.font, "style.font");
  if (op.lineSpacingPct !== undefined) out.line_spacing_pct = withUnit(op.lineSpacingPct, "%", "style.line_spacing_pct");
  if (op.lineSpacingPt !== undefined) out.line_spacing_pt = withUnit(op.lineSpacingPt, "pt", "style.line_spacing_pt");
  if (op.indentMm !== undefined) out.indent_mm = withUnit(op.indentMm, "mm", "style.indent_mm");
  if (op.leftMm !== undefined) out.left_mm = withUnit(op.leftMm, "mm", "style.left_mm");
  if (op.rightMm !== undefined) out.right_mm = withUnit(op.rightMm, "mm", "style.right_mm");
  if (op.topMm !== undefined) out.top_mm = withUnit(op.topMm, "mm", "style.top_mm");
  if (op.bottomMm !== undefined) out.bottom_mm = withUnit(op.bottomMm, "mm", "style.bottom_mm");
  if (op.align !== undefined) out.align = op.align;
  return out;
}

function styleEntry(op: StyleEditOp): OpsEntry {
  switch (op.kind) {
    case "create-style":
      return {
        op: "create_style",
        name: op.name,
        kind: op.styleKind ?? "paragraph",
        ...(op.basedOn === undefined ? {} : { based_on: op.basedOn }),
        ...stylePropEntry(op),
      };
    case "update-style":
      return { op: "update_style", style: op.style, ...stylePropEntry(op) };
    case "apply-style":
      return {
        op: "apply_style",
        address: op.address,
        style: op.style,
        ...(op.clearDirect === undefined ? {} : { clear_direct: op.clearDirect }),
      };
    case "style-tables":
      return { op: "style_tables", preset: op.preset };
  }
}

/** Serialize one op to its edit-ops-v1 entry. */
function opsEntry(op: EditOp): OpsEntry {
  if (isStyleOp(op)) return styleEntry(op);
  if ("address" in op) return addressedEntry(op);
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
          : {
              width_mm: numericUnit(op.width, "mm", "insert_image.width_mm"),
              height_mm: numericUnit(op.height, "mm", "insert_image.height_mm"),
            }),
      };
    case "seal":
      return {
        op: "seal",
        anchor: op.anchor,
        path: op.path,
        ...(op.size === undefined ? {} : { size_mm: numericUnit(op.size, "mm", "seal.size_mm") }),
      };
    case "set-format":
      // Reserved fields LAST: props is a free Record, so a caller-supplied
      // "pattern" or "op" key must not override the op's own target.
      return { ...formatPropsEntry(op.props), op: "set_format", pattern: op.find };
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

function parseOp(flag: string | undefined, value: string): LegacyEditOp {
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
      // `parse_image_size` reads the last `@` and the first `x` or `X`, trimming
      // each side the way f32's own parse does (#108), so `img@10 x 20` is the
      // same image as `img@10x20` here as it is in the engine.
      const [anchor, rest] = need(splitFirst(value, "=>"), flag, value);
      const split = splitImageSize(rest);
      return split === null
        ? { kind: "insert-image", anchor, path: rest }
        : { kind: "insert-image", anchor, path: split.path, width: split.width, height: split.height };
    }
    case "--seal": {
      // `parse_seal_size` reads the last `@`, then one `mm` off the trimmed
      // suffix, then a trimmed f32 (#108), so `stamp@5 mm` is the seal at
      // `stamp` sized 5 mm here as it is in the engine.
      const [anchor, rest] = need(splitFirst(value, "=>"), flag, value);
      const split = splitSealSize(rest);
      return split === null
        ? { kind: "seal", anchor, path: rest }
        : { kind: "seal", anchor, path: split.path, size: split.size };
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
      // The engine trims and then parses a `usize` to decide index or anchor,
      // so the same predicate decides what this side hands back: `Number("")`
      // would have made the empty string index 0 and `Number("3.5")` a
      // fractional index, and both are anchors to the engine. The trim is the
      // engine's own, so a U+0085 tail is no more part of the anchor here than
      // it is there (#103 item 2).
      const trimmed = rustTrim(value);
      return { kind: "delete-table", target: parsesAsUsize(trimmed) ? Number(trimmed) : value };
    }
    case "--delete-field":
      return { kind: "delete-field", name: value };
    case "--delete-bookmark":
      return { kind: "delete-bookmark", name: value };
    default:
      throw new Error(`argvToOps: unknown flag ${flag}`);
  }
}
