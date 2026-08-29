/**
 * The editor's string table: one flat `<area>.<thing>` key map per locale,
 * plus the `t()` factory that merges them.
 *
 * Contract (published API at 1.0.0 — a key rename is a breaking change):
 *
 * - `en` is canonical and is the default when no `locale` is given. It is
 *   declared WITHOUT `as const` so its values widen to `string` / function
 *   signatures; `const ko: MessageTable` then makes a key missing from
 *   EITHER table a `tsc` error (a missing key is a required-property error,
 *   an extra key an excess-property one). That two-way parity is the whole
 *   reason for the `typeof en` spelling — a plain `Record<..., string>`
 *   would widen every value to the union and lose per-key parameter types.
 * - Count-bearing messages are FUNCTION values taking a single named-params
 *   object, never positional args and never a runtime `{count}` template.
 *   Interpolation happens inside the function body, so word order is a
 *   per-locale choice and English can carry a real plural branch.
 * - Merge order is `en` -> locale table -> host `messages`. An override
 *   replaces exactly one key; every other key falls through to the locale
 *   default. Lookup is exact string equality with no normalization.
 *
 * NOT in this table, deliberately (I18N-05): font names, preset profiles,
 * the `#FF0000` placeholder sample, and the engine's `{message}` error tail.
 * Those are document data or engine-authored prose — translating them would
 * change what hwp-cli receives or rewrite what the engine actually said.
 */

export const en = {
  // Toolbar
  "toolbar.toolsAria": "Editing tools",
  "toolbar.readOnly": "Read-only",
  "toolbar.pendingEdits": (p: { count: number }): string =>
    p.count === 1 ? "1 pending edit" : `${p.count} pending edits`,
  "toolbar.revert": "Undo edit",
  "toolbar.apply": "Apply",
  "toolbar.applyWithCount": (p: { count: number }): string =>
    `Apply (${p.count})`,
  "toolbar.applying": "Applying…",
  "toolbar.newDocument": "New document",

  // Validation badge
  "validation.aria": "Validation result",
  "validation.valid": "Valid",
  "validation.errors": (p: { count: number }): string =>
    p.count === 1 ? "1 error" : `${p.count} errors`,

  // Canvas
  "canvas.aria": "Document pages",
  "canvas.empty": "No document open.",
  "canvas.createCta": "Create a new document",
  "canvas.emptyPages": "No rendered pages.",
  "page.label": (p: { page: number }): string => `Page ${p.page}`,

  // Side panel shell
  "side.panelAria": "Editing panels",
  "tabs.para": "Paragraph",
  "tabs.table": "Table",
  "tabs.fields": "Fields",

  // Error line — the prefix names which operation failed. The `{message}`
  // tail stays engine-authored and is never translated.
  "error.prefix.load": "Failed to open document",
  "error.prefix.apply": "Failed to apply edits",
  "error.prefix.compose": "Failed to create document",
  // Badge labels; "generic" renders no chip, hence the empty string.
  "error.kind.timeout": "Engine timed out",
  "error.kind.unavailable": "hwp binary unavailable",
  "error.kind.protected": "Protected document",
  "error.kind.generic": "",

  // Compose dialog
  "compose.title": "Create a new document",
  "compose.docType": "Document type",
  "compose.docTypeAria": "Document type",
  "compose.titleLabel": "Title",
  "compose.titlePlaceholder": "Document title",
  "compose.authorLabel": "Author",
  "compose.authorPlaceholder": "Author (optional)",
  "compose.bodyLabel": "Body",
  "compose.bodyPlaceholder":
    "Blank lines separate paragraphs. Lines starting with '# ' become subheadings.\n\nExample:\n# 1. Overview\nBody text...",
  "compose.cancel": "Cancel",
  "compose.submit": "Create document",
  "compose.submitting": "Creating…",
  /** Filename stem used when the compose form has no title. */
  "compose.defaultFileStem": "New document",

  // Compose preset labels. The preset PROFILES (font names, sizes) are
  // document data and stay in presets.ts, untranslated.
  "presets.official": "Official document",
  "presets.report": "Report",
  "presets.plan": "Plan",
  "presets.notice": "Notice",
  "presets.minutes": "Minutes",
  "presets.gaejosik": "Outline document",
  "presets.press": "Press release",

  // SegmentInspector
  "segment.panelAria": "Paragraph editor",
  "segment.hint": "Click the page to select a paragraph to edit.",
  "segment.selectedPara": (p: { section: number; para: number }): string =>
    `Selected paragraph (section ${p.section}, paragraph ${p.para})`,
  "segment.emptyPara": "(empty paragraph)",
  "segment.replaceLabel": "Replace text",
  "segment.replacePlaceholder": "New text",
  "segment.replaceSubmit": "Replace",
  "segment.insertLabel": "Insert paragraph",
  "segment.insertPlaceholder": "Paragraph text to insert",
  "segment.insertBefore": "Insert before",
  "segment.insertAfter": "Insert after",
  "segment.deletePara": "Delete paragraph",
  "segment.alignLabel": "Alignment",
  "segment.alignGroupAria": "Paragraph alignment",
  "segment.alignLeft": "Left",
  "segment.alignCenter": "Center",
  "segment.alignRight": "Right",
  "segment.alignJustify": "Justify",
  "segment.formatLabel": "Character format",
  "segment.bold": "Bold",
  "segment.sizePlaceholder": "Size (pt)",
  "segment.sizeAria": "Font size (pt)",
  "segment.colorAria": "Font color",
  "segment.formatSubmit": "Apply format",

  // TableGrid
  "table.panelAria": "Table editor",
  "table.hint":
    "Select a region containing a table on the page. The current selection is not a table paragraph.",
  "table.tableLabel": (p: { index: number }): string => `Table #${p.index}`,
  "table.cellLabel": (p: { row: number; col: number }): string =>
    `Cell (${p.row}, ${p.col})`,
  "table.setCell": "Set cell",
  "table.mergeAnchor": "Set merge anchor",
  "table.mergeWithAnchor": "Merge with anchor",
  "table.splitCell": "Split cell",
  "table.rowsCols": "Rows / columns",
  "table.addRow": "Add row",
  "table.addCol": "Add column",
  "table.deleteRow": "Delete row",
  "table.deleteCol": "Delete column",
  "table.deleteTable": "Delete table",

  // FieldsPanel
  "fields.panelAria": "Fields",
  "fields.hint": "No {{name}} field placeholders were found in the document.",
  "fields.valuePlaceholder": "New value",
  "fields.fieldValueAria": (p: { name: string }): string =>
    `Value for field ${p.name}`,
  "fields.setValue": "Set value",
};

