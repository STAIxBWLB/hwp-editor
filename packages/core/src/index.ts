export type {
  Capabilities,
  ComposeResult,
  DocumentHandle,
  EditOptions,
  ImageAsset,
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
  imageAssetMediaType,
  imageAssetsMatchOps,
  validateImageAssets,
  MAX_IMAGE_ASSET_BYTES,
  MAX_IMAGE_ASSETS,
  MAX_IMAGE_ASSETS_TOTAL_BYTES,
} from "./assets.js";
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
  markdownLength,
  parseCatEnvelope,
  segmentAtOffset,
  segmentAtRef,
  segmentRef,
  segmentText,
  validateProjectedMetadata,
} from "./segments.js";
export type { CatEnvelope, DirectChar, DirectPara, Segment, SegmentKind, SegmentRef } from "./segments.js";
export { formatAddresses, paragraphAddress, paragraphForSegment, selectedParagraphs, selectSimilar, selectionAction } from "./selection.js";
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
  SourceRangeSelection,
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
export { TEMPLATE_MIN_VERSION, TEMPLATE_METHODS, templateVersionSupported, parseTemplateInputs, parseTemplateReport, parseFillReport, parseLintReport, parseEmbeddedTemplates, parseTemplateMethods, reportObject, reportString, reportSchemaVersion, reportCount, reportArray } from "./templates.js";
export type { TemplateReport, EmbeddedTemplate, FillReport, FillResult, LintFinding, LintProfile, LintReport, TemplateInput, TemplateInputs, TemplateMethod } from "./templates.js";
export {
  documentSpecFromComponents,
  loadComponents,
  STARTER_COMPONENTS,
  substituteParams,
  validateComponent,
} from "./components.js";
export type {
  Component,
  ComponentFetch,
  ComponentFetchResponse,
  ComponentIndex,
  ComponentInput,
  ComponentsSource,
  ComposeComponentsOptions,
  FilledComponent,
  LoadComponentsOptions,
} from "./components.js";
export {
  DOCUMENT_PROFILE_NAMES,
  DOCUMENT_PROFILES,
  OFFICIAL_BODY_PROFILE,
  OFFICIAL_PROFILE,
} from "./profiles.js";
export type { DocumentProfile, ProfileName } from "./profiles.js";
