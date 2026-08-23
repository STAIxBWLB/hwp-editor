/**
 * Compose-panel presets → DocumentSpec v2.
 *
 * Profile values mirror hwp-cli's official presets
 * (crates/hwp-convert/src/official.rs): body font, size (1/100 pt there,
 * plain pt here), line spacing percent, and page-number footer policy.
 */

import type { DocumentSpecV2 } from "@hwp-editor/core";

export type ComposePreset =
  | "official"
  | "report"
  | "plan"
  | "notice"
  | "minutes"
  | "gaejosik"
  | "press";

export const COMPOSE_PRESETS: ComposePreset[] = [
  "official",
  "report",
  "plan",
  "notice",
  "minutes",
  "gaejosik",
  "press",
];

/** Korean UI labels for the preset picker. */
export const COMPOSE_PRESET_LABELS: Record<ComposePreset, string> = {
  official: "공문",
  report: "보고서",
  plan: "계획서",
  notice: "안내문",
  minutes: "회의록",
  gaejosik: "개조식 문서",
  press: "보도자료",
};

interface PresetProfile {
  fontFamily: string;
  bodySizePt: number;
  lineHeightPercent: number;
  pageNumber: boolean;
}

const MALGUN = "맑은 고딕";
const HCR_BATANG = "함초롬바탕";

const PRESET_PROFILES: Record<ComposePreset, PresetProfile> = {
  official: { fontFamily: MALGUN, bodySizePt: 12, lineHeightPercent: 160, pageNumber: false },
  report: { fontFamily: HCR_BATANG, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  plan: { fontFamily: HCR_BATANG, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  notice: { fontFamily: MALGUN, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  minutes: { fontFamily: HCR_BATANG, bodySizePt: 14, lineHeightPercent: 130, pageNumber: false },
  gaejosik: { fontFamily: MALGUN, bodySizePt: 15, lineHeightPercent: 160, pageNumber: true },
  press: { fontFamily: HCR_BATANG, bodySizePt: 14, lineHeightPercent: 160, pageNumber: true },
};

export interface ComposeInput {
  title: string;
  author: string;
  /**
   * Markdown-ish body: blank lines separate paragraphs; a line starting
   * with "# " becomes a heading-styled paragraph.
   */
  body: string;
}

type ParagraphBlock = {
  type: "paragraph";
  style?: string;
  runs: [{ type: "text"; text: string }];
};

/** Parse the guided-form body text into paragraph blocks. */
export function bodyToBlocks(body: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  for (const chunk of body.split(/\n\s*\n/)) {
    const text = chunk.trim();
    if (text === "") continue;
    if (text.startsWith("# ")) {
      blocks.push({
        type: "paragraph",
        style: "heading",
        runs: [{ type: "text", text: text.slice(2).trim() }],
      });
    } else {
      blocks.push({
        type: "paragraph",
        style: "body",
        runs: [{ type: "text", text }],
      });
    }
  }
  return blocks;
}

/** Build the DocumentSpec v2 for a preset + guided form input. */
export function buildDocumentSpec(
  preset: ComposePreset,
  input: ComposeInput,
): DocumentSpecV2 {
  const profile = PRESET_PROFILES[preset];
  const blocks: ParagraphBlock[] = [];
  if (input.title.trim() !== "") {
    blocks.push({
      type: "paragraph",
      style: "title",
      runs: [{ type: "text", text: input.title.trim() }],
    });
  }
  blocks.push(...bodyToBlocks(input.body));
  if (blocks.length === 0) {
    blocks.push({
      type: "paragraph",
      style: "body",
      runs: [{ type: "text", text: " " }],
    });
  }
  const section = {
    ...(profile.pageNumber
      ? { page_number: { position: "bottom_center" as const } }
      : {}),
    blocks,
  };
  return {
    version: "2.0",
    document: {
      version: "1.0",
      metadata: {
        ...(input.title.trim() !== "" ? { title: input.title.trim() } : {}),
        ...(input.author.trim() !== "" ? { author: input.author.trim() } : {}),
      },
      styles: {
        body: {
          font_family: profile.fontFamily,
          font_size_pt: profile.bodySizePt,
          line_height_percent: profile.lineHeightPercent,
          align: "justify",
        },
        heading: {
          font_family: profile.fontFamily,
          font_size_pt: profile.bodySizePt + 3,
          bold: true,
          spacing_before_pt: 13,
          spacing_after_pt: 6,
        },
        title: {
          font_family: profile.fontFamily,
          font_size_pt: profile.bodySizePt + 6,
          bold: true,
          align: "center",
          spacing_after_pt: 18,
        },
      },
      sections: [section],
    },
  };
}
