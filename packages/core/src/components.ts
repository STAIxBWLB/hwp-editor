/**
 * Component library: a component is the JSON fragment the palette inserts
 * after (or before) the selected paragraph, and the unit a new document is
 * composed from.
 *
 * Shape (issue #54): `{name, description, params, styles?, blocks}`. `params`
 * hold the defaults of the flat `{{name}}` placeholders a component's blocks
 * may carry. Substitution happens here, in the client, before an op is built,
 * so the engine never sees a placeholder; a param value is inserted literally
 * and never re-scanned, which keeps `{{` in real content safe. `blocks` are
 * DocumentSpec v1 blocks: the pinned `schemas/document-spec-v1.schema.json`
 * is the contract, and the hand-written checks below validate against it in
 * the style of `segments.ts` (no JSON-schema dependency), with every refusal
 * naming the field path and the file or index entry it came from.
 *
 * A paragraph cannot carry a `list` here, so a starter that needs a bulleted
 * ladder writes the markers into the text. That is also what 개조식 notation
 * does, and it keeps HWP 5.0 ordered-list numbering out of the picture
 * (hwp-cli#472); the validator refuses the field rather than letting the
 * engine refuse the reference it cannot resolve. Style values follow the
 * engine's official profile: starters reference `바탕글` and `개요 1`..`개요
 * 6` by name and define only what the profile does not have (for example a
 * centred 두문 line), always `based_on` an official style, so no starter file
 * restates a profile constant. The profile itself is copied once, in
 * `profiles.ts`, because a compose spec has to define every style it names.
 *
 * Text is held to the engine's contract as well: `hwp compose` accepts a tab
 * and no other control character in a text run or a field value, so a param
 * value's line breaks become `line_break` runs here (the engine's own advice)
 * and everything else is refused while the field and the component that
 * produced it are still known.
 */
import type { Blocks, Style } from "./generated/document-spec-v2.js";
import type { DocumentSpecV2 } from "./spec.js";
import { deepFreeze, OFFICIAL_PROFILE } from "./profiles.js";

import approvalBox from "./components/approval-box.json";
import attachment from "./components/attachment.json";
import dumo from "./components/dumo.json";
import gaejosik from "./components/gaejosik.json";
import gyeolmun from "./components/gyeolmun.json";
import scheduleTable from "./components/schedule-table.json";
import summaryTable from "./components/summary-table.json";

/**
 * The profile as a map: a `Record` lookup answers `constructor` and
 * `toString` from `Object.prototype`, and the resolver reads names here.
 */
const PROFILE_STYLES = new Map<string, Style>(Object.entries(OFFICIAL_PROFILE));

/** One component file: identity, declared params with defaults, blocks. */
export interface Component {
  name: string;
  description: string;
  /** Default value of each `{{name}}` placeholder in `blocks`. */
  params: Record<string, string>;
  /** Style definitions the blocks reference, for a target that lacks them. */
  styles?: Record<string, Style>;
  blocks: Blocks;
}

type Block = Blocks[number];

const BLOCK_TYPES = ["paragraph", "table", "image", "equation", "field", "break"] as const;
const RUN_TYPES = ["text", "field", "equation", "image", "line_break"] as const;
const BREAK_KINDS = ["page", "column", "section"] as const;
const ALIGNMENTS = ["justify", "left", "right", "center", "distribute"] as const;
const PLACEMENTS = ["inline", "floating"] as const;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * What was refused. The palette and the compose dialog render a refusal from
 * `code`, `source` and `field` in the user's locale instead of showing an
 * English sentence a host cannot translate.
 */
export type ComponentErrorCode =
  | "component_invalid"
  | "component_param"
  | "component_style"
  | "component_load";

/**
 * A component refusal, carrying the parts a host localizes. `message` keeps
 * the one-line form every existing caller logs, and `reason` is the same text
 * without the `components:` prefix, so a localized frame can wrap it.
 */
export class ComponentError extends Error {
  readonly code: ComponentErrorCode;
  /** The component's name, or the file path or URL the JSON came from. */
  readonly source: string;
  /** The failing field path inside that file; empty when the source itself is the problem. */
  readonly field: string;
  /** The reason alone, without the source and field prefix. */
  readonly reason: string;
  /**
   * The offending value, when the field path does not already spell it: a
   * style the blocks reference but nothing defines is a field such as
   * `blocks[0].runs[0].style`, and the name it failed on is here so a
   * localized sentence can print it.
   */
  readonly value: string;

  constructor(code: ComponentErrorCode, source: string, field: string, reason: string, value = "") {
    super(`components: ${field === "" ? source : `${source}: ${field}`}: ${reason}`);
    this.name = "ComponentError";
    this.code = code;
    this.source = source;
    this.field = field;
    this.reason = reason;
    this.value = value;
  }
}

/** Narrow an untrusted throw to a component refusal. */
export function isComponentError(value: unknown): value is ComponentError {
  return value instanceof ComponentError;
}

function refuse(
  source: string,
  field: string,
  reason: string,
  code: ComponentErrorCode = "component_invalid",
  value = "",
): never {
  throw new ComponentError(code, source, field, reason, value);
}

function at(field: string, key: string | number): string {
  if (typeof key === "number") return `${field}[${key}]`;
  return field === "" ? key : `${field}.${key}`;
}

function asObject(raw: unknown, source: string, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    refuse(source, field, "must be an object");
  }
  return raw as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(source, at(field, key), "is not a field of this object");
  }
}

/**
 * String bounds `schemas/document-spec-v1.schema.json` publishes. A component
 * is validated against the pinned schema's shape, so it is validated against
 * its lengths too: a value the engine would refuse must be refused here, with
 * the field that carries it.
 */
const MAX_LENGTH = {
  styleName: 128,
  fontFamily: 256,
  text: 2_000_000,
  fieldName: 128,
  fieldValue: 4096,
  script: 100_000,
  path: 4096,
  alt: 4096,
} as const;

/** The v1 schema's `maxItems` for a table's columns and rows. */
const MAX_ITEMS = 65535;

/** The v1 schema's `maxProperties` for the style table. */
const MAX_STYLES = 256;

/**
 * The engine's block-nesting cap (`document_spec.rs`: `MAX_NESTING`). A
 * section's own blocks are depth 0 and every table cell adds a level, so the
 * blocks of the seventeenth nested table are the first the engine refuses.
 */
const MAX_NESTING = 16;

/**
 * The engine's cap on one table grid (`document_spec.rs` `MAX_TABLE_CELLS`),
 * refused before the occupancy walk allocates a slot per cell.
 */
const MAX_TABLE_CELLS = 100_000;

/** JSON Schema counts code points, so a surrogate pair is one character there. */
function exceeds(value: string, maxLength: number): boolean {
  if (value.length <= maxLength) return false;
  return Array.from(value).length > maxLength;
}

/**
 * Control characters `hwp compose` refuses in a text run or a field value
 * (`document_spec.rs`: `is_control() && character != '\t'`), which is Unicode
 * category Cc minus the tab. `\r\n` is not exempt: a line break is a
 * `line_break` run, never a character in the text.
 */
const DISALLOWED_TEXT_CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/u;

/** The same rule for a param value, which may hold a line break. */
const DISALLOWED_PARAM_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

