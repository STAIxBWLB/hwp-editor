export type {
  Capabilities,
  ComposeResult,
  DocumentHandle,
  EditOptions,
  EditResult,
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
  StyleEditOp,
  StyleProps,
  StyleRef,
} from "./ops.js";
export {
  offsetToRef,
  markdownLength,
  parseCatEnvelope,
  hasDirectFormatting,
  projectShapeAttrs,
  runCoverage,
  segmentAtOffset,
  segmentAtRef,
  segmentRef,
  segmentText,
  validateProjectedMetadata,
} from "./segments.js";
export type {
  CatEnvelope,
  DirectChar,
  DirectPara,
  RunCoverage,
  Segment,
  SegmentKind,
  SegmentRef,
  ShapeAttrs,
} from "./segments.js";
export {
  bodyStyle,
  parseStyleTable,
  parseStyleTableResponse,
  presetStyleOps,
  stylesVersionSupported,
  STYLE_TABLE_PRESETS,
} from "./styles.js";
export type { StyleInfo, StyleTable, StyleTablePreset } from "./styles.js";
export {
  carriesPresetSwitch,
  presetBatchOptions,
  readPresetBatch,
} from "./style-batch.js";
export type { PresetBatchReading, PresetBatchRefusal } from "./style-batch.js";
export { compareSegments, formatAddresses, hasOwnRef, isSectionDefinitionParagraph, paragraphAddress, paragraphRuns, resolveSelection, segmentPath, selectedParagraphs, selectSimilar, selectionAction } from "./selection.js";
export type { SelectionRefusal, SelectionTargets } from "./selection.js";
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
  MarkdownRangeSelection,
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
  componentStyleMap,
  documentSpecFromComponents,
  isComponentError,
  loadComponents,
  STARTER_COMPONENTS,
  substituteParams,
  validateComponent,
} from "./components.js";
export { ComponentError } from "./components.js";
export type {
  Component,
  ComponentErrorCode,
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
export {
  EDIT_REPORT_MIN_VERSION,
  editReportSupported,
  insertedParagraphIds,
  parseEditReport,
  withCallerName,
} from "./edit-report.js";
export type { EditIdPair, EditOpOutcome, EditReport } from "./edit-report.js";
export type { Blocks } from "./generated/document-spec-v2.js";
