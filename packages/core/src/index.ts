export type {
  Capabilities,
  ComposeResult,
  DocumentHandle,
  EditOptions,
  HwpEngine,
  PageImage,
  LayoutRow,
  PageLayout,
  PageImageFormat,
  RenderOptions,
  ValidationError,
  ValidationReport,
} from "./engine.js";
export {
  HwpEngineError,
  isHwpEngineError,
  isHwpErrorCode,
  protectedReasonFromDiagnostics,
  toHwpErrorCode,
} from "./errors.js";
export type { HwpErrorCode, HwpEngineErrorOptions } from "./errors.js";
export {
  OP_FLAGS,
  opsToArgv,
  opsToJson,
  argvToOps,
} from "./ops.js";
export type {
  AddressedEditOp,
  EditAddress,
  ParagraphAddress,
  CloneTableMode,
  EditOp,
  MetaKey,
  PageSetupKey,
  ParagraphAlignment,
  ParaShapeKey,
} from "./ops.js";
export {
  offsetToRef,
  parseCatEnvelope,
  segmentAtOffset,
  segmentAtRef,
  segmentRef,
  segmentText,
} from "./segments.js";
export type { CatEnvelope, Segment, SegmentKind, SegmentRef } from "./segments.js";
export type {
  DocumentSpecV2,
  TemplateDataV1,
  TemplateSpecV1,
} from "./spec.js";
export {
  createStore,
  initialState,
  reducer,
} from "./state.js";
export type {
  EditorAction,
  EditorError,
  EditorState,
  EditorStatus,
  EditorStore,
} from "./state.js";
export { base64, createHttpEngine } from "./http-engine.js";
export type { HttpEngineOptions } from "./http-engine.js";
export { createTauriEngine } from "./tauri.js";
export type {
  TauriDocumentRef,
  TauriEngineOptions,
  TauriInvoke,
} from "./tauri.js";
export type {
  CapabilitiesResponse,
  CreateRequest,
  FillResponse,
  SlotsResponse,
  LintResponse,
  TemplatesResponse,
  TemplateRequest,
  TemplateResponse,
  ComposeRequest,
  ComposeResponse,
  EditResponse,
  ErrorResponse,
  ReadResponse,
  RenderPageWire,
  RenderResponse,
  ValidateResponse,
} from "./protocol.js";

export { parsePageLayout, parseRenderLayouts, RENDER_LAYOUT_NEXT_STEP } from "./layout.js";
export { TEMPLATE_MIN_VERSION, TEMPLATE_METHODS, templateVersionSupported, parseTemplateInputs, parseTemplateReport, parseFillReport, parseLintReport, parseEmbeddedTemplates, parseTemplateMethods, reportObject, reportString, reportCount, reportArray } from "./templates.js";
export type { TemplateReport, EmbeddedTemplate, FillReport, FillResult, LintFinding, LintProfile, LintReport, TemplateInput, TemplateInputs, TemplateMethod } from "./templates.js";