function codepoint(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function withoutControl(
  value: string,
  pattern: RegExp,
  source: string,
  field: string,
  reason: string,
): string {
  const found = pattern.exec(value);
  if (found !== null) refuse(source, field, `holds the control character ${codepoint(found[0])}; ${reason}`);
  return value;
}

/** Type, emptiness and length: the part every string field has in common. */
function stringOf(
  value: unknown,
  source: string,
  field: string,
  allowEmpty: boolean,
  maxLength: number | undefined,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    refuse(source, field, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  if (maxLength !== undefined && exceeds(value, maxLength)) {
    refuse(source, field, `must be at most ${maxLength} characters, as document-spec-v1 allows`);
  }
  return value;
}

/** A string field that reaches the engine as text: a tab is all it may carry. */
function text(
  value: unknown,
  source: string,
  field: string,
  allowEmpty = false,
  maxLength?: number,
): string {
  return withoutControl(
    stringOf(value, source, field, allowEmpty, maxLength),
    DISALLOWED_TEXT_CONTROL,
    source,
    field,
    "document-spec-v1 allows a tab and no other control character here; " +
      "split the text into separate runs with a line_break run between them, then retry",
  );
}

/**
 * A param value. A line break is allowed, because substitution turns it into
 * a `line_break` run, and `\r\n` is read as one. Every other control
 * character is refused here, while the component and the param are known,
 * rather than by the engine at a document path that names neither.
 */
function paramValue(
  value: unknown,
  source: string,
  field: string,
  maxLength?: number,
): string {
  const normalized = stringOf(value, source, field, true, maxLength).replace(/\r\n/g, "\n");
  return withoutControl(
    normalized,
    DISALLOWED_PARAM_CONTROL,
    source,
    field,
    "a param may hold a tab or a line break (which becomes a line_break run) and " +
      "no other control character; remove it, then retry",
  );
}

function count(
  value: unknown,
  source: string,
  field: string,
  min: number,
  max: number,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    refuse(
      source,
      field,
      `must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`,
    );
  }
  return value;
}

function flag(value: unknown, source: string, field: string): boolean {
  if (typeof value !== "boolean") refuse(source, field, "must be a boolean");
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    refuse(source, field, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function colour(value: unknown, source: string, field: string): string {
  if (typeof value !== "string" || !COLOUR.test(value)) {
    refuse(source, field, "must be a #RRGGBB colour");
  }
  return value;
}

/** `positiveDimension`: the width/height range the v1 schema allows. */
function dimension(value: unknown, source: string, field: string): number {
  return count(value, source, field, 0.01, 2000);
}

const STYLE_FIELDS = [
  "based_on",
  "font_family",
  "font_size_pt",
  "bold",
  "italic",
  "underline",
  "strike",
  "color",
  "background",
  "align",
  "margin_left_mm",
  "margin_right_mm",
  "spacing_before_pt",
  "spacing_after_pt",
  "line_height_percent",
  "keep_with_next",
] as const;

/**
 * Why a style or a paragraph may not ask to keep the next block beside it.
 *
 * Named once because two positions refuse it and they must say the same
 * thing: a style definition and a paragraph block, which the engine refuses at
 * the same rule (`document_spec.rs`: `validate_style` and `validate_blocks`).
 */
const KEEP_WITH_NEXT_REASON =
  "keep_with_next is not representable by both native writers in v1 (document_spec.rs:893 and " +
  ":1080), so hwp compose refuses it; take the key out, then retry";

function validateStyle(raw: unknown, source: string, field: string): Style {
  const style = asObject(raw, source, field);
  onlyKeys(style, STYLE_FIELDS, source, field);
  for (const [key, value] of Object.entries(style)) {
    const where = at(field, key);
    switch (key) {
      case "based_on":
        text(value, source, where, false, MAX_LENGTH.styleName);
        break;
      case "font_family":
        text(value, source, where, false, MAX_LENGTH.fontFamily);
        break;
      case "font_size_pt":
        count(value, source, where, 1, 1000);
        break;
      case "line_height_percent":
        count(value, source, where, 50, 1000, true);
        break;
      case "bold":
      case "italic":
      case "underline":
      case "strike":
        flag(value, source, where);
        break;
      case "keep_with_next":
        flag(value, source, where);
        if (value === true) refuse(source, where, KEEP_WITH_NEXT_REASON);
        break;
      case "color":
      case "background":
        colour(value, source, where);
        break;
      case "align":
        oneOf(value, ALIGNMENTS, source, where);
        break;
      default:
        // The remaining keys (margins, spacing) are nonNegativeDimension.
        count(value, source, where, 0, 1000);
    }
  }
  // A copy: a caller that edits the component it gets back would otherwise
  // edit the file it passed in.
  return { ...style } as unknown as Style;
}

function validateStyles(raw: unknown, source: string): Record<string, Style> {
  const value = asObject(raw, source, "styles");
  if (Object.keys(value).length > MAX_STYLES) {
    refuse(source, "styles", `must hold at most ${MAX_STYLES} styles, as document-spec-v1 allows`);
  }
  const validated: [string, Style][] = [];
  for (const [name, style] of Object.entries(value)) {
    if (name.trim() === "" || name.trim() !== name) {
      refuse(source, at("styles", name), "must be a style name without surrounding spaces");
    }
    if (exceeds(name, MAX_LENGTH.styleName)) {
      refuse(
        source,
        at("styles", name),
        `must be at most ${MAX_LENGTH.styleName} characters, as document-spec-v1 allows a style name`,
      );
    }
    validated.push([name, validatedStyle(name, style, source)]);
  }
  // `fromEntries` defines own properties, so a style named `__proto__` survives.
  return Object.fromEntries(validated);
}

/**
 * Why a component may not carry its own copy of an official profile style.
 *
 * Named once because two places refuse it and they must say the same thing:
 * validation, which still knows the file or URL the component came from, and
 * `resolvedStyles`, which is the backstop for a component a host assembled
 * without validating it.
 */
function profileRedefinitionReason(name: string): string {
  return `redefines the official profile's ${name}, and a component takes profile values from ` +
    `the table rather than replacing them (#54 Decision 2026-11-10); define your style ` +
    `under its own name with based_on ${name}, then retry`;
}

/**
 * One style, validated, with the profile rule applied where the source is
 * still known.
 *
 * A component may reference an official profile style but not redefine it: a
 * profile row is the one copy every component shares (#54 Decision
 * 2026-11-10). Refusing it here rather than at composition means the refusal
 * names the file or URL the component came from — the thing a user can open
 * and fix. The composed and inserted paths both validate first, so the rule
 * lives in one place.
 */
function validatedStyle(name: string, raw: unknown, source: string): Style {
  const style = validateStyle(raw, source, at("styles", name));
  const profile = PROFILE_STYLES.get(name);
  if (profile !== undefined && !sameStyle(profile, style)) {
    refuse(source, at("styles", name), profileRedefinitionReason(name), "component_style");
  }
  return style;
}

/**
 * One style definition equals another when every property matches. Two
 * components that spell the same style with their keys in a different order
 * describe one style, not a conflict.
 */
function sameStyle(left: Style, right: Style): boolean {
  const leftStyle = left as Record<string, unknown>;
  const rightStyle = right as Record<string, unknown>;
  for (const key of new Set([...Object.keys(leftStyle), ...Object.keys(rightStyle)])) {
    if (leftStyle[key] !== rightStyle[key]) return false;
  }
  return true;
}

/**
 * Why a non-empty image description is refused.
 *
 * `hwp compose` refuses alt text at both positions it can appear, a block
 * image and a run (`document_spec.rs`: `unsupported_native`), and accepts the
 * empty string. A component that carries `alt: ""` is therefore still valid,
 * which is why the key itself stays allowed.
 */
function refuseAlt(value: unknown, source: string, field: string): void {
  if (value === "") return;
  refuse(
    source,
    field,
    "image alt text is not representable by both native writers in v1 (document_spec.rs:1180 and " +
      ":1394), so hwp compose refuses a non-empty alt; empty it or take the key out, then retry",
  );
}

/**
 * Why an image path has to stay inside the directory the engine reads from.
 *
 * The engine snapshots an asset only when the path holds nothing but normal
 * components relative to its base directory (`asset_snapshot.rs`:
 * `validate_relative_path`). Rust's `Path::components` normalizes an interior
 * `.` away but keeps a leading one as `CurDir`, and keeps `..` wherever it
 * appears, so exactly those three are refused here: an absolute path, a leading
 * `.`, and a `..` segment. `img/./a.png` is a normal path to the engine and
 * stays accepted. A Windows drive prefix is left to the engine: whether it is a
 * prefix depends on the host that runs the binary, and this validator has no
 * host.
 */
function validateImagePath(value: string, source: string, field: string): void {
  const segments = value.split("/");
  const absolute = value.startsWith("/");
  const leaves = segments.includes("..") || segments[0] === ".";
  if (!absolute && !leaves) return;
  refuse(
    source,
    field,
    absolute
      ? "must be a relative path: hwp compose reads an image only from relative normal " +
          "components (asset_snapshot.rs:80), so an absolute path is refused; write the path " +
          "relative to the base directory the engine is given (the spec's for compose, the ops " +
          "file's for an insert), then retry"
      : "holds a leading `.` or a `..` segment: hwp compose reads an image only from relative " +
          "normal components (asset_snapshot.rs:80), so a path that leaves the base directory is " +
          "refused; name a file inside the base directory the engine is given (the spec's or the " +
          "ops file's), then retry",
  );
}

function validateRun(raw: unknown, source: string, field: string): void {
  const run = asObject(raw, source, field);
  const type = oneOf(run.type, RUN_TYPES, source, at(field, "type"));
  switch (type) {
    case "text":
      onlyKeys(
        run,
        [
          "type",
          "text",
          "style",
          "font_family",
          "font_size_pt",
          "bold",
          "italic",
          "underline",
          "strike",
          "color",
          "background",
        ],
        source,
        field,
      );
      text(run.text, source, at(field, "text"), true, MAX_LENGTH.text);
      if (run.style !== undefined) {
        text(run.style, source, at(field, "style"), false, MAX_LENGTH.styleName);
      }
      if (run.font_family !== undefined) {
        text(run.font_family, source, at(field, "font_family"), false, MAX_LENGTH.fontFamily);
      }
      if (run.font_size_pt !== undefined) {
        count(run.font_size_pt, source, at(field, "font_size_pt"), 1, 1000);
      }
      for (const key of ["bold", "italic", "underline", "strike"] as const) {
        if (run[key] !== undefined) flag(run[key], source, at(field, key));
      }
      for (const key of ["color", "background"] as const) {
        if (run[key] !== undefined) colour(run[key], source, at(field, key));
      }
      break;
    case "field":
      onlyKeys(run, ["type", "name", "value", "style"], source, field);
      text(run.name, source, at(field, "name"), false, MAX_LENGTH.fieldName);
      if (run.value !== undefined) {
        text(run.value, source, at(field, "value"), true, MAX_LENGTH.fieldValue);
      }
      if (run.style !== undefined) {
        text(run.style, source, at(field, "style"), false, MAX_LENGTH.styleName);
      }
      break;
    case "equation":
      onlyKeys(run, ["type", "script", "width_mm", "height_mm"], source, field);
      text(run.script, source, at(field, "script"), false, MAX_LENGTH.script);
      if (run.width_mm !== undefined) dimension(run.width_mm, source, at(field, "width_mm"));
      if (run.height_mm !== undefined) dimension(run.height_mm, source, at(field, "height_mm"));
      break;
    case "image":
      onlyKeys(run, ["type", "path", "width_mm", "height_mm", "alt"], source, field);
      validateImagePath(
        text(run.path, source, at(field, "path"), false, MAX_LENGTH.path),
        source,
        at(field, "path"),
      );
      dimension(run.width_mm, source, at(field, "width_mm"));
      if (run.height_mm !== undefined) dimension(run.height_mm, source, at(field, "height_mm"));
      if (run.alt !== undefined) {
        text(run.alt, source, at(field, "alt"), true, MAX_LENGTH.alt);
        refuseAlt(run.alt, source, at(field, "alt"));
      }
      break;
    case "line_break":
      onlyKeys(run, ["type"], source, field);
      break;
  }
}

function validateParagraph(block: Record<string, unknown>, source: string, field: string): void {
  onlyKeys(block, ["type", "style", "list", "keep_with_next", "runs"], source, field);
  if (block.style !== undefined) {
    text(block.style, source, at(field, "style"), false, MAX_LENGTH.styleName);
  }
  if (block.keep_with_next !== undefined) {
    flag(block.keep_with_next, source, at(field, "keep_with_next"));
    if (block.keep_with_next === true) {
      refuse(source, at(field, "keep_with_next"), KEEP_WITH_NEXT_REASON);
    }
  }
  if (block.list !== undefined) {
    refuse(
      source,
      at(field, "list"),
      "is not supported: a component's blocks are inserted into a document whose lists it " +
        "cannot know, so hwp compose refuses the reference; write the markers into the text " +
        "runs instead (HWP 5.0 ordered lists also show Hangul numbering, hwp-cli#472)",
    );
  }
  const runsField = at(field, "runs");
  if (!Array.isArray(block.runs) || block.runs.length === 0) {
    refuse(source, runsField, "must be an array of at least 1 run");
  }
  block.runs.forEach((run, index) => validateRun(run, source, at(runsField, index)));
}

function validateTable(
  block: Record<string, unknown>,
  source: string,
  field: string,
  depth: number,
): void {
  onlyKeys(block, ["type", "width_mm", "columns", "rows"], source, field);
  if (block.width_mm !== undefined) dimension(block.width_mm, source, at(field, "width_mm"));
  const columnsField = at(field, "columns");
  if (!Array.isArray(block.columns) || block.columns.length === 0) {
    refuse(source, columnsField, "must be an array of at least 1 column");
  }
  if (block.columns.length > MAX_ITEMS) {
    refuse(source, columnsField, `must be at most ${MAX_ITEMS} columns, as document-spec-v1 allows`);
  }
  let columnSum = 0;
  block.columns.forEach((column, index) => {
    const columnField = at(columnsField, index);
    const value = asObject(column, source, columnField);
    onlyKeys(value, ["width_mm"], source, columnField);
    dimension(value.width_mm, source, at(columnField, "width_mm"));
    // The engine sums in f32 (`let mut column_sum = 0.0_f32`), so the
    // accumulator is rounded on every addend rather than once at the end: at
    // the 0.01 mm edge the two arithmetics disagree in both directions.
    columnSum = Math.fround(columnSum + Math.fround(value.width_mm as number));
  });
  validateTableWidth(block.width_mm, columnSum, source, field);
  const rowsField = at(field, "rows");
  if (!Array.isArray(block.rows) || block.rows.length === 0) {
    refuse(source, rowsField, "must be an array of at least 1 row");
  }
  if (block.rows.length > MAX_ITEMS) {
    refuse(source, rowsField, `must be at most ${MAX_ITEMS} rows, as document-spec-v1 allows`);
  }
  block.rows.forEach((row, index) => {
    const rowField = at(rowsField, index);
    const value = asObject(row, source, rowField);
    onlyKeys(value, ["cells"], source, rowField);
    const cellsField = at(rowField, "cells");
    if (!Array.isArray(value.cells)) refuse(source, cellsField, "must be an array");
    value.cells.forEach((cell, cellIndex) => {
      const cellField = at(cellsField, cellIndex);
      const cellValue = asObject(cell, source, cellField);
      onlyKeys(cellValue, ["col_span", "row_span", "blocks"], source, cellField);
      if (cellValue.col_span !== undefined) {
        count(cellValue.col_span, source, at(cellField, "col_span"), 1, 65535, true);
      }
      if (cellValue.row_span !== undefined) {
        count(cellValue.row_span, source, at(cellField, "row_span"), 1, 65535, true);
      }
      // A cell's `blocks` is `#[serde(default)]` in the schema and the engine
      // still descends into it, so the level is checked even when the key is
      // absent: a table 17 cells deep is refused whether or not the innermost
      // cell carries content.
      validateBlocks(cellValue.blocks ?? [], source, at(cellField, "blocks"), 0, depth + 1);
    });
  });
  validateTableGrid(block, source, field);
}

/**
 * Why a table's `width_mm` has to equal the sum of its columns.
 *
 * `hwp compose` refuses the difference above 0.01 mm (`document_spec.rs`:
 * `inconsistent_width`), and it computes both sides in f32: the sum is a
 * `f32` accumulator, the difference and the bound are f32 too. The comparison
 * is therefore done in f32 here as well, because at the edge the two
 * arithmetics disagree in both directions - 1.01 against a 1 mm column is
 * accepted by the engine, 10.01 against a 10 mm one is refused.
 *
 * The same rule's other half - the column sum against the page's body width -
 * needs a page the component cannot know, so it stays with the engine, and with
 * the insertion preflight that measured it.
 */
function validateTableWidth(
  width: unknown,
  columnSum: number,
  source: string,
  field: string,
): void {
  if (width === undefined) return;
  const value = Math.fround(width as number);
  const difference = Math.fround(value - columnSum);
  if (Math.abs(difference) <= Math.fround(0.01)) return;
  refuse(
    source,
    at(field, "width_mm"),
    `is ${value.toFixed(2)} mm, but the columns total ${columnSum.toFixed(2)} mm; hwp compose ` +
      "refuses a table whose width and column sum differ by more than 0.01 mm " +
      "(document_spec.rs:1503), so set width_mm to the column sum, or change a column width, " +
      "then retry",
  );
}

/**
 * The grid the rows have to tile, checked the way `hwp compose` lays a table
 * out (`document_spec.rs`: cells are placed left to right over the slots not
 * taken by an earlier `row_span`, a span may not leave the grid, and a row
 * has to end up covering every column). Without this a short row or an
 * oversized span reaches the engine, which refuses it at a document path that
 * names neither the component nor the table.
 */
function validateTableGrid(block: Record<string, unknown>, source: string, field: string): void {
  const width = (block.columns as unknown[]).length;
  const height = (block.rows as unknown[]).length;
  const slots = height * width;
  // Before the occupancy grid is allocated: 65535 by 65535 passes both axis
  // bounds and would ask for 4.3 billion slots. The engine refuses the same
  // product before it allocates (`MAX_TABLE_CELLS`), so this refusal is its
  // own message, not a guess.
  if (slots > MAX_TABLE_CELLS) {
    refuse(
      source,
      field,
      `is a ${height}-row by ${width}-column table, ${slots} cells; hwp compose allows ` +
        `${MAX_TABLE_CELLS} cells in one table grid; split the table into several, or shrink ` +
        "it, then retry",
    );
  }
  const rowsField = at(field, "rows");
  const covered = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  for (const [rowIndex, row] of (block.rows as Record<string, unknown>[]).entries()) {
    const cells = row.cells as Record<string, unknown>[];
    let cursor = 0;
    for (const [cellIndex, cell] of cells.entries()) {
      const cellField = at(at(at(rowsField, rowIndex), "cells"), cellIndex);
      while (cursor < width && covered[rowIndex]?.[cursor] === true) cursor += 1;
      const colSpan = (cell.col_span as number | undefined) ?? 1;
      const rowSpan = (cell.row_span as number | undefined) ?? 1;
      const colEnd = cursor + colSpan;
      const rowEnd = rowIndex + rowSpan;
      if (colEnd > width || rowEnd > height) {
        refuse(
          source,
          cellField,
          `spans ${colSpan} column(s) from column ${cursor + 1} and ${rowSpan} row(s) from ` +
            `row ${rowIndex + 1}, past the table's ${width} column(s) and ${height} row(s); ` +
            "shrink the span so the cells tile the grid, then retry",
        );
      }
      for (let r = rowIndex; r < rowEnd; r += 1) {
        for (let c = cursor; c < colEnd; c += 1) {
          if (covered[r]?.[c] === true) {
            refuse(
              source,
              cellField,
              `overlaps a cell an earlier row span already covers (row ${r + 1}, column ${c + 1}); ` +
                "give the overlapping cell its own slot, then retry",
            );
          }
          (covered[r] as boolean[])[c] = true;
        }
      }
      cursor = colEnd;
    }
    const empty = covered[rowIndex]?.indexOf(false) ?? -1;
    if (empty !== -1) {
      refuse(
        source,
        at(rowsField, rowIndex),
        `leaves column ${empty + 1} of the ${width}-column grid empty; ` +
          "every row has to cover every column (a col_span may be wider), then retry",
      );
    }
  }
}

function validateBlock(raw: unknown, source: string, field: string, depth: number): void {
  const block = asObject(raw, source, field);
  const type = oneOf(block.type, BLOCK_TYPES, source, at(field, "type"));
  switch (type) {
    case "paragraph":
      validateParagraph(block, source, field);
      return;
    case "table":
      validateTable(block, source, field, depth);
      return;
    case "image": {
      onlyKeys(block, ["type", "path", "width_mm", "height_mm", "alt", "placement"], source, field);
      validateImagePath(
        text(block.path, source, at(field, "path"), false, MAX_LENGTH.path),
        source,
        at(field, "path"),
      );
      dimension(block.width_mm, source, at(field, "width_mm"));
      if (block.height_mm !== undefined) {
        dimension(block.height_mm, source, at(field, "height_mm"));
      }
      if (block.alt !== undefined) {
        text(block.alt, source, at(field, "alt"), true, MAX_LENGTH.alt);
        refuseAlt(block.alt, source, at(field, "alt"));
      }
      if (block.placement !== undefined) {
        oneOf(block.placement, PLACEMENTS, source, at(field, "placement"));
      }
      return;
    }
    case "equation":
      onlyKeys(block, ["type", "script", "width_mm", "height_mm"], source, field);
      text(block.script, source, at(field, "script"), false, MAX_LENGTH.script);
      if (block.width_mm !== undefined) dimension(block.width_mm, source, at(field, "width_mm"));
      if (block.height_mm !== undefined) {
        dimension(block.height_mm, source, at(field, "height_mm"));
      }
      return;
    case "field":
      onlyKeys(block, ["type", "name", "value", "style"], source, field);
      text(block.name, source, at(field, "name"), false, MAX_LENGTH.fieldName);
      if (block.value !== undefined) {
        text(block.value, source, at(field, "value"), true, MAX_LENGTH.fieldValue);
      }
      if (block.style !== undefined) {
        text(block.style, source, at(field, "style"), false, MAX_LENGTH.styleName);
      }
      return;
    case "break":
      onlyKeys(block, ["type", "kind"], source, field);
      oneOf(block.kind, BREAK_KINDS, source, at(field, "kind"));
      return;
  }
}

/**
 * Validate a block list at the nesting level it sits at: a section's own
 * blocks are depth 0, and a table hands its cells `depth + 1`, which is how the
 * engine counts (`document_spec.rs`: `validate_blocks` takes the level and
 * refuses past `MAX_NESTING` before it walks the list).
 */
function validateBlocks(
  raw: unknown,
  source: string,
  field: string,
  minItems: number,
  depth: number,
): void {
  if (depth > MAX_NESTING) {
    refuse(
      source,
      field,
      `sits ${depth} table cells deep; hwp compose allows ${MAX_NESTING} levels of block ` +
        "nesting (document_spec.rs:22), so lift the inner table into its own component, or " +
        "flatten the nesting, then retry",
    );
  }
  if (!Array.isArray(raw) || raw.length < minItems) {
    refuse(
      source,
      field,
      minItems === 0 ? "must be an array" : `must be an array of at least ${minItems} block`,
    );
  }
  raw.forEach((block, index) => validateBlock(block, source, at(field, index), depth));
}

function validateParams(raw: unknown, source: string): Record<string, string> {
  const value = asObject(raw, source, "params");
  const params: [string, string][] = [];
  for (const [name, item] of Object.entries(value)) {
    if (name.trim() === "" || name.trim() !== name || name.includes("{") || name.includes("}")) {
      refuse(source, at("params", name), "must be a param name without braces or surrounding spaces");
    }
    params.push([name, paramValue(item, source, at("params", name), MAX_LENGTH.text)]);
  }
  // `fromEntries` defines own properties, so a param named `__proto__` survives.
  return Object.fromEntries(params);
}

/**
 * What the walk does with one field: `text` is a text run's text (a line
 * break becomes a `line_break` run), `value` a field value (which cannot hold
 * one, document-spec-v1 allows a tab and nothing else there).
 */
type TextMap = (value: string, field: string, kind: "text" | "value") => string;

/**
 * Walk the text a component carries. The callers below only ever run this on
 * blocks `validateBlocks` has accepted, so the shape each branch reads is the
 * checked one.
 */
function mapRuns(runs: readonly unknown[], field: string, map: TextMap): unknown[] {
  const mapped: unknown[] = [];
  for (const [index, raw] of runs.entries()) {
    const where = at(field, index);
    const run = { ...(raw as Record<string, unknown>) };
    if (run.type === "text") {
      // A line break in the text becomes the run the engine asks for, and the
      // run keeps its own formatting on both sides of it.
      const pieces = map(run.text as string, at(where, "text"), "text").split("\n");
      for (const [piece, text] of pieces.entries()) {
        if (piece > 0) mapped.push({ type: "line_break" });
        mapped.push({ ...run, text });
      }
      continue;
    }
    if (run.type === "field" && typeof run.value === "string") {
      run.value = map(run.value, at(where, "value"), "value");
    }
    mapped.push(run);
  }
  return mapped;
}

function mapBlocks(blocks: readonly unknown[], field: string, map: TextMap): unknown[] {
  return blocks.map((raw, index) => {
    const where = at(field, index);
    const block = { ...(raw as Record<string, unknown>) };
    switch (block.type) {
      case "paragraph":
        block.runs = mapRuns(block.runs as readonly unknown[], at(where, "runs"), map);
        break;
      case "table": {
        const rowsField = at(where, "rows");
        block.rows = (block.rows as readonly Record<string, unknown>[]).map((row, rowIndex) => {
          const rowField = at(rowsField, rowIndex);
          const cellsField = at(rowField, "cells");
          const cells = (row.cells as readonly Record<string, unknown>[]).map((cell, cellIndex) => {
            const cellField = at(cellsField, cellIndex);
            if (!Array.isArray(cell.blocks)) return cell;
            return {
              ...cell,
              blocks: mapBlocks(cell.blocks, at(cellField, "blocks"), map),
            };
          });
          return { ...row, cells };
        });
        break;
      }
      case "field":
        if (typeof block.value === "string") {
          block.value = map(block.value, at(where, "value"), "value");
        }
        break;
      default:
        break;
    }
    return block;
  });
}

function placeholderNames(value: string): string[] {
  return Array.from(value.matchAll(PLACEHOLDER), (match) => (match[1] ?? "").trim());
}

interface TextSite {
  field: string;
  text: string;
  /** Whether substitution fills `{{name}}` here. */
  substituted: boolean;
}

/**
 * Every text field a component carries, and whether substitution reaches it.
 * A text run's text, a field value and a field block's value are filled; an
 * image path or alt text, an equation script and a field name are not, so a
 * placeholder left in one of those would reach the engine as literal braces.
 */
function textSites(blocks: readonly unknown[], field: string): TextSite[] {
  const sites: TextSite[] = [];
  blocks.forEach((raw, index) => {
    const where = at(field, index);
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "paragraph":
        (block.runs as Record<string, unknown>[]).forEach((run, runIndex) => {
          const runField = at(at(where, "runs"), runIndex);
          switch (run.type) {
            case "text":
              sites.push({ field: at(runField, "text"), text: run.text as string, substituted: true });
              break;
            case "field":
              sites.push({ field: at(runField, "name"), text: run.name as string, substituted: false });
              if (typeof run.value === "string") {
                sites.push({ field: at(runField, "value"), text: run.value, substituted: true });
              }
              break;
            case "equation":
              sites.push({
                field: at(runField, "script"),
                text: run.script as string,
                substituted: false,
              });
              break;
            case "image":
              sites.push({ field: at(runField, "path"), text: run.path as string, substituted: false });
              if (typeof run.alt === "string") {
                sites.push({ field: at(runField, "alt"), text: run.alt, substituted: false });
              }
              break;
            default:
              break;
          }
        });
        break;
      case "table":
        (block.rows as Record<string, unknown>[]).forEach((row, rowIndex) => {
          const cellsField = at(at(at(where, "rows"), rowIndex), "cells");
          (row.cells as Record<string, unknown>[]).forEach((cell, cellIndex) => {
            if (Array.isArray(cell.blocks)) {
              sites.push(...textSites(cell.blocks, at(at(cellsField, cellIndex), "blocks")));
            }
          });
        });
        break;
      case "image":
        sites.push({ field: at(where, "path"), text: block.path as string, substituted: false });
        if (typeof block.alt === "string") {
          sites.push({ field: at(where, "alt"), text: block.alt, substituted: false });
        }
        break;
      case "equation":
        sites.push({ field: at(where, "script"), text: block.script as string, substituted: false });
        break;
      case "field":
        sites.push({ field: at(where, "name"), text: block.name as string, substituted: false });
        if (typeof block.value === "string") {
          sites.push({ field: at(where, "value"), text: block.value, substituted: true });
        }
        break;
      default:
        break;
    }
  });
  return sites;
}

/** Refuse a placeholder that substitution will not fill, or that no param declares. */
function checkPlaceholders(
  blocks: readonly unknown[],
  params: Record<string, string>,
  source: string,
): void {
  for (const site of textSites(blocks, "blocks")) {
    for (const placeholder of placeholderNames(site.text)) {
      if (placeholder === "") {
        refuse(
          source,
          site.field,
          "has an empty {{}} placeholder; name the param it meant, or remove the braces, then retry",
        );
      }
      if (!site.substituted) {
        refuse(
          source,
          site.field,
          `is not substituted, so {{${placeholder}}} would reach the engine as literal braces; ` +
            "move the placeholder into a text run or a field value, then retry",
        );
      }
      if (!Object.hasOwn(params, placeholder)) {
        refuse(
          source,
          site.field,
          `uses {{${placeholder}}}, which is not a declared param; add it to the component's ` +
            "params with a default, or take it out of the text, then retry",
        );
      }
    }
  }
}

/**
 * Validate one component file and return it in its published shape. `source`
 * is the file path or URL the JSON came from, or the index entry for an
 * inline component; every refusal names it together with the failing field.
 * The result shares nothing with `raw`: a caller may edit what it gets back.
 */
export function validateComponent(raw: unknown, source: string): Component {
  const value = asObject(raw, source, "");
  onlyKeys(value, ["name", "description", "params", "styles", "blocks"], source, "");
  const name = text(value.name, source, "name");
  const description = text(value.description, source, "description");
  const params = validateParams(value.params, source);
  const styles = value.styles === undefined ? undefined : validateStyles(value.styles, source);
  validateBlocks(value.blocks, source, "blocks", 1, 0);
  checkPlaceholders(value.blocks as readonly unknown[], params, source);
  const blocks = structuredClone(value.blocks) as Blocks;
  const component: Component = { name, description, params, blocks };
  if (styles !== undefined) component.styles = styles;
  return component;
}

/**
 * Marks a component whose placeholders are filled.
 *
 * Substitution has to happen exactly once: filled text may legitimately
 * contain `{{` (a value is inserted literally, never re-scanned), so a second
 * pass would rewrite content that came from a value. The mark rides on a
 * symbol, which `JSON.stringify` and `Object.entries` do not see, and
 * composition fills a component that lacks it.
 */
const FILLED: unique symbol = Symbol("hwp-editor.component.filled");

/** A component whose placeholders are filled; only `substituteParams` makes one. */
export interface FilledComponent extends Component {
  readonly [FILLED]: true;
}

function isFilled(component: Component): component is FilledComponent {
  return (component as Partial<FilledComponent>)[FILLED] === true;
}

/**
 * Fill a component's `{{name}}` placeholders with `values` over its defaults.
 * Values are literal (no recursive substitution), an undeclared value is
 * refused rather than ignored, and the returned component's `params` are the
 * merged values, so a caller can show what the component now holds.
 *
 * A line break in a value becomes a `line_break` run, which is what the
 * engine asks for when a text run has to continue on the next line; a field
 * value cannot hold one at all, so that is refused with the param named.
 */
export function substituteParams(
  component: Component,
  values: Record<string, string> = {},
  source = component.name,
): FilledComponent {
  if (isFilled(component)) {
    refuse(
      source,
      "",
      "is already substituted, and a second pass would re-scan text a value was inserted into; " +
        "fill the unfilled component, or compose this one as it is, then retry",
      "component_param",
    );
  }
  const overrides: [string, string][] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(component.params, name)) {
      refuse(
        source,
        at("params", name),
        "is not a param of this component; use one of its declared params, or add the param to " +
          "the component, then retry",
        "component_param",
      );
    }
    if (typeof value !== "string") {
      refuse(source, at("params", name), "must be a string; pass the value as text, then retry", "component_param");
    }
    // Normalized (`\r\n` becomes `\n`) and checked here, so what is stored is
    // what is substituted and what the caller reads back.
    overrides.push([name, paramValue(value, source, at("params", name), MAX_LENGTH.text)]);
  }
  // `fromEntries` defines own properties, so a param named `__proto__` survives.
  const params = Object.fromEntries([
    ...Object.entries(component.params),
    ...overrides,
  ]) as Record<string, string>;
  checkPlaceholders(component.blocks, params, source);
  const blocks = mapBlocks(component.blocks, "blocks", (template, field, kind) => {
    const substituted = template.replace(PLACEHOLDER, (_match, rawName: string) => {
      return params[rawName.trim()] as string;
    });
    if (kind === "value" && substituted.includes("\n")) {
      const name = placeholderNames(template).find((name) => (params[name] ?? "").includes("\n"));
      refuse(
        source,
        field,
        `substitutes {{${name ?? "param"}}}, whose value holds a line break, and ` +
          "document-spec-v1 allows no control character in a field value; " +
          "keep that param on one line, then retry",
        "component_param",
      );
    }
    return substituted;
  }) as Blocks;
  // A value can push a run past a bound the placeholder itself met, so the
  // result is held to the same contract the component was validated against.
  validateBlocks(blocks, source, "blocks", 1, 0);
  const filled: FilledComponent = {
    ...component,
    params,
    blocks: structuredClone(blocks),
    [FILLED]: true,
  };
  return filled;
}

