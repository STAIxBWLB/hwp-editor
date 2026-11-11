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
 * A component carries no `lists` (the format has no such field), so a starter
 * that needs a bulleted ladder writes the markers into the text. That is also
 * what 개조식 notation does, and it keeps HWP 5.0 ordered-list numbering out
 * of the picture (hwp-cli#472). Style values follow the engine's official
 * profile: starters reference `바탕글` and `개요 1`..`개요 6` by name and
 * define only what the profile does not have (for example a centred 두문
 * line), always `based_on` an official style so no profile value is
 * duplicated here. The profile itself is copied once, in `OFFICIAL_PROFILE`,
 * because a compose spec has to define every style it names.
 */
import type { Blocks, Style } from "./generated/document-spec-v2.js";
import type { DocumentSpecV2 } from "./spec.js";

import approvalBox from "./components/approval-box.json";
import attachment from "./components/attachment.json";
import dumo from "./components/dumo.json";
import gaejosik from "./components/gaejosik.json";
import gyeolmun from "./components/gyeolmun.json";
import scheduleTable from "./components/schedule-table.json";
import summaryTable from "./components/summary-table.json";

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

function refuse(source: string, field: string, reason: string): never {
  const where = field === "" ? source : `${source}: ${field}`;
  throw new Error(`components: ${where}: ${reason}`);
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

/** JSON Schema counts code points, so a surrogate pair is one character there. */
function exceeds(value: string, maxLength: number): boolean {
  if (value.length <= maxLength) return false;
  return Array.from(value).length > maxLength;
}

function text(
  value: unknown,
  source: string,
  field: string,
  allowEmpty = false,
  maxLength?: number,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    refuse(source, field, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  if (maxLength !== undefined && exceeds(value, maxLength)) {
    refuse(source, field, `must be at most ${maxLength} characters, as document-spec-v1 allows`);
  }
  return value;
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
      case "keep_with_next":
        flag(value, source, where);
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
  return style as unknown as Style;
}

function validateStyles(raw: unknown, source: string): Record<string, Style> {
  const value = asObject(raw, source, "styles");
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
    validated.push([name, validateStyle(style, source, at("styles", name))]);
  }
  // `fromEntries` defines own properties, so a style named `__proto__` survives.
  return Object.fromEntries(validated);
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
      text(run.path, source, at(field, "path"), false, MAX_LENGTH.path);
      dimension(run.width_mm, source, at(field, "width_mm"));
      if (run.height_mm !== undefined) dimension(run.height_mm, source, at(field, "height_mm"));
      if (run.alt !== undefined) text(run.alt, source, at(field, "alt"), true, MAX_LENGTH.alt);
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
  }
  if (block.list !== undefined) {
    const listField = at(field, "list");
    const list = asObject(block.list, source, listField);
    onlyKeys(list, ["name", "level"], source, listField);
    text(list.name, source, at(listField, "name"), false, MAX_LENGTH.styleName);
    if (list.level !== undefined) {
      count(list.level, source, at(listField, "level"), 0, 6, true);
    }
  }
  const runsField = at(field, "runs");
  if (!Array.isArray(block.runs) || block.runs.length === 0) {
    refuse(source, runsField, "must be an array of at least 1 run");
  }
  block.runs.forEach((run, index) => validateRun(run, source, at(runsField, index)));
}

function validateTable(block: Record<string, unknown>, source: string, field: string): void {
  onlyKeys(block, ["type", "width_mm", "columns", "rows"], source, field);
  if (block.width_mm !== undefined) dimension(block.width_mm, source, at(field, "width_mm"));
  const columnsField = at(field, "columns");
  if (!Array.isArray(block.columns) || block.columns.length === 0) {
    refuse(source, columnsField, "must be an array of at least 1 column");
  }
  if (block.columns.length > MAX_ITEMS) {
    refuse(source, columnsField, `must be at most ${MAX_ITEMS} columns, as document-spec-v1 allows`);
  }
  block.columns.forEach((column, index) => {
    const columnField = at(columnsField, index);
    const value = asObject(column, source, columnField);
    onlyKeys(value, ["width_mm"], source, columnField);
    dimension(value.width_mm, source, at(columnField, "width_mm"));
  });
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
      if (cellValue.blocks !== undefined) {
        validateBlocks(cellValue.blocks, source, at(cellField, "blocks"), 0);
      }
    });
  });
}

