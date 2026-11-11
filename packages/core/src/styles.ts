/**
 * Types and parsers for `styles-v1`, the named-style table
 * `hwp styles <file> --format json` prints (hwp-cli 1.4.0+, contract
 * `hwp-styles-v1`, schema major 1).
 *
 * Verified against `ahwp 1.6.1` on the playground fixtures on 2026-11-11: the
 * wire object is `{contract, schema_version, styles: [{id, name,
 * english_name, kind, next_style, attrs, used_by}]}`, where `attrs` is the
 * same resolved char/para pair the segment envelope publishes at its `style`
 * and `direct` levels, and `used_by` lists the paragraph segment ids that
 * `cat --with-segments --segments v2` prints for the style.
 *
 * Two parsers, one row projector: `parseStyleTable` reads the CLI's own JSON
 * (with its `contract`/`schema_version` header), and `parseStyleTableResponse`
 * reads the projected table the `/styles` route body carries. They share
 * `projectRows` so the two shapes cannot drift; rows keep the wire spelling
 * of their keys, as every other projected report in this package does.
 *
 * The command itself is gated on hwp-cli 1.4.0 by `stylesVersionSupported`,
 * because an older binary has no `styles` subcommand at all.
 */
import type { CatEnvelope, ShapeAttrs } from "./segments.js";
import { projectShapeAttrs } from "./segments.js";
import type { StyleEditOp } from "./ops.js";
import { DOCUMENT_PROFILES } from "./profiles.js";

/** One row of `styles-v1`. */
export interface StyleInfo {
  /** Header style id; the engine's stable handle for the definition. */
  id: number;
  /** Display name as the document stores it (Korean for a Hancom document). */
  name: string;
  /** Language-independent name the document also carries. */
  english_name: string;
  /** Paragraph styles are the only kind this editor edits. */
  kind: "paragraph" | "character";
  /** Style applied to the paragraph that follows, as a style id. */
  next_style: number;
  /** Resolved character and paragraph shapes. */
  attrs: ShapeAttrs;
  /** Segment ids using this style, as the v2 envelope publishes them. */
  used_by: string[];
}

/** The `styles-v1` table. */
export interface StyleTable {
  /** The contract's schema version, e.g. "1.0". */
  version: string;
  styles: StyleInfo[];
}

function invalid(field: string): never {
  throw new Error(`Invalid styles-v1 table: ${field}; upgrade the host adapter to emit the hwp-cli 1.4.0 styles contract, then reload.`);
}

function row(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid(field);
  return raw as Record<string, unknown>;
}

function text(raw: unknown, field: string): string {
  if (typeof raw !== "string") invalid(field);
  return raw;
}

function index(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) invalid(field);
  return raw;
}

/** Project and validate the style rows; the one place either shape is read. */
function projectRows(styles: unknown): StyleInfo[] {
  if (!Array.isArray(styles)) invalid("styles");
  return styles.map((entry, at): StyleInfo => {
    const value = row(entry, `styles[${at}]`);
    const kind = text(value.kind, `styles[${at}].kind`);
    if (kind !== "paragraph" && kind !== "character") invalid(`styles[${at}].kind`);
    if (!Array.isArray(value.used_by) || value.used_by.some((id) => typeof id !== "string")) {
      invalid(`styles[${at}].used_by`);
    }
    return {
      id: index(value.id, `styles[${at}].id`),
      name: text(value.name, `styles[${at}].name`),
      english_name: text(value.english_name, `styles[${at}].english_name`),
      kind,
      next_style: index(value.next_style, `styles[${at}].next_style`),
      attrs: projectShapeAttrs(value.attrs, `styles[${at}].attrs`),
      used_by: value.used_by as string[],
    };
  });
}

/**
 * Parse the `styles-v1` JSON document `hwp styles` prints, throwing on
 * anything that is not the published shape. The parser is strict on purpose:
 * a table this editor could only partly read would make the Styles tab claim
 * a document has fewer styles than it does.
 */
export function parseStyleTable(json: string): StyleTable {
  const raw = row(JSON.parse(json), "document");
  const { contract, schema_version, styles } = raw;
  if (contract !== "hwp-styles-v1" || typeof schema_version !== "string" || !/^1[.][0-9]+$/.test(schema_version)) {
    invalid("contract or schema major");
  }
  return { version: schema_version, styles: projectRows(styles) };
}