interface StyleRef {
  field: string;
  name: string;
}

/** Every named style a block list mentions, with the field that mentioned it. */
function styleRefs(blocks: readonly unknown[], field: string): StyleRef[] {
  const refs: StyleRef[] = [];
  blocks.forEach((raw, index) => {
    const where = at(field, index);
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "paragraph": {
        if (typeof block.style === "string") {
          refs.push({ field: at(where, "style"), name: block.style });
        }
        const runsField = at(where, "runs");
        (block.runs as readonly Record<string, unknown>[]).forEach((run, runIndex) => {
          if (typeof run.style === "string") {
            refs.push({ field: at(at(runsField, runIndex), "style"), name: run.style });
          }
        });
        break;
      }
      case "table": {
        const rowsField = at(where, "rows");
        (block.rows as readonly Record<string, unknown>[]).forEach((row, rowIndex) => {
          const cellsField = at(at(rowsField, rowIndex), "cells");
          (row.cells as readonly Record<string, unknown>[]).forEach((cell, cellIndex) => {
            if (Array.isArray(cell.blocks)) {
              refs.push(...styleRefs(cell.blocks, at(at(cellsField, cellIndex), "blocks")));
            }
          });
        });
        break;
      }
      case "field":
        if (typeof block.style === "string") {
          refs.push({ field: at(where, "style"), name: block.style });
        }
        break;
      default:
        break;
    }
  });
  return refs;
}

