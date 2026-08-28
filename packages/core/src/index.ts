export type {
  Capabilities,
  ComposeResult,
  DocumentHandle,
  EditOptions,
  HwpEngine,
  PageImage,
  PageImageFormat,
  RenderOptions,
  ValidationError,
  ValidationReport,
} from "./engine.js";
export {
  HwpEngineError,
  isHwpEngineError,
  toHwpErrorCode,
} from "./errors.js";
export type { HwpErrorCode, HwpEngineErrorOptions } from "./errors.js";
export {
  opsToArgv,
  argvToOps,
} from "./ops.js";
export type {
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
export type { CatEnvelope, Segment, SegmentRef } from "./segments.js";
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
  ComposeRequest,
  ComposeResponse,
  EditResponse,
  ErrorResponse,
  ReadResponse,
  RenderPageWire,
  RenderResponse,
  ValidateResponse,
} from "./protocol.js";