/** The shape both locale tables must satisfy, derived from canonical `en`. */
export type MessageTable = typeof en;
/** Every valid `t()` key. */
export type MessageKey = keyof MessageTable;
/** Host-supplied per-key overrides; unknown keys are a `tsc` error. */
export type HwpEditorMessages = Partial<MessageTable>;
/** Supported UI locales. Mount-time only — runtime switching is not supported. */
export type Locale = "en" | "ko";

/**
 * Korean chrome. These are the literals that already shipped, carried over
 * VERBATIM (including the `...` in-progress convention, where English uses
 * a single `…`) — they are correct and the existing suite pins them.
 */
export const ko: MessageTable = {
  "toolbar.toolsAria": "편집 도구",
  "toolbar.readOnly": "읽기 전용",
  "toolbar.pendingEdits": (p) => `대기 편집 ${p.count}`,
  "toolbar.revert": "되돌리기",
  "toolbar.apply": "적용",
  "toolbar.applyWithCount": (p) => `적용 (${p.count})`,
  "toolbar.applying": "적용 중...",
  "toolbar.newDocument": "새 문서",

  "validation.aria": "검증 결과",
  "validation.valid": "유효",
  "validation.errors": (p) => `오류 ${p.count}건`,

  "canvas.aria": "문서 페이지",
  "canvas.empty": "열린 문서가 없습니다.",
  "canvas.createCta": "새 문서 만들기",
  "canvas.emptyPages": "렌더링된 페이지가 없습니다.",
  "page.label": (p) => `페이지 ${p.page}`,

  "side.panelAria": "편집 패널",
  "tabs.para": "문단",
  "tabs.table": "표",
  "tabs.fields": "필드",

  "error.prefix.load": "문서 열기 실패",
  "error.prefix.apply": "편집 적용 실패",
  "error.prefix.compose": "문서 생성 실패",
  "error.kind.timeout": "엔진 시간 초과",
  "error.kind.unavailable": "hwp 실행 파일 없음",
  "error.kind.protected": "보호/배포 문서",
  "error.kind.generic": "",

  "compose.title": "새 문서 만들기",
  "compose.docType": "문서 유형",
  "compose.docTypeAria": "문서 유형",
  "compose.titleLabel": "제목",
  "compose.titlePlaceholder": "문서 제목",
  "compose.authorLabel": "작성자",
  "compose.authorPlaceholder": "작성자 (선택)",
  "compose.bodyLabel": "본문",
  "compose.bodyPlaceholder":
    "빈 줄로 문단을 구분합니다. '# '로 시작하는 줄은 소제목이 됩니다.\n\n예)\n# 1. 개요\n본문 내용...",
  "compose.cancel": "취소",
  "compose.submit": "문서 생성",
  "compose.submitting": "생성 중...",
  "compose.defaultFileStem": "새 문서",

  "presets.official": "공문",
  "presets.report": "보고서",
  "presets.plan": "계획서",
  "presets.notice": "안내문",
  "presets.minutes": "회의록",
  "presets.gaejosik": "개조식 문서",
  "presets.press": "보도자료",

  "segment.panelAria": "문단 편집",
  "segment.hint": "페이지를 클릭해 편집할 문단을 선택하세요.",
  "segment.selectedPara": (p) => `선택 문단 (구역 ${p.section}, 문단 ${p.para})`,
  "segment.emptyPara": "(빈 문단)",
  "segment.replaceLabel": "텍스트 교체",
  "segment.replacePlaceholder": "새 텍스트",
  "segment.replaceSubmit": "교체",
  "segment.insertLabel": "문단 삽입",
  "segment.insertPlaceholder": "삽입할 문단 텍스트",
  "segment.insertBefore": "앞에 삽입",
  "segment.insertAfter": "뒤에 삽입",
  "segment.deletePara": "문단 삭제",
  "segment.alignLabel": "정렬",
  "segment.alignGroupAria": "문단 정렬",
  "segment.alignLeft": "왼쪽",
  "segment.alignCenter": "가운데",
  "segment.alignRight": "오른쪽",
  "segment.alignJustify": "양쪽",
  "segment.formatLabel": "글자 서식",
  "segment.bold": "굵게",
  "segment.sizePlaceholder": "크기(pt)",
  "segment.sizeAria": "글자 크기(pt)",
  "segment.colorAria": "글자 색상",
  "segment.formatSubmit": "서식 적용",

  "table.panelAria": "표 편집",
  "table.hint":
    "표가 포함된 영역을 페이지에서 선택하세요. 표가 아닌 문단이 선택되어 있습니다.",
  "table.tableLabel": (p) => `표 #${p.index}`,
  "table.cellLabel": (p) => `셀 (${p.row}, ${p.col})`,
  "table.setCell": "셀 설정",
  "table.mergeAnchor": "병합 기준 지정",
  "table.mergeWithAnchor": "기준 셀과 병합",
  "table.splitCell": "셀 분할",
  "table.rowsCols": "행/열",
  "table.addRow": "행 추가",
  "table.addCol": "열 추가",
  "table.deleteRow": "행 삭제",
  "table.deleteCol": "열 삭제",
  "table.deleteTable": "표 삭제",

  "fields.panelAria": "필드",
  "fields.hint": "문서에서 {{이름}} 형태의 필드 자리표시자를 찾지 못했습니다.",
  "fields.valuePlaceholder": "새 값",
  "fields.fieldValueAria": (p) => `필드 ${p.name} 값`,
  "fields.setValue": "설정",
};

/**
 * Lookup function. Keys with a function value REQUIRE their params object;
 * plain-string keys accept no second argument — both enforced per key by
 * the conditional variadic below, so a missing or wrong params object is a
 * compile error at the call site.
 */
export type TFunction = <K extends MessageKey>(
  key: K,
  ...args: MessageTable[K] extends (p: infer P) => string ? [params: P] : []
) => string;

/**
 * Build a `t()` bound to one locale and one set of host overrides.
 * Merge order: `en` -> locale table -> `messages` (last wins, per key).
 */
export function createT(
  locale: Locale,
  messages?: HwpEditorMessages,
): TFunction {
  const table: MessageTable = {
    ...en,
    ...(locale === "ko" ? ko : {}),
    ...messages,
  };
  // The cast is contained here: the public TFunction signature still gives
  // call sites full per-key parameter checking.
  return ((key: MessageKey, params?: unknown): string => {
    const value = table[key];
    return typeof value === "function"
      ? (value as (p: unknown) => string)(params)
      : value;
  }) as TFunction;
}