export interface ComposeComponentsOptions {
  /** Document title written into `metadata`. */
  title?: string;
  /** Section id, when the caller addresses the section. */
  sectionId?: string;
}

/** One component to compose, with the param values it should be filled with. */
export interface ComponentInput {
  component: Component;
  /** Overrides over the component's own defaults. */
  values?: Record<string, string>;
}

/**
 * The component a compose entry stands for, filled exactly once. A component
 * that already carries the filled mark is used as it is: filling it again
 * would re-scan text a value was inserted into.
 */
function fillInput(input: Component | ComponentInput): FilledComponent {
  if ("blocks" in input) return isFilled(input) ? input : substituteParams(input);
  return substituteParams(input.component, input.values ?? {});
}

/**
 * Assemble an ordered component list into the DocumentSpec v2 `hwp compose`
 * takes. Blocks keep the list order; component styles are merged and a name
 * defined two different ways is refused instead of silently winning.
 *
 * Substitution happens here, once, so a placeholder can never reach the
 * engine: an entry may name values (`{component, values}`), an unfilled
 * component is filled from its own defaults, and an already filled one is
 * used as it is.
 *
 * Every style the blocks name, and every `based_on` a component defines, is
 * resolved here: one the components define wins, one only the official
 * profile has is added from `OFFICIAL_PROFILE`, and anything else is refused
 * with the field that named it (hwp compose would refuse the same reference
 * as `unknown_reference`, later and without the field). A profile name is
 * already defined, so a component may reference it but not redefine it.
 *
 * The spec shares no object with the components or with the profile table, so
 * editing the result cannot reach module state or a caller's file.
 */
