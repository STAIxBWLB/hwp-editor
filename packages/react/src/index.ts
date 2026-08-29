/**
 * @hwp-editor/react — embeddable React UI for HWP/HWPX documents.
 *
 * Styles are NOT auto-injected; hosts must import the extracted stylesheet:
 *   import "@hwp-editor/react/style.css";
 * Theming is CSS-variable only (see theme.css / README for the contract).
 */

import "./theme.css";
import "./editor.css";

export { HwpEditor } from "./HwpEditor.js";
export type { HwpEditorHandle, HwpEditorProps } from "./HwpEditor.js";
export { PageCanvas } from "./PageCanvas.js";
export { SegmentInspector } from "./SegmentInspector.js";
export { TableGrid } from "./TableGrid.js";
export { FieldsPanel } from "./FieldsPanel.js";
export { ComposePanel } from "./ComposePanel.js";
export type { ComposePanelProps } from "./ComposePanel.js";

export { sanitizeSvg } from "./sanitize.js";
export { plainSegmentText } from "./text.js";
export { nearestSegment, segmentBand, clickOffset } from "./geometry.js";
export type { SegmentBand } from "./geometry.js";
export { findTables, tableAtRef, parseMarkdownTable, isTableSlice } from "./tables.js";
export type { TableModel } from "./tables.js";
export { extractFieldSlots } from "./fields.js";
export type { FieldSlot } from "./fields.js";
export { COMPOSE_PRESETS, buildDocumentSpec, bodyToBlocks } from "./presets.js";
export type { ComposePreset, ComposeInput } from "./presets.js";
export { useHwpEditorContext } from "./context.js";
export type { HwpEditorContextValue } from "./context.js";
export { classifyEngineError } from "./errors.js";
export type { EngineErrorKind } from "./errors.js";
// The locale tables are public: a host writing `messages` overrides needs
// them to discover which keys exist and what the defaults say.
export { en, ko, createT } from "./messages.js";
export type {
  MessageTable,
  MessageKey,
  HwpEditorMessages,
  Locale,
  TFunction,
} from "./messages.js";