function validateBlock(raw: unknown, source: string, field: string): void {
  const block = asObject(raw, source, field);
  const type = oneOf(block.type, BLOCK_TYPES, source, at(field, "type"));
  switch (type) {
    case "paragraph":
      validateParagraph(block, source, field);
      return;
    case "table":
      validateTable(block, source, field);
      return;
    case "image":
      onlyKeys(block, ["type", "path", "width_mm", "height_mm", "alt", "placement"], source, field);
      text(block.path, source, at(field, "path"), false, MAX_LENGTH.path);
      dimension(block.width_mm, source, at(field, "width_mm"));
      if (block.height_mm !== undefined) {
        dimension(block.height_mm, source, at(field, "height_mm"));
      }
      if (block.alt !== undefined) text(block.alt, source, at(field, "alt"), true, MAX_LENGTH.alt);
      if (block.placement !== undefined) {
        oneOf(block.placement, PLACEMENTS, source, at(field, "placement"));
      }
      return;
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

function validateBlocks(raw: unknown, source: string, field: string, minItems: number): void {
  if (!Array.isArray(raw) || raw.length < minItems) {
    refuse(
      source,
      field,
      minItems === 0 ? "must be an array" : `must be an array of at least ${minItems} block`,
    );
  }
  raw.forEach((block, index) => validateBlock(block, source, at(field, index)));
}

function validateParams(raw: unknown, source: string): Record<string, string> {
  const value = asObject(raw, source, "params");
  const params: [string, string][] = [];
  for (const [name, item] of Object.entries(value)) {
    if (name.trim() === "" || name.trim() !== name || name.includes("{") || name.includes("}")) {
      refuse(source, at("params", name), "must be a param name without braces or surrounding spaces");
    }
    params.push([name, text(item, source, at("params", name), true, MAX_LENGTH.text)]);
  }
  // `fromEntries` defines own properties, so a param named `__proto__` survives.
  return Object.fromEntries(params);
}

type TextMap = (value: string, field: string) => string;

/**
 * Walk the text a component carries. The callers below only ever run this on
 * blocks `validateBlocks` has accepted, so the shape each branch reads is the
 * checked one.
 */
function mapRuns(runs: readonly unknown[], field: string, map: TextMap): unknown[] {
  return runs.map((raw, index) => {
    const where = at(field, index);
    const run = { ...(raw as Record<string, unknown>) };
    if (run.type === "text") run.text = map(run.text as string, at(where, "text"));
    if (run.type === "field" && typeof run.value === "string") {
      run.value = map(run.value, at(where, "value"));
    }
    return run;
  });
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
        if (typeof block.value === "string") block.value = map(block.value, at(where, "value"));
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

/**
 * Validate one component file and return it in its published shape. `source`
 * is the file path or URL the JSON came from, or the index entry for an
 * inline component; every refusal names it together with the failing field.
 */
export function validateComponent(raw: unknown, source: string): Component {
  const value = asObject(raw, source, "");
  onlyKeys(value, ["name", "description", "params", "styles", "blocks"], source, "");
  const name = text(value.name, source, "name");
  const description = text(value.description, source, "description");
  const params = validateParams(value.params, source);
  const styles = value.styles === undefined ? undefined : validateStyles(value.styles, source);
  validateBlocks(value.blocks, source, "blocks", 1);
  const blocks = value.blocks as Blocks;
  mapBlocks(blocks, "blocks", (text, field) => {
    for (const placeholder of placeholderNames(text)) {
      if (placeholder === "") refuse(source, field, "has an empty {{}} placeholder");
      if (!Object.hasOwn(params, placeholder)) {
        refuse(source, field, `uses {{${placeholder}}}, which is not a declared param`);
      }
    }
    return text;
  });
  const component: Component = { name, description, params, blocks };
  if (styles !== undefined) component.styles = styles;
  return component;
}

/**
 * Fill a component's `{{name}}` placeholders with `values` over its defaults.
 * Values are literal (no recursive substitution), an undeclared value is
 * refused rather than ignored, and the returned component's `params` are the
 * merged values, so a caller can show what the component now holds.
 */
export function substituteParams(
  component: Component,
  values: Record<string, string> = {},
  source = component.name,
): Component {
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(component.params, name)) {
      refuse(source, at("params", name), "is not a param of this component");
    }
    if (typeof value !== "string") refuse(source, at("params", name), "must be a string");
  }
  const params = { ...component.params, ...values };
  const blocks = mapBlocks(component.blocks, "blocks", (text, field) =>
    text.replace(PLACEHOLDER, (_match, rawName: string) => {
      const name = rawName.trim();
      if (!Object.hasOwn(params, name)) {
        refuse(source, field, `uses {{${name}}}, which is not a declared param`);
      }
      return params[name] as string;
    }),
  ) as Blocks;
  // A value can push a run past a bound the placeholder itself met, so the
  // result is held to the same contract the component was validated against.
  validateBlocks(blocks, source, "blocks", 1);
  return { ...component, params, blocks };
}

/**
 * The official profile's body font, size and line spacing as plain data, so a
 * caller that builds its own document (the compose panel's presets) reads the
 * same values instead of restating them. `OFFICIAL_PROFILE` is derived from
 * this, so there is one copy in the repo.
 */
export const OFFICIAL_BODY_PROFILE = {
  fontFamily: "맑은 고딕",
  fontSizePt: 12,
  lineHeightPercent: 160,
} as const;

/**
 * The engine's official profile, copied once. `hwp new --preset official`
 * writes these seven named styles, and `hwp styles <file> --format json`
 * reads back exactly these values (맑은 고딕, 12pt, justified, 160% line
 * spacing; the outlines bold at 15/14/13/12/12/12pt, left).
 *
 * A compose spec has no preset switch and refuses a `style` or `based_on`
 * that names a style the spec does not define (`unknown_reference`), so an
 * assembled document has to carry the profile itself. Keeping the values
 * here, rather than in each of the seven starter files, is what lets a
 * starter reference `바탕글` and `개요 2` by name without restating a single
 * profile constant; the starter set only ever adds a style the profile lacks
 * (a centred 두문 line, a bold table header) and names its `based_on`.
 */
export const OFFICIAL_PROFILE: Readonly<Record<string, Style>> = {
  "바탕글": {
    font_family: OFFICIAL_BODY_PROFILE.fontFamily,
    font_size_pt: OFFICIAL_BODY_PROFILE.fontSizePt,
    align: "justify",
    line_height_percent: OFFICIAL_BODY_PROFILE.lineHeightPercent,
  },
  "개요 1": { based_on: "바탕글", bold: true, font_size_pt: 15, align: "left" },
  "개요 2": { based_on: "바탕글", bold: true, font_size_pt: 14, align: "left" },
  "개요 3": { based_on: "바탕글", bold: true, font_size_pt: 13, align: "left" },
  "개요 4": { based_on: "바탕글", bold: true, font_size_pt: 12, align: "left" },
  "개요 5": { based_on: "바탕글", bold: true, font_size_pt: 12, align: "left" },
  "개요 6": { based_on: "바탕글", bold: true, font_size_pt: 12, align: "left" },
};

/** The profile as a map, so a style named `constructor` is not mistaken for one. */
const PROFILE_STYLES = new Map<string, Style>(Object.entries(OFFICIAL_PROFILE));

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

/**
 * Assemble an ordered component list into the DocumentSpec v2 `hwp compose`
 * takes. Blocks keep the list order; component styles are merged and a name
 * defined two different ways is refused instead of silently winning.
 *
 * Every style the blocks name, and every `based_on` a component defines, is
 * resolved here: one the components define wins, one only the official
 * profile has is added from `OFFICIAL_PROFILE`, and anything else is refused
 * with the field that named it — `hwp compose` would refuse the same
 * reference as `unknown_reference`, later and without the field.
 */
export function documentSpecFromComponents(
  components: readonly Component[],
  options: ComposeComponentsOptions = {},
): DocumentSpecV2 {
  if (components.length === 0) {
    refuse("components", "", "at least one component is needed to compose a document");
  }
  const styles = new Map<string, Style>();
  const definedBy = new Map<string, string>();
  const blocks: Block[] = [];
  for (const component of components) {
    for (const [name, style] of Object.entries(component.styles ?? {})) {
      const previous = styles.get(name);
      if (previous !== undefined && !sameStyle(previous, style)) {
        refuse(
          component.name,
          at("styles", name),
          `is defined differently by ${definedBy.get(name) ?? "an earlier component"} and this component`,
        );
      }
      styles.set(name, style);
      definedBy.set(name, component.name);
    }
    blocks.push(...component.blocks);
  }

  const unresolved: { source: string; field: string; name: string }[] = [];
  for (const component of components) {
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
        `references style ${item.name}, which no component defines and the official profile does not have`,
      );
    }
    if (fromProfile.has(item.name)) continue;
    fromProfile.add(item.name);
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
    if (fromProfile.has(name)) resolved.set(name, profile);
  }
  for (const [name, style] of styles) resolved.set(name, style);

  const document: DocumentSpecV2["document"] = {
    version: "1.0",
    sections: [options.sectionId === undefined ? { blocks } : { id: options.sectionId, blocks }],
  };
  if (options.title !== undefined) document.metadata = { title: options.title };
  if (resolved.size > 0) document.styles = Object.fromEntries(resolved);
  return { version: "2.0", document };
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
    );
  }
  if (!response.ok) {
    refuse(
      url,
      "",
      `could not be loaded (HTTP ${response.status}); check the URL and that the server serves the library there, then retry`,
    );
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    if (isCancellation(error)) throw error;
    refuse(url, "", `could not be read (${failureOf(error)}); check the connection to that URL, then retry`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    refuse(url, "", `is not valid JSON (${failureOf(error)}); fix the file at that URL, then retry`);
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
  const base = baseUrl ?? pageHref();
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
      );
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return path;
  refuse(
    "component index",
    field,
    "is a relative path, and no baseUrl was given to resolve it; pass LoadComponentsOptions.baseUrl (the library folder URL) and retry",
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
  add: (component: Component, field: string) => void,
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
      add(validateComponent(await readJson(transport, url), url), field);
      continue;
    }
    const value = asObject(entry, label, field);
    if (Array.isArray(value.blocks)) {
      add(validateComponent(value, `${label} ${field}`), field);
      continue;
    }
    const path = text(value.path, label, at(field, "path"));
    const url = resolveEntry(field, path, base);
    add(validateComponent(await readJson(transport, url), url), field);
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
  const add = (component: Component, field: string): void => {
    if (loaded.some((other) => other.name === component.name)) {
      refuse(field, "", `loads a second component named ${component.name}`);
    }
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
      add(validateComponent(raw, field), field);
    });
    return loaded;
  }
  await loadIndex(source, options.baseUrl ?? "component index", options.baseUrl, transport, add);
  return loaded;
}

/**
 * The built-in starter set, validated at import time so a typo in the shipped
 * JSON fails loudly in this package's tests rather than in a host's palette.
 */
export const STARTER_COMPONENTS: readonly Component[] = [
  ["approval-box", approvalBox],
  ["attachment", attachment],
  ["dumo", dumo],
  ["gaejosik", gaejosik],
  ["gyeolmun", gyeolmun],
  ["schedule-table", scheduleTable],
  ["summary-table", summaryTable],
].map(([slug, raw]) => validateComponent(raw, `src/components/${slug}.json`));