export function documentSpecFromComponents(
  components: readonly (Component | ComponentInput)[],
  options: ComposeComponentsOptions = {},
): DocumentSpecV2 {
  if (components.length === 0) {
    refuse("components", "", "at least one component is needed to compose a document");
  }
  const filled = components.map((input) => fillInput(input));
  const resolved = resolvedStyles(filled);
  const blocks: Block[] = [];
  for (const component of filled) {
    blocks.push(...(structuredClone(component.blocks) as Block[]));
  }

  const document: DocumentSpecV2["document"] = {
    version: "1.0",
    sections: [options.sectionId === undefined ? { blocks } : { id: options.sectionId, blocks }],
  };
  if (options.title !== undefined) document.metadata = { title: options.title };
  if (resolved.size > 0) document.styles = Object.fromEntries(resolved);
  return { version: "2.0", document };
}

/**
 * The style definitions a component needs beside a destination that may lack
 * them: its own, plus every official profile style its blocks and its
 * `based_on` chain reference, resolved exactly as composition resolves them.
 *
 * `insert_blocks` takes a `styles` map and refuses a block naming a style
 * neither it nor the target defines, so an insertion sends this map instead of
 * `component.styles`: the palette would otherwise need every profile style
 * pre-defined in the target. Two components that define one name differently
 * are refused here; a profile redefinition was already refused where the
 * component's own file or URL was the source.
 *
 * The returned map shares nothing with the components or the profile table.
 */
