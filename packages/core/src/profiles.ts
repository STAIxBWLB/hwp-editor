/**
 * The official-document profiles, in one table.
 *
 * These values have to exist in code because `hwp compose` has no preset
 * switch: it refuses any style or `based_on` the spec does not itself define,
 * and it starts every style from the compose document's own default paragraph
 * shape instead of from a profile. A document assembled here therefore has to
 * carry the profile itself.
 *
 * Issue #54 Decision 2026-11-10 asks for exactly one copy of those values in
 * this repo. `components.ts` reads `OFFICIAL_PROFILE` (the seven named styles
 * a starter may reference), react's `presets.ts` reads `DOCUMENT_PROFILES`
 * (the body row of each preset the compose panel offers), and a binary-gated
 * test diffs both against `hwp new --preset <name>`, so drift fails instead
 * of producing a document that quietly differs from the engine's.
 */
import type { Style } from "./generated/document-spec-v2.js";

/**
 * Freeze a table and everything under it. The tables below and the starter
 * set are module state that every caller shares, so an edit to one of them
 * would change what a later compose produces; frozen, the edit throws
 * instead of leaking into the next document.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The body row of a profile: font, size, line spacing and footer policy. */
export interface DocumentProfile {
  /** Body font family, spelled the way hwp-cli spells it. */
  fontFamily: string;
  /** Body size in points; the engine stores 1/100 pt. */
  bodySizePt: number;
  /** Line spacing as a percentage. */
  lineHeightPercent: number;
  /** Whether the profile puts a page number in the bottom-centre footer. */
  pageNumber: boolean;
}

/**
 * Font names travel into the composed spec and are consumed by hwp-cli, so
 * they are document data: translating one would change what the engine
 * receives. The picker's human-readable labels live in react's messages.ts.
 */
const MALGUN_GOTHIC = "맑은 고딕";
const HCR_BATANG = "함초롬바탕";

/**
 * The official profile's body row, for a caller that builds its own document.
 * `OFFICIAL_PROFILE` is derived from it, so the body values exist once.
 */
export const OFFICIAL_BODY_PROFILE = deepFreeze({
  fontFamily: MALGUN_GOTHIC,
  fontSizePt: 12,
  lineHeightPercent: 160,
} as const);

/**
 * Paragraph spacing the official preset carries, from `hwp new --preset
 * official` (hwp-convert `from_markdown.rs` `default_header`, paragraph shapes
 * 0 and 1): 바탕글 has none, the six outlines have 6pt before and 3pt after.
 * Both rows are written out because the paragraph spacing this repo leaves
 * unset is not zero: compose starts every style from its own default shape,
 * which carries 6pt after, so an unwritten 바탕글 would keep it.
 */
const BODY_SPACING = { spacing_before_pt: 0, spacing_after_pt: 0 } as const;
const OUTLINE_SPACING = { spacing_before_pt: 6, spacing_after_pt: 3 } as const;

/**
 * The engine's official profile, copied once. `hwp new --preset official`
 * writes these seven named styles, and `hwp styles <file> --format json` reads
 * back exactly these values (맑은 고딕, 12pt, justified, 160% line spacing; the
 * outlines bold at 15/14/13/12/12/12pt, left).
 *
 * A starter references these names and defines only what the profile lacks (a
 * centred 두문 line, a bold table header), always `based_on` an official
 * style, so no starter file restates a profile constant.
 */
export const OFFICIAL_PROFILE: Readonly<Record<string, Style>> = deepFreeze({
  "바탕글": {
    font_family: OFFICIAL_BODY_PROFILE.fontFamily,
    font_size_pt: OFFICIAL_BODY_PROFILE.fontSizePt,
    align: "justify",
    line_height_percent: OFFICIAL_BODY_PROFILE.lineHeightPercent,
    ...BODY_SPACING,
  },
  "개요 1": { based_on: "바탕글", bold: true, font_size_pt: 15, align: "left", ...OUTLINE_SPACING },
  "개요 2": { based_on: "바탕글", bold: true, font_size_pt: 14, align: "left", ...OUTLINE_SPACING },
  "개요 3": { based_on: "바탕글", bold: true, font_size_pt: 13, align: "left", ...OUTLINE_SPACING },
  "개요 4": { based_on: "바탕글", bold: true, font_size_pt: 12, align: "left", ...OUTLINE_SPACING },
  "개요 5": { based_on: "바탕글", bold: true, font_size_pt: 12, align: "left", ...OUTLINE_SPACING },
  "개요 6": { based_on: "바탕글", bold: true, font_size_pt: 12, align: "left", ...OUTLINE_SPACING },
});

/** The presets this repo offers; every one but `gaejosik` is an engine preset. */
export type ProfileName =
  | "official"
  | "report"
  | "plan"
  | "notice"
  | "minutes"
  | "gaejosik"
  | "press";

/** `ProfileName` in picker order. */
export const DOCUMENT_PROFILE_NAMES: readonly ProfileName[] = deepFreeze([
  "official",
  "report",
  "plan",
  "notice",
  "minutes",
  "gaejosik",
  "press",
] as const);

/**
 * The body row of each preset, from hwp-convert `official.rs` `profiles()`
 * (font, size in 1/100 pt, line spacing, and whether the preset numbers its
 * pages). `official` is built from `OFFICIAL_BODY_PROFILE` rather than
 * restated. `gaejosik` has no engine preset, so no drift test can cover it.
 */
export const DOCUMENT_PROFILES: Readonly<Record<ProfileName, DocumentProfile>> = deepFreeze({
  official: {
    fontFamily: OFFICIAL_BODY_PROFILE.fontFamily,
    bodySizePt: OFFICIAL_BODY_PROFILE.fontSizePt,
    lineHeightPercent: OFFICIAL_BODY_PROFILE.lineHeightPercent,
    pageNumber: false,
  },
  report: { fontFamily: HCR_BATANG, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  plan: { fontFamily: HCR_BATANG, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  notice: { fontFamily: MALGUN_GOTHIC, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  minutes: { fontFamily: HCR_BATANG, bodySizePt: 14, lineHeightPercent: 130, pageNumber: false },
  gaejosik: { fontFamily: MALGUN_GOTHIC, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  press: { fontFamily: HCR_BATANG, bodySizePt: 14, lineHeightPercent: 160, pageNumber: true },
});

/**
 * The heading and title rows the compose panel writes, relative to a preset's
 * body row.
 *
 * `hwp compose` refuses a style the spec does not define and starts every style
 * from its own default paragraph shape, so the panel has to spell them out.
 * They are this repo's own numbers rather than a preset's: `hwp new --preset
 * <name>` writes only 바탕글 and the six 개요 rows, so no drift test against the
 * binary can cover a title or heading style. They live here so the panel and
 * every other composer of a spec read one copy.
 */
export const COMPOSE_STYLE_ROWS = deepFreeze({
  heading: { sizeDeltaPt: 3, spacingBeforePt: 13, spacingAfterPt: 6 },
  title: { sizeDeltaPt: 6, spacingAfterPt: 18 },
} as const);
