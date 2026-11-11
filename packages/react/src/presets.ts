/**
 * Compose-panel presets → DocumentSpec v2.
 *
 * The numbers are not here: `DOCUMENT_PROFILES` (each preset's body row) and
 * `COMPOSE_STYLE_ROWS` (the heading and title rows this panel adds) in
 * `@hwp-editor/core` are the one copy (issue #54 Decision 2026-11-10), read
 * here and by the component library, with a binary-gated test that diffs each
 * engine preset's body row against `hwp new --preset <name>`.
 */

import { COMPOSE_STYLE_ROWS, DOCUMENT_PROFILE_NAMES, DOCUMENT_PROFILES } from "@hwp-editor/core";
import type { DocumentProfile, ProfileName } from "@hwp-editor/core";
import type { DocumentSpecV2 } from "@hwp-editor/core";

export type ComposePreset = ProfileName;

/** The presets the picker offers, in its order. */
export const COMPOSE_PRESETS: ComposePreset[] = [...DOCUMENT_PROFILE_NAMES];

/**
 * Document data, NOT chrome (I18N-05): the font names in the profile table
 * travel into the composed DocumentSpec and are consumed by hwp-cli, so
 * translating one would change what the engine receives. The picker's
 * human-readable LABELS live in messages.ts under `presets.*`.
 */
const PRESET_PROFILES: Readonly<Record<ComposePreset, DocumentProfile>> = DOCUMENT_PROFILES;

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
          font_size_pt: profile.bodySizePt + COMPOSE_STYLE_ROWS.heading.sizeDeltaPt,
          bold: true,
          spacing_before_pt: COMPOSE_STYLE_ROWS.heading.spacingBeforePt,
          spacing_after_pt: COMPOSE_STYLE_ROWS.heading.spacingAfterPt,
        },
        title: {
          font_family: profile.fontFamily,
          font_size_pt: profile.bodySizePt + COMPOSE_STYLE_ROWS.title.sizeDeltaPt,
          bold: true,
          align: "center",
          spacing_after_pt: COMPOSE_STYLE_ROWS.title.spacingAfterPt,
        },
      },
      sections: [section],
    },
  };
}