export function componentStyleMap(
  components: readonly (Component | ComponentInput)[],
): Record<string, Style> {
  if (components.length === 0) return {};
  return Object.fromEntries(resolvedStyles(components.map((input) => fillInput(input))));
}

/**
 * Merge the components' own styles and resolve every reference against the
 * profile table, refusing a reference nothing defines, a name two components
 * define differently, a merged table past the engine's cap, and a `based_on`
 * cycle.
 *
 * The profile rule is applied here again, after validation has already
 * refused a redefinition: a host that assembles a `Component` in memory hands
 * it to this function without passing through `validatedStyle`, and a
 * redefined profile row would then reach the engine as one component's copy
 * of a shared style.
 */
function resolvedStyles(filled: readonly FilledComponent[]): Map<string, Style> {
  const styles = new Map<string, Style>();
  const definedBy = new Map<string, string>();
  for (const component of filled) {
    for (const [name, style] of Object.entries(component.styles ?? {})) {
      const profile = PROFILE_STYLES.get(name);
      if (profile !== undefined && !sameStyle(profile, style)) {
        refuse(component.name, at("styles", name), profileRedefinitionReason(name), "component_style");
      }
      const previous = styles.get(name);
      if (previous !== undefined && !sameStyle(previous, style)) {
        refuse(
          component.name,
          at("styles", name),
          `is defined differently by ${definedBy.get(name) ?? "an earlier component"} and this ` +
            "component; make the two definitions agree, or rename one of them, then retry",
          "component_style",
        );
      }
      styles.set(name, style);
      definedBy.set(name, component.name);
      // One document carries one style table, so the cap is on the merge, not
      // on each component: the engine refuses `spec.styles.len() > 256` before
      // it writes anything (`document_spec.rs`: `validate`).
      if (styles.size > MAX_STYLES) {
        refuse(
          component.name,
          at("styles", name),
          `takes the merged style table to ${styles.size} styles; hwp compose allows ` +
            `${MAX_STYLES} styles in one document (document_spec.rs:668), so share a style ` +
            "between the components, or drop one no block references, then retry",
          "component_style",
        );
      }
    }
  }

  const unresolved: { source: string; field: string; name: string }[] = [];
  for (const component of filled) {
    for (const ref of styleRefs(component.blocks, "blocks")) {
      if (!styles.has(ref.name)) {
        unresolved.push({ source: component.name, field: ref.field, name: ref.name });
      }
    }
  }
  for (const [name, style] of styles) {
    if (style.based_on !== undefined && !styles.has(style.based_on)) {
      unresolved.push({
        source: definedBy.get(name) ?? name,
        field: `${at("styles", name)}.based_on`,
        name: style.based_on,
      });
    }
  }
  const fromProfile = new Set<string>();
  while (unresolved.length > 0) {
    const item = unresolved.shift() as { source: string; field: string; name: string };
    const profile = PROFILE_STYLES.get(item.name);
    if (profile === undefined) {
      refuse(
        item.source,
        item.field,
        `references style ${item.name}, which no component defines and the official profile ` +
          "does not have; name one of the profile styles, or define it in a component, then retry",
        "component_style",
        item.name,
      );
    }
    if (fromProfile.has(item.name)) continue;
    fromProfile.add(item.name);
    // A profile row a block references joins the same table, so it counts
    // against the same cap.
    const merged = styles.size + fromProfile.size;
    if (merged > MAX_STYLES) {
      refuse(
        item.source,
        item.field,
        `pulls in the profile style ${item.name}, taking the merged style table to ${merged} ` +
          `styles; hwp compose allows ${MAX_STYLES} styles in one document ` +
          "(document_spec.rs:668), so reference fewer profile styles, or drop a style no block " +
          "uses, then retry",
        "component_style",
        item.name,
      );
    }
    if (profile.based_on !== undefined && !styles.has(profile.based_on)) {
      unresolved.push({
        source: item.source,
        field: `${at("styles", item.name)}.based_on`,
        name: profile.based_on,
      });
    }
  }

  const resolved = new Map<string, Style>();
  for (const [name, profile] of PROFILE_STYLES) {
    if (fromProfile.has(name)) resolved.set(name, structuredClone(profile));
  }
  for (const [name, style] of styles) resolved.set(name, structuredClone(style));
  validateStyleCycles(resolved, definedBy);
  return resolved;
}

