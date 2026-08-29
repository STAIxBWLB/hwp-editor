import type {
  Capabilities,
  CatEnvelope,
  ComposeResult,
  DocumentHandle,
  DocumentSpecV2,
  EditOp,
  HwpEngine,
  PageImage,
  ValidationReport,
} from "@hwp-editor/core";

/** Envelope with a heading, a paragraph, a 2-col table, and a {{date}} slot. */
export function makeEnvelope(): CatEnvelope {
  const blocks = [
    "# **1. 회의록**",
    "2026년 8월 정기 회의",
    "| **항목** | **담당** |\n| --- | --- |\n| 예산 | 김철수 |",
    "다음 회의는 {{date}}입니다.",
  ];
  let markdown = "";
  const segments: CatEnvelope["segments"] = [];
  blocks.forEach((block, para) => {
    const start = markdown.length;
    markdown += `${block}\n\n`;
    segments.push({ start, end: start + block.length, kind: "para", section: 0, para });
  });
  return { markdown, segments };
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842">' +
  '<rect width="595" height="842" fill="#ffffff"/></svg>';

export function makePage(page = 1): PageImage {
  return {
    page,
    width: 595,
    height: 842,
    dpi: 96,
    format: "svg",
    data: new TextEncoder().encode(SVG),
  };
}

export interface MockCalls {
  read: DocumentHandle[];
  edit: { ops: EditOp[] }[];
  compose: { spec: DocumentSpecV2; name: string }[];
  render: number;
  validate: number;
  /** Documents passed to validate(), in call order. */
  validated: DocumentHandle[];
}

export interface MockEngine extends HwpEngine {
  calls: MockCalls;
  /**
   * Report `validate()` answers with. Mutable so a test can flip the badge
   * mid-flow (e.g. assert that undo re-validates the restored document).
   */
  report: ValidationReport;
}

export function createMockEngine(opts?: {
  editable?: boolean;
  reason?: string;
  envelope?: CatEnvelope;
}): MockEngine {
  const envelope = opts?.envelope ?? makeEnvelope();
  const calls: MockCalls = {
    read: [],
    edit: [],
    compose: [],
    render: 0,
    validate: 0,
    validated: [],
  };
  let editCount = 0;
  const doc = (name: string): DocumentHandle => ({
    name,
    data: new TextEncoder().encode(name),
  });
  const capabilities: Capabilities = {
    version: "0.8.8-test",
    editable: opts?.editable ?? true,
    ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
    formats: ["hwp", "hwpx"],
  };
  const engine: MockEngine = {
    calls,
    report: { valid: true, errors: [] },
    read: async (document) => {
      calls.read.push(document);
      return envelope;
    },
    render: async () => {
      calls.render += 1;
      return [makePage()];
    },
    edit: async (document, ops) => {
      calls.edit.push({ ops });
      editCount += 1;
      return doc(`edited-${editCount}.hwpx`);
    },
    compose: async (spec, name): Promise<ComposeResult> => {
      calls.compose.push({ spec, name });
      return { document: doc(name) };
    },
    validate: async (document) => {
      calls.validate += 1;
      calls.validated.push(document);
      return engine.report;
    },
    capabilities: async () => capabilities,
  };
  return engine;
}

/**
 * Click Y coordinate (clientY) that resolves to the segment at `para`,
 * given the flow-model geometry and a page rect of height 842 at top 0.
 */
export function clientYForPara(envelope: CatEnvelope, para: number): number {
  const segment = envelope.segments[para];
  if (segment === undefined) throw new Error(`no segment ${para}`);
  const center = (segment.start + segment.end) / 2;
  return (center / envelope.markdown.length) * 842;
}