/**
 * Validate a table another host already projected — the `/styles` route body,
 * or a desktop bridge's answer. The header is gone by then, so the schema
 * major is read off the projected `version` instead.
 */
export function parseStyleTableResponse(raw: unknown): StyleTable {
  const value = row(raw, "response");
  const version = text(value.version, "response.version");
  if (!/^1[.][0-9]+$/.test(version)) invalid("response.version");
  return { version, styles: projectRows(value.styles) };
}

/**
 * Whether this engine version has `hwp styles` and the style edit ops
 * (hwp-cli 1.4.0). Mirrors `templateVersionSupported`: same floor, different
 * command family, so each caller asks the question in its own vocabulary.
 */
export function stylesVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 1 || (major === 1 && Number(match[2]) >= 4);
}

/** The preset names `hwp edit --style-tables` accepts. */
export type StyleTablePreset = "official" | "report" | "plan" | "notice" | "minutes" | "press";

/** `StyleTablePreset` in the order the engine lists them. */
export const STYLE_TABLE_PRESETS: readonly StyleTablePreset[] = Object.freeze([
  "official",
  "report",
  "plan",
  "notice",
  "minutes",
  "press",
] as const);

/**
 * The style a preset switch rewrites: the document's body style.
 *
 * Read as the paragraph style the most TOP-LEVEL paragraphs use, which needs
 * the envelope because the table alone cannot tell a body paragraph from a
 * table cell. Without one — or when no paragraph is top-level in a projected
 * envelope — the whole usage count decides, and a document with no paragraph
 * style at all answers undefined. Paragraph kinds only: a character style is
 * never the body; ties keep the engine's own order.
 */
export function bodyStyle(table: StyleTable, envelope?: CatEnvelope): StyleInfo | undefined {
  const topLevel = envelope === undefined ? null : topLevelParagraphIds(envelope);
  const pick = (count: (row: StyleInfo) => number): StyleInfo | undefined => {
    let best: StyleInfo | undefined;
    let bestCount = -1;
    for (const row of table.styles) {
      if (row.kind !== "paragraph") continue;
      const count_ = count(row);
      if (count_ > bestCount) {
        best = row;
        bestCount = count_;
      }
    }
    return best;
  };
  if (topLevel === null) return pick((row) => row.used_by.length);
  const scoped = pick((row) => row.used_by.filter((id) => topLevel.has(id)).length);
  // A projected envelope that carries no nesting path leaves every score at
  // zero; the total is then the only signal there is.
  const hits = scoped === undefined ? 0 : scoped.used_by.filter((id) => topLevel.has(id)).length;
  return hits > 0 ? scoped : pick((row) => row.used_by.length);
}

/**
 * The ids of paragraphs that are not nested inside a table cell, an image or
 * another host. A segment's `indices` is its full v2 path, so a top-level
 * paragraph has exactly one entry; a host that publishes no path is null and
 * the caller falls back to plain usage counts.
 */
function topLevelParagraphIds(envelope: CatEnvelope): Set<string> | null {
  const ids = new Set<string>();
  let sawPath = false;
  for (const segment of envelope.segments) {
    if (segment.kind !== "para" || segment.id === undefined || segment.indices === undefined) continue;
    sawPath = true;
    if (segment.indices.length <= 1) ids.add(segment.id);
  }
  return sawPath ? ids : null;
}

/**
 * The `update_style` half of a preset switch — the first of its two engine
 * calls, before `--style-tables <preset>` styles the tables.
 *
 * Only the body row is written: `DOCUMENT_PROFILES` carries exactly that row
 * per preset (profiles.ts documents it), and the outline rows belong to the
 * document, whose own heading sizes this table has no value for. An empty
 * batch is honest when the document has no paragraph style at all — the
 * switch then restyles the tables alone.
 */
export function presetStyleOps(
  table: StyleTable,
  preset: StyleTablePreset,
  envelope?: CatEnvelope,
): StyleEditOp[] {
  const body = bodyStyle(table, envelope);
  if (body === undefined) return [];
  const profile = DOCUMENT_PROFILES[preset];
  return [
    {
      kind: "update-style",
      style: body.name,
      font: profile.fontFamily,
      size: String(profile.bodySizePt),
      lineSpacingPct: String(profile.lineHeightPercent),
    },
  ];
}