/**
 * Why the merged style table may not hold a `based_on` cycle.
 *
 * The engine walks every inheritance chain before it writes anything and
 * reports `reference_cycle` at `$.styles.<name>.based_on` (`document_spec.rs`:
 * `validate_style_cycles`). A cycle that spans two components reaches the user
 * as a document path instead of naming the two files that make it, so the same
 * walk runs here, over the table both components contribute to.
 *
 * The refusal names the style the walk came back to, which is a member of the
 * cycle. The walk may have started elsewhere: a style that only points into a
 * cycle is not the field anyone can change.
 */
function validateStyleCycles(
  resolved: Map<string, Style>,
  definedBy: Map<string, string>,
): void {
  for (const name of resolved.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = name;
    while (current !== undefined) {
      if (seen.has(current)) {
        refuse(
          definedBy.get(current) ?? current,
          `${at("styles", current)}.based_on`,
          `is part of a style inheritance cycle through ${current}; hwp compose refuses a cycle ` +
            "between styles (document_spec.rs:959), so point one based_on in the cycle at a " +
            "style that does not lead back to it, then retry",
          "component_style",
          current,
        );
      }
      seen.add(current);
      current = resolved.get(current)?.based_on;
    }
  }
}

/** Minimal response shape the loader needs; a `fetch` response satisfies it. */
export interface ComponentFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Transport the loader reads an index and its component files with. */
export type ComponentFetch = (url: string) => Promise<ComponentFetchResponse>;

/**
 * A folder index: `version` plus entries, each a component path relative to
 * the index (or absolute) or the component object itself.
 */
export interface ComponentIndex {
  version: "1.0";
  components: readonly (string | { path: string } | Component)[];
}

/** What a host may pass as its component library. */
export type ComponentsSource = string | ComponentIndex | readonly Component[];

export interface LoadComponentsOptions {
  /** Base URL/path that relative index entries resolve against. */
  baseUrl?: string;
  /** Transport; defaults to the global `fetch`. */
  fetch?: ComponentFetch;
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A cancelled load stays a cancellation; it is not a broken library. */
function isCancellation(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown } | null | undefined;
  return candidate?.name === "AbortError" || candidate?.code === 20;
}

async function readJson(transport: ComponentFetch, url: string): Promise<unknown> {
  let response: ComponentFetchResponse;
  try {
    response = await transport(url);
  } catch (error) {
    if (isCancellation(error)) throw error;
    refuse(
      url,
      "",
      `could not be loaded (${failureOf(error)}); check the URL, the network and access permissions, then retry`,
      "component_load",
    );
  }
  if (!response.ok) {
    refuse(
      url,
      "",
      `could not be loaded (HTTP ${response.status}); check the URL and that the server serves the library there, then retry`,
      "component_load",
    );
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    if (isCancellation(error)) throw error;
    refuse(url, "", `could not be read (${failureOf(error)}); check the connection to that URL, then retry`, "component_load");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    refuse(url, "", `is not valid JSON (${failureOf(error)}); fix the file at that URL, then retry`, "component_load");
  }
}

/** The document URL a browser resolves a relative fetch against, when there is one. */
function pageHref(): string | undefined {
  const location = (globalThis as { location?: { href?: unknown } }).location;
  return typeof location?.href === "string" ? location.href : undefined;
}

/**
 * `source` as an absolute URL. An index fetched from `/lib/index.json` has to
 * become absolute before its entries can resolve against it, so a relative
 * source is resolved against the caller's `baseUrl` or, in a browser, the
 * document URL. A relative source with neither is left as given, so
 * `resolveEntry` can explain what is missing.
 */
function absoluteSource(source: string, baseUrl: string | undefined): string {
  try {
    return new URL(source).toString();
  } catch {
    // Not absolute: resolve it against a base below.
  }
  const page = pageHref();
  // `baseUrl` may itself be relative ("/lib/"), and it is only a usable base
  // once the page URL makes it absolute: `new URL(source, "/lib/")` throws.
  let base = baseUrl;
  if (base !== undefined && page !== undefined) {
    try {
      base = new URL(base, page).toString();
    } catch {
      // Unusable even against the page: `resolveEntry` explains it below.
    }
  }
  base ??= page;
  if (base === undefined) return source;
  try {
    return new URL(source, base).toString();
  } catch {
    return source;
  }
}

function resolveEntry(field: string, path: string, base: string | undefined): string {
  if (base !== undefined) {
    try {
      return new URL(path, base).toString();
    } catch {
      refuse(
        "component index",
        field,
        `cannot be resolved against ${base}; pass LoadComponentsOptions.baseUrl as an absolute URL or a valid path, then retry`,
        "component_load",
      );
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return path;
  refuse(
    "component index",
    field,
    "is a relative path, and no baseUrl was given to resolve it; pass LoadComponentsOptions.baseUrl (the library folder URL) and retry",
    "component_load",
  );
}

/**
 * Read one index and every component it names. `base` is what a relative
 * entry resolves against: the index URL itself when the index was fetched,
 * and the caller's `baseUrl` (or none) for an in-memory index.
 */
async function loadIndex(
  raw: unknown,
  label: string,
  base: string | undefined,
  transport: ComponentFetch,
  add: (component: Component, source: string, field: string) => void,
): Promise<void> {
  const index = asObject(raw, label, "");
  onlyKeys(index, ["version", "components"], label, "");
  if (index.version !== "1.0") refuse(label, "version", 'must be "1.0"');
  const entries = index.components;
  if (!Array.isArray(entries) || entries.length === 0) {
    refuse(label, "components", "must be a non-empty array");
  }
  for (const [position, entry] of entries.entries()) {
    const field = `components[${position}]`;
    if (typeof entry === "string") {
      const url = resolveEntry(field, entry, base);
      add(validateComponent(await readJson(transport, url), url), label, field);
      continue;
    }
    const value = asObject(entry, label, field);
    // An entry either names a file or is the component itself; anything else
    // is named as such instead of being reported as a missing path.
    if (value.path === undefined) {
      add(validateComponent(value, `${label} ${field}`), label, field);
      continue;
    }
    onlyKeys(value, ["path"], label, field);
    const path = text(value.path, label, at(field, "path"));
    const url = resolveEntry(field, path, base);
    add(validateComponent(await readJson(transport, url), url), label, field);
  }
}

/**
 * Load and validate a component library: a folder index URL, an index object,
 * or component objects passed directly. Every loaded component is validated,
 * and two components with one name are refused rather than silently racing.
 */
export async function loadComponents(
  source: ComponentsSource,
  options: LoadComponentsOptions = {},
): Promise<Component[]> {
  const transport: ComponentFetch = options.fetch ?? ((url) => fetch(url));
  const loaded: Component[] = [];
  const loadedBy = new Map<string, string>();
  const add = (component: Component, label: string, field: string): void => {
    const where = field === "" ? label : `${label} ${field}`;
    const first = loadedBy.get(component.name);
    if (first !== undefined) {
      refuse(
        label,
        field,
        `loads a second component named ${component.name}, which was already loaded from ` +
          `${first}; rename one of the two, then retry`,
      );
    }
    loadedBy.set(component.name, where);
    loaded.push(component);
  };

  if (typeof source === "string") {
    const indexUrl = absoluteSource(source, options.baseUrl);
    const index = await readJson(transport, indexUrl);
    await loadIndex(index, indexUrl, indexUrl, transport, add);
    return loaded;
  }
  if (Array.isArray(source)) {
    source.forEach((raw, position) => {
      const field = `components[${position}]`;
      add(validateComponent(raw, field), field, "");
    });
    return loaded;
  }
  // An in-memory index is named for what it is: `baseUrl` says where its
  // entries resolve, not where the index itself lives. A relative `baseUrl`
  // becomes absolute the same way a relative index URL does.
  const base =
    options.baseUrl === undefined ? undefined : absoluteSource(options.baseUrl, undefined);
  await loadIndex(source, "component index", base, transport, add);
  return loaded;
}

/**
 * The built-in starter set, validated at import time so a typo in the shipped
 * JSON fails loudly in this package's tests rather than in a host's palette.
 * Frozen: every host shares these objects, so an edit here would change the
 * next document instead of failing.
 */
export const STARTER_COMPONENTS: readonly Component[] = deepFreeze(
  [
    ["approval-box", approvalBox],
    ["attachment", attachment],
    ["dumo", dumo],
    ["gaejosik", gaejosik],
    ["gyeolmun", gyeolmun],
    ["schedule-table", scheduleTable],
    ["summary-table", summaryTable],
  ].map(([slug, raw]) => validateComponent(raw, `src/components/${slug}.json`)),
);
