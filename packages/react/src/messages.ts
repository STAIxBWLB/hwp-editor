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

// A limit a sentence states is read from the limit itself: a printed "10 MiB"
// goes stale the moment the byte bound moves, in both locales at once. The
// stopped sentence is the same rule: the English one is the sentence the core
// message already carries, so a host that reads text and the editor that reads
// the marker cannot print two different accounts of one failure (#91).
import { MAX_IMAGE_ASSET_MIB, NO_ENGINE_CAUSE, STOPPED_WITHOUT_DIAGNOSTIC } from "@hwp-editor/core";

export const en = {
  // Toolbar
  "toolbar.toolsAria": "Editing tools",
  "toolbar.readOnly": "Read-only",
  "toolbar.pendingList": "Pending edit targets",
  "toolbar.clearPending": "Clear pending edits",
  "toolbar.removePending": (p: { index: number }): string => `Remove pending edit ${p.index}`,
  // Pending rows read as one localized operation name plus its target
  // (pending-ops.ts holds the kind to key map, and a new op kind must be named
  // there). The target half shows the engine's own indices, never JSON.
  "pending.kind.add-col": "Add table column",
  "pending.kind.add-row": "Add table row",
  "pending.kind.add-table": "Add table",
  "pending.kind.apply-style": "Apply style",
  "pending.kind.clone-table": "Clone table",
  "pending.kind.create-bookmark": "Create bookmark",
  "pending.kind.create-field": "Create field",
  "pending.kind.create-hyperlink": "Create hyperlink",
  "pending.kind.create-style": "Create style",
  "pending.kind.delete-bookmark": "Delete bookmark",
  "pending.kind.delete-col": "Delete table column",
  "pending.kind.delete-field": "Delete field",
  "pending.kind.delete-image": "Delete image",
  "pending.kind.delete-para": "Delete paragraph",
  "pending.kind.delete-row": "Delete table row",
  "pending.kind.delete-table": "Delete table",
  "pending.kind.indent-para": "Indent paragraph",
  "pending.kind.insert-blocks": "Insert component blocks",
  "pending.kind.insert-image": "Insert image",
  "pending.kind.insert-para": "Insert paragraph after",
  "pending.kind.insert-para-before": "Insert paragraph before",
  "pending.kind.merge-cells": "Merge table cells",
  "pending.kind.move-para": "Move paragraph",
  "pending.kind.outdent-para": "Outdent paragraph",
  "pending.kind.replace": "Replace text",
  "pending.kind.seal": "Seal with image",
  "pending.kind.set-align": "Set alignment",
  "pending.kind.set-cell": "Set table cell",
  "pending.kind.set-field": "Set field value",
  "pending.kind.set-format": "Set character format",
  "pending.kind.set-meta": "Set document metadata",
  "pending.kind.set-page": "Set page setup",
  "pending.kind.set-para": "Set paragraph shape",
  "pending.kind.split-cell": "Split table cell",
  "pending.kind.style-tables": "Restyle tables for the preset",
  "pending.kind.update-style": "Update style",
  "pending.target.at": (p: { section: number; paragraph: number }): string =>
    `section ${p.section}, paragraph ${p.paragraph} (0-based)`,
  "pending.target.run": (p: { section: number; paragraph: number; run: number }): string =>
    `run ${p.run} of section ${p.section}, paragraph ${p.paragraph} (0-based)`,
  "pending.target.chars": (p: { range: string; start: number; end: number }): string =>
    `source characters ${p.start} to ${p.end} (0-based UTF-16, end excluded), of ${p.range}`,
  "pending.target.id": (p: { id: string }): string => `element ${p.id}`,
  "pending.target.wholeRun": (p: { id: string }): string => `the whole run of element ${p.id}`,
  "pending.target.wholePiece": (p: { id: string }): string =>
    `the whole piece of element ${p.id}`,
  "pending.target.document": "the whole document",
  // A table is named by the same ordinal the table panel shows, not by the
  // engine's 0-based index the op carries, so a reader can match a queued row
  // to the panel. The paragraph and run targets above state their base instead,
  // because no panel shows them.
  "pending.target.table": (p: { index: number }): string => `Table #${p.index}`,
  // The ops with a second target name it in the row: which text a replace
  // looks for, which side of a paragraph blocks land on, and where a move puts
  // the paragraph. Each locale composes the two halves in its own word order.
  "pending.target.before": (p: { range: string }): string => `before ${p.range}`,
  "pending.target.after": (p: { range: string }): string => `after ${p.range}`,
  "pending.target.moveTo": (p: { range: string; destination: string; before: boolean }): string =>
    `${p.range} ${p.before ? "before" : "after"} ${p.destination}`,
  "pending.target.replaceFind": (p: { find: string; range: string }): string =>
    `find "${p.find}" in ${p.range}`,
  // An apply-style row names the style beside its address, so two rows on the
  // same paragraph are told apart by what they apply.
  "pending.target.styleOn": (p: { style: string; range: string }): string =>
    `${p.style} on ${p.range}`,
  "image.deleteAllHint": "Deletes every image in every paragraph containing this text, including matches in other sections, table cells and text boxes. Review the text before applying.",
  "fields.deleteAllHint": "Deletes every field with this name, including repeated fields in templates.",
  "fields.deleteAllBookmarksHint": "Deletes every bookmark with this name.",
  "segment.legacyHyperlinkSeparator": "This legacy host cannot represent => in a hyperlink anchor, text or URL. Remove it or use a host with the JSON edit channel.",
  "document.invalidDimension": "Page width and height must be greater than zero; enter a positive plain decimal.",
  "unit.positive": "Enter a plain decimal greater than zero.",
  "table.legacySeparatorHint": "Legacy table creation and cloning cannot use => in anchors. Remove it or use the JSON edit channel.",
  "fields.legacySeparatorHint": "Legacy creation cannot use => in anchors or field names; agent-hwp splits --create-bookmark once and keeps the rest, so a bookmark name may hold it. Field creation and value edits cannot use = in a field name. Remove these separators or use the JSON edit channel.",
  "image.queueLimit": (p: { count: number; miB: number }): string => `Adding this image would exceed the pending limit (${p.count} images or ${p.miB} MiB). Apply or remove pending images first.`,
  "unit.invalid": "Enter a non-negative plain decimal such as 0.5; signs, leading dots and exponent notation are not supported.",
  "segment.hyperlinkHint": "The link uses the first paragraph containing this text. Use unique paragraph text to avoid linking an earlier match.",
  "image.dimensionsHint": "Leave both dimensions empty for the image's natural size.",
  "image.invalidDimensions": "Enter positive plain decimals for both dimensions, or leave both empty for natural size.",
  "image.referenceMismatch": "The image reference does not match its upload; select the image again and retry.",
  "fields.initialValueAria": "Initial field value",
  "fields.bookmarkAnchorAria": "Bookmark anchor paragraph",
  "fields.deleteFieldNameAria": "Field name to delete",
  "fields.deleteBookmarkNameAria": "Bookmark name to delete",
  "table.sourceTable": (p: { index: number }): string => `Source table: ${p.index}`,
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
  "tabs.templates": "Templates",
  "tabs.lint": "Lint",
  "tabs.components": "Components",

  // Component palette
  "components.panelAria": "Component palette",
  "components.catalogueAria": "Components you can insert",
  "components.hint":
    "A component is inserted beside the selected paragraph, with the values below filled in.",
  "components.insert": (p: { name: string }): string => `Insert ${p.name}`,
  "components.positionLabel": "Insert at",
  "components.positionAria": "Insertion position",
  "components.positionBefore": "Before the paragraph",
  "components.positionAfter": "After the paragraph",
  "components.positionBeforeLocked":
    "The first paragraph of a section holds its page setup, so nothing can be inserted before it. Insert " +
    "the component after that paragraph, or select another paragraph.",
  "components.paramAria": (p: { name: string }): string => `${p.name} values`,
  "components.paramLabel": (p: { name: string; param: string }): string =>
    `${p.name}: ${p.param}`,
  "components.moveUp": (p: { name: string }): string => `Move ${p.name} up`,
  "components.moveDown": (p: { name: string }): string => `Move ${p.name} down`,
  "components.remove": (p: { name: string }): string => `Remove ${p.name}`,
  "components.noSelection": "Select a paragraph in the document first.",
  "components.noAddress":
    "The selection cannot be addressed: this host's document read reports no segment ids.",
  "components.disabledVersion": (p: { version: string }): string =>
    `Inserting components requires agent-hwp ${p.version} or newer, because older engines report no inserted ids.`,
  "components.disabledChannel":
    "This host cannot send typed edit operations, so a component cannot be inserted.",
  "components.noReport":
    "The component is in the document, but this host returned no edit report, so the editor cannot " +
    "select what it created; open the paragraph tab and pick the inserted paragraphs to move or remove them.",
  "components.reportTruncated":
    "The edit report capped the ids it lists, so the inserted paragraphs cannot be selected; insert a " +
    "smaller component, or pick the new paragraphs in the paragraph list.",
  "components.tooWide": (p: { width: string; available: string }): string =>
    `This component is ${p.width} wide and the insertion point is only ${p.available}, so the engine ` +
    "refuses it. Insert it where the body is wide enough (beside a top-level paragraph, not inside a " +
    "cell), or use a narrower component.",
  "components.tooWideUnmeasured": (p: { width: string }): string =>
    `This component is ${p.width} wide and the engine refused it as too wide for where it would go. ` +
    "Insert it beside a top-level paragraph rather than inside a cell, or use a narrower component.",
  "components.tooWideUnknown":
    "The engine refused the insertion as too wide for where it would go. Insert it where the body is " +
    "wide enough, or use a narrower component.",
  "components.insertionRefused": (p: { reason?: string }): string =>
    p.reason === undefined || p.reason === ""
      ? "The engine refused this insertion. Check the component and the insertion point, then retry."
      : `The engine refused this insertion: ${p.reason}. Check the component and the insertion point, then retry.`,
  "components.preflightImage":
    "This component inserts an image, and the palette stages no image bytes, so the engine would refuse " +
    "the insertion. Insert the image with the Images panel, or change the component to paragraphs and " +
    "tables.",
  "components.preflightSectionBreak":
    "This component starts a section of its own, and a component insertion cannot carry a section break. " +
    "Use a page or column break inside the component, or start the new section from the document panel.",
  "components.preflightEquation": (p: { name: string }): string =>
    `The open document is ${p.name}, an .hwp file, and the engine cannot insert an equation into one. ` +
    "Save it as .hwpx and insert the component again, or remove the equation.",
  "components.pendingEdits":
    "Apply or clear the queued edits first: an insertion replaces the whole document, so an edit " +
    "waiting to be applied would be lost.",
  "components.refused": (p: {
    code: string;
    source: string;
    field: string;
    value: string;
    step: string;
  }): string =>
    (p.field === ""
      ? `${p.source} was refused (${p.code}). `
      : `${p.source}: ${p.field}${p.value === "" ? "" : ` = ${p.value}`} was refused (${p.code}). `) +
    p.step,
  "components.unknownStyle": (p: { style: string }): string =>
    `The target document has no style named "${p.style}", so the engine refused the component. Define ` +
    "that style in the component's own styles, or reference one the document already has, then insert " +
    "it again.",
  "components.invalidDefinition":
    "The engine refused the component's block, style or list definitions. Check the component's blocks, " +
    "styles and lists, then insert it again.",
  "components.step.param":
    "Correct that value in the panel, or fix the component's params, then insert it again.",
  "components.step.style":
    "Define the style under its own name based on the profile style, or fix the reference, then insert it again.",
  "components.step.invalid":
    "Fix the component's file so every field matches the component contract, then load it again.",
  "components.step.load":
    "Check the component file's path or URL and its JSON, then load it again.",

  // Error line — the prefix names which operation failed. The `{message}`
  // tail stays engine-authored and is never translated.
  "error.prefix.load": "Failed to open document",
  // Both re-reads land here (a refresh the host asks for, and the read an undo
  // performs), and the editor has no Refresh control, so the next step is the
  // action the reader just took rather than a button that is not on the page.
  "error.prefix.refresh": "Could not re-read the open document, so nothing changed; try the same action again",
  "error.prefix.apply": "Failed to apply edits",
  "error.prefix.compose": "Failed to create document",
  "error.prefix.template": "Template operation failed",
  "error.prefix.lint": "Lint failed",
  // Badge labels; "generic" renders no chip, hence the empty string.
  "error.kind.timeout": "Engine timed out",
  "error.kind.unavailable": "ahwp binary unavailable",
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
  "compose.loadingInFlight": "A document is still loading. Creating one now would replace the file you just chose, so this waits for the load to finish.",
  /** Filename stem used when the compose form has no title. */
  "compose.defaultFileStem": "New document",
  "compose.componentsTitle": "Or assemble from components",
  "compose.componentsHint":
    "Added components become the document in this order. While the list is not empty, the document type, author and body above are not used.",
  "compose.componentsEmpty": "No components added.",
  "compose.componentPicker": "Component to add",
  "compose.addComponent": "Add",
  "compose.assemblyAria": "Components in this document, in order",
  "compose.paramAria": (p: { component: string; param: string }): string =>
    `${p.param} for ${p.component}`,

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
  "segment.paragraphChoices": "Paragraph selection",
  "segment.choiceLabel": (p: { index: number; text: string }): string => `Paragraph ${p.index}: ${p.text}`,
  "segment.rangeTextAria": "Text range",
  "segment.rangeWholeRunHint": "Markdown markers are shown. A selection inside one run formats the characters it covers, and a selection that covers none of them names nothing for that run. A run is formatted as the whole run when it publishes no source offsets, when its published span does not match the text it shows in this document's format (a trimmed edge space, a paragraph break this editor cannot place there), or when the editor cannot read its text back character for character: an equation, a hard line break, a footnote, an image, a link, a field, a control counted in the source, and - deliberately conservative - a literal ampersand, < or backslash, which this host does publish as themselves.",
  "segment.rangeUnavailable": "Run metadata is unavailable. Update the host to provide segment-envelope-v2 run information, then reload.",
  "segment.rangeUnavailableNoRuns": "This paragraph has no runs of its own, so there is no text range to select inside it. Use the whole paragraph.",
  "segment.rangeInvalid": "This selection covers no character of a run in this paragraph, so there is nothing to format. Select text inside one run, or use the whole paragraph.",
  "segment.rangeSplit": "This selection starts or ends inside one character that is stored as a surrogate pair (an emoji or another character outside the basic plane), so it has no character boundary to land on. Move the start or end to before or after that character.",
  "segment.rangeRunCount": (p: { count: number }): string =>
    p.count === 1 ? "1 target selected" : `${p.count} targets selected`,
  "segment.rangeWholeRunTargets": (p: { count: number }): string =>
    p.count === 1 ? "1 target formats the whole run" : `${p.count} targets format the whole run`,
  "segment.formatRunCount": (p: { count: number }): string => `Formatting targets: ${p.count}`,
  "segment.rangeClear": "Use whole paragraph",
  "segment.placeholderLabel": "Template placeholder",
  "segment.placeholderHint": "Replaces the selected runs with a {{name}} slot that the Template panel can fill in.",
  "segment.placeholderNameAria": "Placeholder name",
  "segment.placeholderNamePlaceholder": "name",
  "segment.placeholderCreate": "Make placeholder",
  "segment.placeholderRefused": "Placeholders can be made only from plain text in a body paragraph with no pending edits; edit this text directly or apply pending edits first.",
  "segment.placeholderNameEmpty": "Enter a name for the placeholder, such as owner.",
  "segment.placeholderNameInvalid": "Use a name without braces or control characters, such as owner or amount.",
  "segment.selectedCount": (p: { count: number }): string =>
    p.count === 1 ? "1 paragraph selected" : `${p.count} paragraphs selected`,
  "segment.selectedRunCount": (p: { count: number }): string =>
    p.count === 1 ? "1 run selected" : `${p.count} runs selected`,
  "segment.multiTextEditHint": "Text replacement and insertion target one paragraph. Select one paragraph to use those controls.",
  "segment.rangeTextEditHint": "A character range formats text but cannot rewrite it. Use whole paragraph to edit its text.",
  "segment.runTextEditHint": "A run selection formats runs only, so the text controls are off. Select a paragraph to edit its text.",
  "segment.runSelectionParagraphs": (p: { count: number }): string =>
    p.count === 1
      ? "Alignment and spacing apply to the 1 paragraph containing a selected run."
      : `Alignment and spacing apply to all ${p.count} paragraphs containing a selected run.`,
  "segment.runSelectionTerminal": "Starts a new paragraph selection",
  "segment.noParagraphSelection": "This selection carries no paragraph the engine can address, so paragraph edits are off. Pick a paragraph from the list above.",
  "segment.cellSelectionRefused": "This selection is a table cell. Alignment and spacing apply to every paragraph in the cell, but replace, insert and delete address exactly one paragraph, and the engine refuses to delete a cell's last one. Pick a paragraph from the list above.",
  "segment.tableSelectionRefused": "This selection is a table, not a paragraph. The paragraph that holds the table also holds its own text, so editing or deleting it would take the table with it. Pick a paragraph from the list above.",
  "segment.containerSelectionRefused": "This selection is an image, a field or a bookmark. It has no text of its own: its range belongs to the paragraph that holds it, and deleting that paragraph would delete the text with it. Pick a paragraph from the list above.",
  "segment.selectSimilar": "Select content with matching direct formatting",
  "segment.similarChar": "Matching character format",
  "segment.similarPara": "Matching paragraph format",
  "segment.similarCharUnavailable": "Character-format metadata is unavailable for this paragraph. Load an envelope that includes direct character properties, then select it again.",
  "segment.similarParaUnavailable": "Paragraph-format metadata is unavailable for this paragraph. Load an envelope that includes direct paragraph properties, then select it again.",
  "segment.addressedUnavailable": "This host cannot apply addressed edits. Update the host and Tauri client to use the edit-ops-v1 JSON channel, then advertise editOps: v1. See docs/integration-maru.md.",
  "segment.selectedPara": (p: { path: string }): string => `Selected paragraph at ${p.path}`,
  "segment.selectedCell": (p: { path: string; count: number }): string =>
    `Selected table cell at ${p.path} (${p.count === 1 ? "1 paragraph" : `${p.count} paragraphs`})`,
  "segment.emptyPara": "(empty paragraph)",
  "segment.replaceLabel": "Replace text",
  "segment.replacePlaceholder": "New text",
  "segment.replaceSubmit": "Replace",
  "segment.insertLabel": "Insert paragraph",
  "segment.insertPlaceholder": "Paragraph text to insert",
  "segment.insertBefore": "Insert before",
  "segment.insertAfter": "Insert after",
  "segment.moveUp": "Move up",
  "segment.moveDown": "Move down",
  "segment.deletePara": "Delete paragraph",
  "segment.multiReorderRefused":
    "Move and delete act on one paragraph or on paragraphs next to each other in the same place. Select such a run to move or delete it together.",
  "segment.sectionDefinitionLocked":
    "The first paragraph of a section holds the section's page setup, so it cannot be moved or deleted, " +
    "and no paragraph can be moved or inserted above it. Insert after it, or pick another paragraph.",
  "segment.alignLabel": "Alignment",
  "segment.alignGroupAria": "Paragraph alignment",
  "segment.alignLeft": "Left",
  "segment.alignCenter": "Center",
  "segment.alignRight": "Right",
  "segment.alignJustify": "Justify",
  "segment.alignDistribute": "Distribute",
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
  // #97 item 1: the two counts can disagree in either direction, and the cause
  // differs, so the sentence names the direction it is telling (#101 item 2).
  // More engine tables means one the envelope never draws (a note, header,
  // footer or hidden-comment table), which shifts every number after it; fewer
  // means the count was not taken from the tables this read published, so no
  // number can be trusted wherever it falls. Both end on a step the reader can
  // take. Each count is singularised: "counts 1 tables" reads as a bug.
  "table.indexMismatch": (p: { engine: number; published: number }): string =>
    p.engine > p.published
      ? `The engine counts ${p.engine} ${p.engine === 1 ? "table" : "tables"} in this document but this editor shows ${p.published}, because a table inside a note, a header, a footer or a hidden comment is counted there and not shown here. The numbers of the tables after it point at a different table than the one you picked, so table edits are off: move that table into the body and reload, or edit the document in a word processor.`
      : `The engine counts ${p.engine} ${p.engine === 1 ? "table" : "tables"} in this document but this editor shows ${p.published}, which is more than the engine's own table walk reached. The two walks disagree about which tables they count, so a table number cannot be trusted wherever it falls. Table edits are off: reload the document, and if the two counts still disagree, edit it in a word processor.`,
  "table.htmlTable": (p: { index: number }): string =>
    `Table #${p.index} holds a merged cell, or a cell with block content such as a nested table, a list or a paragraph of its own, so the engine writes it as HTML and there is no cell grid to show here. Its number still holds this table's slot in the numbering. To edit it here, unmerge the cell, or move the nested block out of the cell, in a word processor, then reopen the document.`,
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
  "templates.panelAria": "Templates and document fields",
  "templates.disabled": (p: { reason: string; remedy: string }): string => `${p.reason} ${p.remedy}`,
  "templates.remedy": "Upgrade agent-hwp to 1.4.0 or newer, or ask the host to expose this command.",
  "templates.versionRequired": (p: { version: string }): string => `agent-hwp ${p.version} or newer is required.`,
  "templates.methodMissing": (p: { method: string }): string => `The host does not provide ${p.method}.`,
  "templates.methodUnadvertised": (p: { method: string }): string => `The host does not advertise ${p.method}.`,
  "templates.methodSlots": "document field listing",
  "templates.methodFill": "document fill",
  "templates.methodTemplate": "TemplateSpec rendering",
  "templates.methodLint": "document lint",
  "templates.methodList": "embedded template listing",
  "templates.methodCreate": "embedded template creation",
  "templates.kindSlot": "placeholder",
  "templates.kindField": "native field",
  "templates.kindForm": "form field",
  "templates.kindList": "List",
  "templates.invalidSpec": "This is not a TemplateSpec v1 file; choose a JSON file with version 1.0 and variables, then load it again.",
  "templates.invalidJson": "The file is not valid JSON; correct it and load the file again.",
  "templates.readSpecFailed": "The file could not be read; check file access and load it again.",
  "templates.invalidSpecSource": "The TemplateSpec source is missing; add a source object and load the file again.",
  "templates.invalidVariable": (p: { variable: string }): string => `Variable ${p.variable} has an unsupported type; use string, number, date, enum, bool, or list, then load the file again.`,
  "templates.invalidVariableKey": (p: { variable: string }): string => `Variable key ${p.variable} is invalid; use a letter followed by letters, numbers, or underscores, then load the file again.`,
  "templates.invalidEnum": (p: { variable: string }): string => `Enum ${p.variable} needs string options; correct it and load the file again.`,
  "templates.invalidList": (p: { variable: string }): string => `List ${p.variable} has invalid fields; use supported typed fields and load the file again.`,
  "templates.invalidListFieldKey": (p: { field: string }): string => `List field key ${p.field} is invalid; use a letter followed by letters, numbers, or underscores, then load the file again.`,
  "templates.openDocument": "Open a document to inspect and fill its fields.",
  "templates.loading": "Reading document fields...",
  "templates.documentInputs": "Document fields",
  "templates.noInputs": "No template slots or form fields were found.",
  "templates.specLabel": "Load a TemplateSpec v1 JSON file",
  "templates.chooseValue": "Choose a value",
  "templates.previewFill": "Preview filled document",
  "templates.previewSpec": "Preview template",
  "templates.rendering": "Rendering preview...",
  "templates.previewAria": "Rendered template preview",
  "templates.previewReady": (p: { pages: number }): string => `Preview ready (${p.pages} pages).`,
  "templates.previewPage": (p: { page: number }): string => `Preview page ${p.page}`,
  "templates.apply": "Apply to document",
  "templates.hwpOnly": "Fill requires an HWPX document.",
  "templates.pendingEdits": "Apply or clear pending edits before replacing this document.",
  "templates.listAdd": "Add row",
  "templates.listRemove": (p: { row: number }): string => `Remove row ${p.row}`,
  "templates.listFieldAria": (p: { row: number; field: string }): string => `Row ${p.row}, ${p.field}`,
  "templates.richBlocksUnsupported": "This form does not support rich block variables; edit the TemplateSpec and load it again.",
  "templates.embeddedPicker": "Built-in templates",
  "templates.createEmbedded": "Create from template",
  "lint.panelAria": "Document lint",
  "lint.profile": "Profile",
  "lint.gongmun": "Official document",
  "lint.report": "Report",
  "lint.run": "Run lint",
  "lint.running": "Checking...",
  "lint.clean": "No lint findings.",
  "lint.errors": (p: { count: number }): string => `Errors (${p.count})`,
  "lint.warnings": (p: { count: number }): string => `Warnings (${p.count})`,
  "lint.location": (p: { line: number; col: number }): string => `Line ${p.line}, column ${p.col}`,
  "lint.noContext": "No context provided.",
  "lint.disabled": (p: { reason: string; remedy: string }): string => `${p.reason} ${p.remedy}`,
  "error.staleReplacement": "The document changed during template work; reopen it and try again.",
  "error.staleCompose": "The open document changed while the new document was being composed; compose again.",
  "error.stalePreview": "The document changed while this preview was being made; preview again on the open document.",
  "error.unmatchedReplace": "The engine found no text to replace in that paragraph, so nothing was applied. Select the text again and retry.",
  "error.runRangeConflict": "A run format change was refused because an earlier pending change in that paragraph (text, a link, a field, a bookmark, an image or a cell) may change its text, so the run might no longer name the same characters. Nothing was applied. Remove the format change from the pending list, apply the rest, then format the run again; or queue the format change before the others.",
  "error.rangeTagRefused": "This HWP document holds a range mark the engine cannot move, so a pending edit was refused and nothing was applied. Edits that move text around the mark are refused: changing a paragraph's text length, changing a field's value to one of a different length, inserting or deleting a link, field, bookmark or image, or deleting a table. A table cell that holds a mark refuses any change to its content. The engine does not say which edit. Remove those pending edits from the pending list (a same-length text replacement in a paragraph, or a same-length field value, is accepted) and apply the rest. To make those edits, convert the document to HWPX, which drops the range marks, or remove the mark in Hangul, then reopen it; reopening drops the pending list.",
  "error.stoppedWithoutDiagnostic": STOPPED_WITHOUT_DIAGNOSTIC,
  // The same rule for a failure with stderr but no Error: line (#140).
  "error.noEngineCause": NO_ENGINE_CAUSE,
  "error.readOnlyReplacement": "The editor became read-only before the template could be applied; switch to an editable document and retry.",
  "error.pendingReplacement": "Pending edits would be lost; apply or clear them before replacing this document.",
  "error.loadingReplacement": "A new document is still loading; wait for it to finish, then retry.",
  "error.staleApply": "The document changed while this edit was running, so its result was discarded; apply again.",
  "error.staleRefresh": "Another document started loading while this one was being re-read, so that reading was discarded; refresh again on the document now open.",
  "error.staleRefreshEdit": "An edit or undo landed on this document while it was being re-read, so that reading was discarded; refresh again to re-read the edited document.",
  "error.staleRevert": "Another document started loading while the undo was running, so its result was discarded; undo again on the document now open.",
  "document.panelAria": "Document settings",
  "document.metadata": "Metadata",
  "document.metaTitle": "Title",
  "document.metaAuthor": "Author",
  "document.metaSubject": "Subject",
  "document.metaKeywords": "Keywords",
  "document.valuePlaceholder": "Value",
  "document.setMeta": "Set metadata",
  "document.pageSetup": "Page setup",
  "document.pageKeyAria": "Page setting",
  "document.pageValueAria": "Page value",
  "document.setPage": "Set page",
  "document.page.width": "Width",
  "document.page.height": "Height",
  "document.page.marginLeft": "Left margin",
  "document.page.marginRight": "Right margin",
  "document.page.marginTop": "Top margin",
  "document.page.marginBottom": "Bottom margin",
  "document.page.orientation": "Orientation",
  "document.orientation.portrait": "Portrait",
  "document.orientation.landscape": "Landscape",
  "segment.paraShapeLabel": "Paragraph shape",
  "segment.paraShapeKeyAria": "Shape key",
  "segment.paraShapeValueAria": "Shape value",
  "segment.paraShapeUnitAria": "Line spacing unit",
  "segment.unitPercent": "Percent (%)",
  "segment.unitPoints": "Points (pt)",
  "segment.setPara": "Set paragraph shape",
  "segment.hyperlinkLabel": "Create hyperlink",
  "segment.hyperlinkUrlPlaceholder": "URL",
  "segment.hyperlinkUrlAria": "Link URL",
  "segment.hyperlinkTextPlaceholder": "Link text",
  "segment.hyperlinkTextAria": "Link text",
  "segment.createHyperlink": "Create hyperlink",
  "segment.shape.lineSpacing": "Line spacing",
  "segment.shape.indent": "First-line indent",
  "segment.shape.left": "Left",
  "segment.shape.right": "Right",
  "segment.shape.top": "Top",
  "segment.shape.bottom": "Bottom",
  "fields.createField": "Create field",
  "fields.anchorPlaceholder": "Anchor paragraph",
  "fields.anchorAria": "Anchor",
  "fields.namePlaceholder": "Field name",
  "fields.nameAria": "Name",
  "fields.createFieldSubmit": "Create field",
  "fields.deleteField": "Delete field",
  "fields.bookmarkNamePlaceholder": "Bookmark name",
  "fields.bookmarkNameAria": "Bookmark name",
  "fields.createBookmark": "Create bookmark",
  "fields.deleteBookmark": "Delete bookmark",
  "table.addTable": "Add table",
  "table.cloneTable": "Clone table",
  "table.anchorPlaceholder": "Anchor paragraph",
  "table.anchorAria": "New table anchor",
  "table.cloneAnchorAria": "Clone destination anchor",
  "table.cloneModeAria": "Clone mode",
  "table.cloneBlank": "Blank cells",
  "table.cloneKeep": "Keep cells",
  "table.addTableRowsLabel": "Rows (tab or | separated cells)",
  "table.addTableRowPlaceholder": "Tab or | separated cells, one row per line",
  "tabs.document": "Document",
  "tabs.images": "Images",

  "image.panelAria": "Images",
  "image.insert": "Insert image",
  "image.delete": "Delete image",
  "image.file": "PNG/JPEG image file",
  "image.fileHint": `Choose a PNG or JPEG image up to ${MAX_IMAGE_ASSET_MIB} MiB.`,
  "image.unsupported": "Image upload needs a host with an upload command. With the agent-hwp engine, use 1.4.0 or newer, the version this editor verifies uploads against. A supplied engine has to advertise image-asset uploads. The desktop app has no upload command, and this editor cannot insert a picture from a local file, so insert the picture in a word processor and reopen the document here.",
  "image.anchor": "Insert after paragraph text",
  "image.deleteAnchor": "Image anchor text to delete",
  "image.width": "Width (mm)",
  "image.height": "Height (mm)",
  "image.reading": "Reading image...",
  "image.invalidSize": `The image is empty or exceeds ${MAX_IMAGE_ASSET_MIB} MiB; choose a smaller PNG/JPEG file.`,
  "image.invalidType": "The file is not PNG/JPEG image data; choose a supported image.",
  "image.readError": "The image could not be read; select the file again.",
  "error.prefix.image": "Image operation failed",

  "tabs.styles": "Styles",
  "styles.unavailable": (p: { version: string }): string =>
    p.version === ""
      ? "Named styles need agent-hwp 1.4.0 or newer, and this engine reports no version. Upgrade agent-hwp on the host, then retry."
      : `Named styles need agent-hwp 1.4.0 or newer; this engine reports ${p.version}. Upgrade agent-hwp on the host, then retry.`,
  "styles.unavailableHost": "This host does not serve the styles command; update the engine adapter on the host, then retry.",
  "styles.checkingHost": "Checking whether this host supports named styles...",
  "styles.loading": "Reading styles...",
  "styles.loadFailed": "The style table could not be read; read it again in the Styles tab.",
  "styles.retry": "Retry reading styles",
  "styles.empty": "This document defines no paragraph styles.",
  "styles.kindUnknown": "The document does not record this style's kind, so it cannot be edited here. Edit the paragraph directly, or rebuild the document so the style carries its kind.",
  "styles.attrsUnresolved": "Some of this style's shapes do not resolve in this document, so those fields are unavailable rather than filled with a default. Set what resolves here, or edit the paragraph directly.",
  "styles.usage": (p: { count: number }): string =>
    p.count === 1 ? "Used by 1 paragraph" : `Used by ${p.count} paragraphs`,
  "styles.selectHint": "Select a style to highlight the paragraphs that use it.",
  "styles.definition": "Style definition",
  "styles.size": "Size (pt)",
  "styles.font": "Font",
  "styles.bold": "Bold",
  "styles.lineSpacing": "Line spacing (%)",
  "styles.updateSubmit": "Queue style change",
  "styles.applyToSelection": "Apply to selection",
  "styles.promoteName": "New style name",
  "styles.promoteSubmit": "Promote selection to style",
  "styles.promoteHint": "Creates a paragraph style from the selected paragraph's formatting and applies it to every paragraph that matches.",
  "styles.nameInvalid": "A style name cannot contain control characters.",
  "styles.presetLabel": "Preset",
  "styles.presetHint": "One undo step: rewrites the body style and restyles tables under the preset in one edit.",
  "styles.presetSubmit": "Apply preset",
  "styles.pendingEdits": "Apply or clear the queued edits first: switching the preset replaces the whole document, so an edit waiting to be applied would be lost.",
  "styles.noTableToStyle": "The preset's style change was applied; this document has no multi-column table to restyle.",
  "styles.noTableToStyleNoChange": "Nothing changed: this document has no multi-column table to restyle, and its body style already matches the preset.",
  "styles.noBodyStyleToUpdate": "Nothing changed: this document defines no paragraph style for the preset to update, and no multi-column table to restyle.",
  "styles.presetUnchanged": "Nothing changed: the document already matches this preset.",
  "styles.needsParagraph": "Select a paragraph first.",
  "segment.directFormatting": "Direct formatting",
  "segment.directFormattingHint": "This paragraph's formatting differs from its style. Clearing it keeps the style and removes the overrides.",
  "segment.clearDirect": "Clear direct formatting",
  "segment.directStyleUnknown": "The document's style table does not list this paragraph, so its style name is unknown here and the overrides cannot be cleared safely. Reload the document; if it stays unlisted, the host's styles command does not name it.",
  "segment.directStyleLoading": "The style table is still loading, so this paragraph's style name is not known yet.",
  "segment.directStyleFailed": "The style table could not be read, so this paragraph's style name is unknown and the overrides cannot be cleared safely. Read it again in the Styles tab.",
  "segment.directStyleUnavailable": "This engine does not publish style names: the styles command needs agent-hwp 1.4.0 or newer, so the overrides cannot be cleared safely here.",

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
  "toolbar.pendingList": "대기 편집 대상",
  "toolbar.clearPending": "대기 편집 모두 지우기",
  "toolbar.removePending": (p) => `대기 편집 ${p.index} 제거`,
  "pending.kind.add-col": "표 열 추가",
  "pending.kind.add-row": "표 행 추가",
  "pending.kind.add-table": "표 추가",
  "pending.kind.apply-style": "스타일 적용",
  "pending.kind.clone-table": "표 복제",
  "pending.kind.create-bookmark": "책갈피 만들기",
  "pending.kind.create-field": "필드 만들기",
  "pending.kind.create-hyperlink": "하이퍼링크 만들기",
  "pending.kind.create-style": "스타일 만들기",
  "pending.kind.delete-bookmark": "책갈피 삭제",
  "pending.kind.delete-col": "표 열 삭제",
  "pending.kind.delete-field": "필드 삭제",
  "pending.kind.delete-image": "이미지 삭제",
  "pending.kind.delete-para": "문단 삭제",
  "pending.kind.delete-row": "표 행 삭제",
  "pending.kind.delete-table": "표 삭제",
  "pending.kind.indent-para": "문단 들여쓰기",
  "pending.kind.insert-blocks": "구성 요소 블록 삽입",
  "pending.kind.insert-image": "이미지 삽입",
  "pending.kind.insert-para": "뒤에 문단 삽입",
  "pending.kind.insert-para-before": "앞에 문단 삽입",
  "pending.kind.merge-cells": "표 셀 병합",
  "pending.kind.move-para": "문단 이동",
  "pending.kind.outdent-para": "문단 내어쓰기",
  "pending.kind.replace": "텍스트 교체",
  "pending.kind.seal": "직인 이미지 넣기",
  "pending.kind.set-align": "정렬 지정",
  "pending.kind.set-cell": "표 셀 값 지정",
  "pending.kind.set-field": "필드 값 지정",
  "pending.kind.set-format": "글자 서식 지정",
  "pending.kind.set-meta": "문서 정보 지정",
  "pending.kind.set-page": "페이지 설정",
  "pending.kind.set-para": "문단 모양 지정",
  "pending.kind.split-cell": "셀 분할",
  "pending.kind.style-tables": "프리셋으로 표 서식 변경",
  "pending.kind.update-style": "스타일 수정",
  "pending.target.at": (p) => `구역 ${p.section}, 문단 ${p.paragraph} (0 기준)`,
  "pending.target.run": (p) => `구역 ${p.section}, 문단 ${p.paragraph}의 run ${p.run} (0 기준)`,
  "pending.target.chars": (p) => `${p.range}의 소스 문자 ${p.start}부터 ${p.end} 전까지 (0 기준 UTF-16, 끝 제외)`,
  "pending.target.id": (p) => `요소 ${p.id}`,
  "pending.target.wholeRun": (p) => `요소 ${p.id}의 run 전체`,
  "pending.target.document": "문서 전체",
  "pending.target.table": (p) => `표 #${p.index}`,
  "pending.target.before": (p) => `${p.range} 앞`,
  "pending.target.after": (p) => `${p.range} 뒤`,
  "pending.target.moveTo": (p) => `${p.range} → ${p.destination} ${p.before ? "앞" : "뒤"}`,
  "pending.target.replaceFind": (p) => `${p.range}에서 "${p.find}" 찾기`,
  "pending.target.styleOn": (p) => `${p.range}에 ${p.style}`,
  "pending.target.wholePiece": (p) => `요소 ${p.id}의 run 조각 전체`,
  "image.deleteAllHint": "이 텍스트를 포함하는 모든 문단의 모든 이미지를 삭제합니다. 다른 구역, 표 셀, 글상자의 일치 항목도 포함합니다. 적용 전에 텍스트를 확인하세요.",
  "fields.deleteAllHint": "이 이름을 가진 모든 필드를 삭제합니다. 템플릿의 반복 필드도 포함합니다.",
  "fields.deleteAllBookmarksHint": "이 이름을 가진 모든 책갈피를 삭제합니다.",
  "segment.legacyHyperlinkSeparator": "이 레거시 호스트는 링크 위치, 텍스트, URL의 =>를 표현할 수 없습니다. 해당 문자를 제거하거나 JSON 편집 채널을 지원하는 호스트를 사용하세요.",
  "document.invalidDimension": "용지 너비와 높이는 0보다 커야 합니다. 양수인 일반 소수를 입력하세요.",
  "unit.positive": "0보다 큰 일반 소수를 입력하세요.",
  "table.legacySeparatorHint": "레거시 표 생성·복제는 위치 텍스트의 =>를 지원하지 않습니다. 해당 문자를 제거하거나 JSON 편집 채널을 사용하세요.",
  "fields.legacySeparatorHint": "레거시 생성 기능은 위치나 필드 이름의 =>를 지원하지 않습니다. agent-hwp는 --create-bookmark를 한 번만 나누고 나머지를 이름으로 쓰므로 책갈피 이름에는 =>를 쓸 수 있습니다. 필드 생성·값 수정 시 필드 이름의 =도 지원하지 않습니다. 구분자를 제거하거나 JSON 편집 채널을 사용하세요.",
  "image.queueLimit": (p) => `이 이미지를 추가하면 대기 한도(이미지 ${p.count}개 또는 ${p.miB} MiB)를 초과합니다. 먼저 적용하거나 대기 중인 이미지를 제거하세요.`,
  "unit.invalid": "0.5처럼 0 이상의 일반 소수를 입력하세요. 부호, 맨 앞 소수점, 지수 표기는 지원하지 않습니다.",
  "segment.hyperlinkHint": "이 텍스트를 포함하는 첫 문단에 링크를 만듭니다. 앞선 문단에 잘못 연결되지 않도록 고유한 문단 텍스트를 사용하세요.",
  "image.dimensionsHint": "원래 이미지 크기를 사용하려면 너비와 높이를 모두 비워 두세요.",
  "image.invalidDimensions": "너비와 높이를 모두 양수인 일반 소수로 입력하거나, 원래 크기를 사용하려면 둘 다 비워 두세요.",
  "image.referenceMismatch": "이미지 참조와 업로드가 일치하지 않습니다. 이미지를 다시 선택하고 재시도하세요.",
  "fields.initialValueAria": "필드 초기 값",
  "fields.bookmarkAnchorAria": "책갈피 위치 문단",
  "fields.deleteFieldNameAria": "삭제할 필드 이름",
  "fields.deleteBookmarkNameAria": "삭제할 책갈피 이름",
  "table.sourceTable": (p) => `원본 표: ${p.index}`,
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
  "tabs.templates": "템플릿",
  "tabs.lint": "문서 검사",
  "tabs.components": "구성 요소",

  "components.panelAria": "구성 요소 팔레트",
  "components.catalogueAria": "삽입할 수 있는 구성 요소",
  "components.hint": "구성 요소는 선택한 문단 옆에 삽입되며, 아래에 채운 값이 반영됩니다.",
  "components.insert": (p: { name: string }): string => `${p.name} 삽입`,
  "components.positionLabel": "삽입 위치",
  "components.positionAria": "삽입 위치",
  "components.positionBefore": "문단 앞",
  "components.positionAfter": "문단 뒤",
  "components.positionBeforeLocked":
    "구역의 첫 문단은 구역의 용지 설정을 담고 있어 그 앞에는 아무것도 삽입할 수 없습니다. " +
    "그 문단 뒤에 삽입하거나 다른 문단을 선택하세요.",
  "components.paramAria": (p: { name: string }): string => `${p.name} 값`,
  "components.paramLabel": (p: { name: string; param: string }): string =>
    `${p.name}: ${p.param}`,
  "components.moveUp": (p: { name: string }): string => `${p.name} 위로 이동`,
  "components.moveDown": (p: { name: string }): string => `${p.name} 아래로 이동`,
  "components.remove": (p: { name: string }): string => `${p.name} 삭제`,
  "components.noSelection": "먼저 문서에서 문단을 선택하세요.",
  "components.noAddress": "선택 항목의 주소를 알 수 없습니다. 이 호스트의 문서 읽기 결과에 세그먼트 식별자가 없습니다.",
  "components.disabledVersion": (p: { version: string }): string =>
    `구성 요소 삽입에는 agent-hwp ${p.version} 이상이 필요합니다. 이전 엔진은 삽입한 식별자를 보고하지 않습니다.`,
  "components.disabledChannel": "이 호스트는 형식이 지정된 편집 연산을 보낼 수 없어 구성 요소를 삽입할 수 없습니다.",
  "components.noReport":
    "구성 요소는 문서에 들어갔지만 이 호스트가 편집 리포트를 주지 않아, 삽입된 문단을 선택할 수 없습니다. " +
    "문단 탭에서 삽입된 문단을 직접 선택해 옮기거나 삭제하세요.",
  "components.reportTruncated":
    "편집 리포트가 나열하는 식별자를 잘라내 삽입된 문단을 선택할 수 없습니다. 더 작은 구성 요소를 넣거나 문단 목록에서 새 문단을 직접 선택하세요.",
  "components.tooWide": (p: { width: string; available: string }): string =>
    `이 구성 요소의 너비는 ${p.width}이고 삽입 지점의 너비는 ${p.available}뿐이라 엔진이 거부합니다. ` +
    "본문이 충분히 넓은 곳(셀 안이 아니라 최상위 문단 옆)에 넣거나 더 좁은 구성 요소를 사용하세요.",
  "components.tooWideUnmeasured": (p: { width: string }): string =>
    `이 구성 요소의 너비는 ${p.width}이고, 들어갈 자리에 비해 넓다고 엔진이 거부했습니다. ` +
    "셀 안이 아니라 최상위 문단 옆에 넣거나 더 좁은 구성 요소를 사용하세요.",
  "components.tooWideUnknown":
    "들어갈 자리에 비해 넓다고 엔진이 삽입을 거부했습니다. 본문이 충분히 넓은 곳에 넣거나 더 좁은 구성 요소를 사용하세요.",
  "components.insertionRefused": (p: { reason?: string }): string =>
    p.reason === undefined || p.reason === ""
      ? "엔진이 이 삽입을 거부했습니다. 구성 요소와 삽입 지점을 확인한 뒤 다시 시도하세요."
      : `엔진이 이 삽입을 거부했습니다: ${p.reason}. 구성 요소와 삽입 지점을 확인한 뒤 다시 시도하세요.`,
  "components.preflightImage":
    "이 구성 요소는 그림을 삽입하는데, 팔레트는 그림 바이트를 준비하지 않으므로 엔진이 삽입을 거부합니다. " +
    "그림 탭에서 그림을 넣거나 구성 요소를 문단과 표로 바꾸세요.",
  "components.preflightSectionBreak":
    "이 구성 요소는 자체 구역으로 시작하는데, 구성 요소 삽입은 구역 나누기를 함께 보낼 수 없습니다. " +
    "구성 요소 안에서는 쪽이나 단 나누기를 쓰거나, 문서 탭에서 새 구역을 시작하세요.",
  "components.preflightEquation": (p: { name: string }): string =>
    `열려 있는 문서 ${p.name}은(는) .hwp 파일이고, 엔진은 .hwp에 수식을 삽입할 수 없습니다. ` +
    ".hwpx로 저장한 뒤 구성 요소를 다시 삽입하거나 수식을 빼세요.",
  "components.pendingEdits":
    "먼저 대기 중인 편집을 적용하거나 지우세요. 삽입은 문서 전체를 바꾸므로, 아직 적용되지 않은 편집이 사라집니다.",
  "components.refused": (p: {
    code: string;
    source: string;
    field: string;
    value: string;
    step: string;
  }): string =>
    (p.field === ""
      ? `${p.source}이(가) 거부되었습니다(${p.code}). `
      : `${p.source}: ${p.field}${p.value === "" ? "" : ` = ${p.value}`}이(가) 거부되었습니다(${p.code}). `) + p.step,
  "components.unknownStyle": (p: { style: string }): string =>
    `대상 문서에 '${p.style}' 스타일이 없어 엔진이 구성 요소를 거부했습니다. 그 스타일을 구성 요소의 ` +
    "styles에 정의하거나 문서에 이미 있는 스타일을 참조한 뒤 다시 삽입하세요.",
  "components.invalidDefinition":
    "구성 요소의 블록, 스타일, 목록 정의를 엔진이 거부했습니다. " +
    "구성 요소의 blocks, styles, lists를 확인한 뒤 다시 삽입하세요.",
  "components.step.param": "패널에서 그 값을 고치거나 구성 요소의 매개변수를 수정한 뒤 다시 삽입하세요.",
  "components.step.style":
    "프로파일 스타일을 based_on으로 두고 자기 이름으로 스타일을 정의하거나 참조를 고친 뒤 다시 삽입하세요.",
  "components.step.invalid": "구성 요소 파일의 모든 필드가 구성 요소 규약에 맞도록 고친 뒤 다시 불러오세요.",
  "components.step.load": "구성 요소 파일의 경로나 URL과 JSON을 확인한 뒤 다시 불러오세요.",

  "error.prefix.load": "문서 열기 실패",
  "error.prefix.refresh": "열린 문서를 다시 읽지 못해 아무것도 바뀌지 않았습니다. 같은 작업을 다시 시도하세요",
  "error.prefix.apply": "편집 적용 실패",
  "error.prefix.compose": "문서 생성 실패",
  "error.prefix.template": "템플릿 작업 실패",
  "error.prefix.lint": "문서 검사 실패",
  "error.kind.timeout": "엔진 시간 초과",
  "error.kind.unavailable": "ahwp 실행 파일 없음",
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
  "compose.loadingInFlight": "문서를 아직 불러오는 중입니다. 지금 새 문서를 만들면 방금 고른 파일을 덮어쓰게 되므로, 불러오기가 끝난 뒤에 만들 수 있습니다.",
  "compose.defaultFileStem": "새 문서",
  "compose.componentsTitle": "또는 구성 요소로 만들기",
  "compose.componentsHint":
    "추가한 구성 요소가 이 순서대로 문서가 됩니다. 목록이 비어 있지 않으면 위의 문서 유형, 작성자, 본문은 사용되지 않습니다.",
  "compose.componentsEmpty": "추가한 구성 요소가 없습니다.",
  "compose.componentPicker": "추가할 구성 요소",
  "compose.addComponent": "추가",
  "compose.assemblyAria": "이 문서의 구성 요소 순서",
  "compose.paramAria": (p) => `${p.component}의 ${p.param}`,

  "presets.official": "공문",
  "presets.report": "보고서",
  "presets.plan": "계획서",
  "presets.notice": "안내문",
  "presets.minutes": "회의록",
  "presets.gaejosik": "개조식 문서",
  "presets.press": "보도자료",

  "segment.panelAria": "문단 편집",
  "segment.hint": "페이지를 클릭해 편집할 문단을 선택하세요.",
  "segment.paragraphChoices": "문단 선택",
  "segment.choiceLabel": (p) => `문단 ${p.index}: ${p.text}`,
  "segment.rangeTextAria": "텍스트 범위",
  "segment.rangeWholeRunHint": "마크다운 표시가 보입니다. 한 run 안에서 선택한 글자에만 서식이 적용되며, 선택이 어떤 글자도 덮지 않으면 그 run은 대상이 되지 않습니다. 소스 위치가 없는 run, 이 문서 형식에서 게시된 폭이 보이는 글자와 맞지 않는 run(끝 공백이 잘렸거나, 문단 나눔을 그 위치에 둘 수 없는 경우), 또는 수식·강제 줄바꿈·각주·이미지·링크·필드·소스에 포함된 컨트롤 때문에 글자 그대로 되짚을 수 없는 run은 run 전체에 적용됩니다. 앰퍼샌드, <, 역슬래시도 같은 이유로 run 전체에 적용됩니다(이 호스트는 실제로 그대로 게시하지만, 폭을 넓게 잡아 둔 판단입니다).",
  "segment.rangeUnavailable": "run 정보가 없습니다. segment-envelope-v2의 run 정보를 제공하도록 호스트를 업데이트한 뒤 다시 불러오세요.",
  "segment.rangeUnavailableNoRuns": "이 문단에는 자체 run이 없어 안쪽에서 선택할 텍스트 범위가 없습니다. 문단 전체를 사용하세요.",
  "segment.rangeInvalid": "선택한 범위가 이 문단에서 run의 글자를 하나도 덮지 않아 서식을 적용할 대상이 없습니다. 한 run 안에서 텍스트를 선택하거나 문단 전체를 사용하세요.",
  "segment.rangeSplit": "선택 범위의 시작이나 끝이 서로게이트 쌍으로 저장된 한 글자(이모지 등 기본 평면 밖 문자) 안쪽에 있습니다. 그 위치에는 글자 경계가 없으므로, 선택 범위의 시작이나 끝을 그 글자 앞이나 뒤로 옮기세요.",
  "segment.rangeRunCount": (p) => p.count === 1 ? "대상 1개 선택" : `대상 ${p.count}개 선택`,
  "segment.rangeWholeRunTargets": (p) => p.count === 1 ? "대상 1개는 run 전체에 적용됩니다" : `대상 ${p.count}개는 run 전체에 적용됩니다`,
  "segment.formatRunCount": (p) => `서식 적용 대상: ${p.count}개`,
  "segment.rangeClear": "문단 전체 사용",
  "segment.placeholderLabel": "템플릿 자리표시자",
  "segment.placeholderHint": "선택한 run을 {{name}} 슬롯으로 바꾸어 템플릿 탭에서 값을 채울 수 있게 합니다.",
  "segment.placeholderNameAria": "자리표시자 이름",
  "segment.placeholderNamePlaceholder": "이름",
  "segment.placeholderCreate": "자리표시자 만들기",
  "segment.placeholderRefused": "자리표시자는 대기 중인 편집이 없는 본문 문단의 일반 텍스트에서만 만들 수 있습니다. 텍스트를 직접 편집하거나 대기 중인 편집을 먼저 적용하세요.",
  "segment.placeholderNameEmpty": "자리표시자 이름을 입력하세요. 예: owner.",
  "segment.placeholderNameInvalid": "중괄호나 제어 문자가 없는 이름을 사용하세요. 예: owner, amount.",
  "segment.selectedCount": (p) => `선택한 문단 ${p.count}개`,
  "segment.selectedRunCount": (p) => `선택한 run ${p.count}개`,
  "segment.multiTextEditHint": "텍스트 교체와 삽입은 한 문단을 대상으로 합니다. 이 기능을 사용하려면 문단 하나를 선택하세요.",
  "segment.rangeTextEditHint": "글자 범위 선택은 서식만 바꿀 수 있고 텍스트는 바꿀 수 없습니다. 텍스트를 편집하려면 문단 전체를 사용하세요.",
  "segment.runTextEditHint": "run 선택은 서식만 바꿀 수 있어 텍스트 입력란을 쓸 수 없습니다. 텍스트를 편집하려면 문단을 선택하세요.",
  "segment.runSelectionParagraphs": (p) => `문단 정렬과 간격은 선택한 run이 있는 문단 ${p.count}개 전체에 적용됩니다.`,
  "segment.runSelectionTerminal": "새 문단 선택이 시작됩니다",
  "segment.noParagraphSelection": "이 선택에는 엔진이 주소로 지정할 수 있는 문단이 없어 문단 편집을 사용할 수 없습니다. 위 목록에서 문단을 선택하세요.",
  "segment.cellSelectionRefused": "이 선택은 표의 셀입니다. 정렬과 문단 모양은 셀 안의 모든 문단에 적용되지만, 교체, 삽입, 삭제는 문단 하나만 대상으로 하며, 엔진은 셀의 마지막 문단 삭제도 거부합니다. 위 목록에서 문단을 선택하세요.",
  "segment.tableSelectionRefused": "이 선택은 문단이 아니라 표입니다. 표를 담고 있는 문단은 자기 텍스트도 함께 담고 있어, 그 문단을 편집하거나 삭제하면 표가 사라집니다. 위 목록에서 문단을 선택하세요.",
  "segment.containerSelectionRefused": "이 선택은 그림, 필드 또는 책갈피입니다. 자체 텍스트가 없어 그 범위는 그것을 담은 문단에 속하고, 그 문단을 삭제하면 텍스트까지 함께 삭제됩니다. 위 목록에서 문단을 선택하세요.",
  "segment.selectSimilar": "직접 서식이 같은 내용 선택",
  "segment.similarChar": "같은 글자 서식",
  "segment.similarPara": "같은 문단 서식",
  "segment.similarCharUnavailable": "이 문단의 글자 서식 메타데이터를 사용할 수 없습니다. 직접 글자 속성이 포함된 문서 정보를 불러온 뒤 다시 선택하세요.",
  "segment.similarParaUnavailable": "이 문단의 문단 서식 메타데이터를 사용할 수 없습니다. 직접 문단 속성이 포함된 문서 정보를 불러온 뒤 다시 선택하세요.",
  "segment.addressedUnavailable": "이 호스트는 주소 기반 편집을 지원하지 않습니다. 호스트와 Tauri 클라이언트를 edit-ops-v1 JSON 채널로 업데이트한 뒤 editOps: v1 지원을 표시하세요. docs/integration-maru.md를 참고하세요.",
  "segment.selectedPara": (p) => `선택 문단 위치 ${p.path}`,
  "segment.selectedCell": (p) => `선택한 표 셀 ${p.path} (문단 ${p.count}개)`,
  "segment.emptyPara": "(빈 문단)",
  "segment.replaceLabel": "텍스트 교체",
  "segment.replacePlaceholder": "새 텍스트",
  "segment.replaceSubmit": "교체",
  "segment.insertLabel": "문단 삽입",
  "segment.insertPlaceholder": "삽입할 문단 텍스트",
  "segment.insertBefore": "앞에 삽입",
  "segment.insertAfter": "뒤에 삽입",
  "segment.moveUp": "위로 이동",
  "segment.moveDown": "아래로 이동",
  "segment.deletePara": "문단 삭제",
  "segment.multiReorderRefused":
    "이동과 삭제는 문단 하나, 또는 같은 자리에서 연속한 문단들을 대상으로 합니다. 그런 문단들을 함께 선택하면 한 번에 옮기거나 삭제할 수 있습니다.",
  "segment.sectionDefinitionLocked":
    "구역의 첫 문단은 구역의 용지 설정을 담고 있어 옮기거나 삭제할 수 없고, 그 위로 다른 문단을 옮기거나 삽입할 수도 없습니다. 이 문단 뒤에 삽입하거나 다른 문단을 선택하세요.",
  "segment.alignLabel": "정렬",
  "segment.alignGroupAria": "문단 정렬",
  "segment.alignLeft": "왼쪽",
  "segment.alignCenter": "가운데",
  "segment.alignRight": "오른쪽",
  "segment.alignJustify": "양쪽",
  "segment.alignDistribute": "배분",
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
  "table.indexMismatch": (p) =>
    p.engine > p.published
      ? `엔진은 이 문서에서 표 ${p.engine}개를 세지만 이 편집기는 ${p.published}개를 보여 줍니다. 각주·미주, 머리말·꼬리말, 숨은 설명 안의 표는 엔진이 세지만 여기에는 표시되지 않습니다. 그 표 뒤에 오는 표의 번호가 고른 표가 아닌 다른 표를 가리키게 되므로 표 편집을 꺼 두었습니다. 해당 표를 본문으로 옮긴 뒤 다시 열거나, 워드프로세서에서 문서를 편집하세요.`
      : `엔진은 이 문서에서 표 ${p.engine}개를 세지만 이 편집기는 ${p.published}개를 보여 줍니다. 엔진이 센 수보다 많이 보인다는 것은 두 쪽이 세는 표가 다르다는 뜻이므로, 어느 자리의 표 번호도 신뢰할 수 없습니다. 표 편집을 꺼 두었습니다. 문서를 다시 열고, 그래도 두 수가 다르면 워드프로세서에서 문서를 편집하세요.`,
  "table.htmlTable": (p) =>
    `표 #${p.index}에 병합된 셀이 있거나 셀 안에 중첩 표·목록·별도 문단 같은 블록 내용이 있어 엔진이 HTML로 기록하므로 여기에는 셀 격자를 그릴 수 없습니다. 표 번호는 번호 체계에서 이 표의 자리를 그대로 차지합니다. 여기서 편집하려면 워드프로세서에서 셀 병합을 풀거나 셀 안의 블록을 셀 밖으로 옮긴 뒤 문서를 다시 여세요.`,
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
  "templates.panelAria": "템플릿 및 문서 필드",
  "templates.disabled": (p) => `${p.reason} ${p.remedy}`,
  "templates.remedy": "agent-hwp 1.4.0 이상으로 업그레이드하거나 호스트에서 해당 명령을 지원해야 합니다.",
  "templates.versionRequired": (p) => `agent-hwp ${p.version} 이상이 필요합니다.`,
  "templates.methodMissing": (p) => `호스트가 ${p.method} 기능을 제공하지 않습니다.`,
  "templates.methodUnadvertised": (p) => `호스트가 ${p.method} 기능을 지원한다고 알리지 않았습니다.`,
  "templates.methodSlots": "문서 필드 목록 조회",
  "templates.methodFill": "문서 필드 채우기",
  "templates.methodTemplate": "TemplateSpec 렌더링",
  "templates.methodLint": "문서 검사",
  "templates.methodList": "내장 템플릿 목록 조회",
  "templates.methodCreate": "내장 템플릿 생성",
  "templates.kindSlot": "자리표시자",
  "templates.kindField": "네이티브 필드",
  "templates.kindForm": "양식 필드",
  "templates.kindList": "목록",
  "templates.invalidSpec": "TemplateSpec v1 파일이 아닙니다. version 1.0과 variables가 있는 JSON 파일을 선택해 다시 불러오세요.",
  "templates.invalidJson": "파일이 올바른 JSON이 아닙니다. 수정한 뒤 다시 불러오세요.",
  "templates.readSpecFailed": "파일을 읽지 못했습니다. 파일 접근 권한을 확인한 뒤 다시 불러오세요.",
  "templates.invalidSpecSource": "TemplateSpec에 source가 없습니다. source 객체를 추가한 뒤 다시 불러오세요.",
  "templates.invalidVariable": (p) => `변수 ${p.variable} 형식이 지원되지 않습니다. string, number, date, enum, bool, list 중 하나로 수정한 뒤 다시 불러오세요.`,
  "templates.invalidVariableKey": (p) => `변수 키 ${p.variable}가 올바르지 않습니다. 영문자로 시작하고 영문자, 숫자, 밑줄만 사용한 뒤 다시 불러오세요.`,
  "templates.invalidEnum": (p) => `enum ${p.variable} 선택지는 문자열이어야 합니다. 수정한 뒤 다시 불러오세요.`,
  "templates.invalidList": (p) => `list ${p.variable} 필드 구성이 올바르지 않습니다. 지원되는 유형의 필드로 수정한 뒤 다시 불러오세요.`,
  "templates.invalidListFieldKey": (p) => `목록 필드 키 ${p.field}가 올바르지 않습니다. 영문자로 시작하고 영문자, 숫자, 밑줄만 사용한 뒤 다시 불러오세요.`,
  "templates.openDocument": "문서의 필드를 확인하고 채우려면 문서를 여세요.",
  "templates.loading": "문서 필드를 읽는 중...",
  "templates.documentInputs": "문서 필드",
  "templates.noInputs": "템플릿 자리표시자 또는 양식 필드가 없습니다.",
  "templates.specLabel": "TemplateSpec v1 JSON 파일 불러오기",
  "templates.chooseValue": "값 선택",
  "templates.previewFill": "채운 문서 미리 보기",
  "templates.previewSpec": "템플릿 미리 보기",
  "templates.rendering": "미리 보기를 렌더링하는 중...",
  "templates.previewAria": "렌더링된 템플릿 미리 보기",
  "templates.previewReady": (p) => `미리 보기 준비 완료 (${p.pages}페이지).`,
  "templates.previewPage": (p) => `미리 보기 ${p.page}페이지`,
  "templates.apply": "문서에 적용",
  "templates.hwpOnly": "채우기는 HWPX 문서가 필요합니다.",
  "templates.pendingEdits": "문서를 바꾸기 전에 대기 중인 편집을 적용하거나 지우세요.",
  "templates.listAdd": "행 추가",
  "templates.listRemove": (p) => `${p.row}행 삭제`,
  "templates.listFieldAria": (p) => `${p.row}행, ${p.field}`,
  "templates.richBlocksUnsupported": "이 양식은 서식 블록 변수를 지원하지 않습니다. TemplateSpec을 수정한 뒤 다시 불러오세요.",
  "templates.embeddedPicker": "기본 제공 템플릿",
  "templates.createEmbedded": "템플릿으로 만들기",
  "lint.panelAria": "문서 검사",
  "lint.profile": "검사 기준",
  "lint.gongmun": "공문",
  "lint.report": "보고서",
  "lint.run": "검사 실행",
  "lint.running": "검사 중...",
  "lint.clean": "검사 결과가 없습니다.",
  "lint.errors": (p) => `오류 (${p.count})`,
  "lint.warnings": (p) => `경고 (${p.count})`,
  "lint.location": (p) => `${p.line}행 ${p.col}열`,
  "lint.noContext": "제공된 문맥이 없습니다.",
  "lint.disabled": (p) => `${p.reason} ${p.remedy}`,
  "error.staleReplacement": "템플릿 작업 중 문서가 바뀌었습니다. 문서를 다시 연 뒤 재시도하세요.",
  "error.staleCompose": "새 문서를 작성하는 동안 열린 문서가 바뀌었습니다. 다시 작성하세요.",
  "error.stalePreview": "미리보기를 만드는 동안 문서가 바뀌었습니다. 열린 문서에서 다시 미리보기하세요.",
  "error.unmatchedReplace": "해당 문단에서 바꿀 텍스트를 엔진이 찾지 못해 아무것도 적용되지 않았습니다. 텍스트를 다시 선택한 뒤 재시도하세요.",
  "error.runRangeConflict": "같은 문단에 대기 중인 앞선 변경(텍스트, 링크, 필드, 책갈피, 이미지, 셀)이 문단 텍스트를 바꿀 수 있어 run이 더 이상 같은 글자를 가리키지 않을 수 있으므로 run 서식 변경이 거부되었습니다. 아무것도 적용되지 않았습니다. 대기 목록에서 서식 변경을 제거하고 나머지를 적용한 뒤 run 서식을 다시 지정하거나, 서식 변경을 다른 변경보다 먼저 대기열에 넣으세요.",
  "error.rangeTagRefused": "이 HWP 문서에는 엔진이 옮길 수 없는 구간 표시가 있어 대기 중인 편집이 거부되었고, 아무것도 적용되지 않았습니다. 구간 표시 주변의 글자를 움직이는 편집은 거부됩니다: 문단 텍스트 길이 변경, 길이가 다른 필드 값으로의 변경, 링크·필드·책갈피·이미지의 삽입이나 삭제, 표 삭제. 구간 표시가 있는 표 셀은 내용을 어떻게 바꾸든 거부합니다. 엔진은 어느 편집인지 알려 주지 않습니다. 대기 목록에서 해당 편집을 제거하고(문단 안의 같은 길이 텍스트 치환과 같은 길이의 필드 값은 허용됩니다) 나머지를 적용하세요. 그런 편집이 필요하면 문서를 HWPX로 변환하거나(변환하면 구간 표시가 사라집니다) 한글에서 구간 표시를 제거한 뒤 다시 여세요. 다시 열면 대기 목록은 사라집니다.",
  "error.noEngineCause": "엔진이 원인을 밝히지 않고 실패했으므로(대개 비정상 종료된 경우입니다) 아무것도 적용되지 않았습니다. 다시 적용하고, 같은 방식으로 실패하면 호스트 로그와 함께 알려 주세요.",
  "error.stoppedWithoutDiagnostic": "엔진이 진단 메시지를 남기지 않고 멈췄으므로(대개 강제 종료되었거나 메모리가 부족한 경우입니다) 아무것도 적용되지 않았습니다. 다시 적용하고, 같은 방식으로 실패하면 호스트 로그와 함께 알려 주세요.",
  "error.readOnlyReplacement": "템플릿을 적용하기 전에 편집기가 읽기 전용으로 바뀌었습니다. 편집 가능한 문서에서 다시 시도하세요.",
  "error.pendingReplacement": "대기 중인 편집이 사라질 수 있습니다. 문서를 바꾸기 전에 편집을 적용하거나 지우세요.",
  "error.loadingReplacement": "새 문서를 아직 불러오는 중입니다. 불러오기가 끝난 뒤에 다시 시도하세요.",
  "error.staleApply": "편집이 실행되는 동안 문서가 바뀌어 그 결과를 적용하지 않았습니다. 다시 적용하세요.",
  "error.staleRefresh": "다시 읽는 동안 다른 문서를 불러오기 시작해 그 결과를 버렸습니다. 지금 열린 문서에서 다시 새로 고치세요.",
  "error.staleRefreshEdit": "다시 읽는 동안 이 문서에 편집이나 되돌리기가 반영되어 그 결과를 버렸습니다. 편집된 문서를 읽으려면 다시 새로 고치세요.",
  "error.staleRevert": "되돌리는 동안 다른 문서를 불러오기 시작해 그 결과를 버렸습니다. 지금 열린 문서에서 다시 되돌리세요.",
  "document.panelAria": "문서 설정",
  "document.metadata": "문서 정보",
  "document.metaTitle": "제목",
  "document.metaAuthor": "작성자",
  "document.metaSubject": "주제",
  "document.metaKeywords": "키워드",
  "document.valuePlaceholder": "값",
  "document.setMeta": "문서 정보 설정",
  "document.pageSetup": "페이지 설정",
  "document.pageKeyAria": "페이지 설정 항목",
  "document.pageValueAria": "페이지 설정 값",
  "document.setPage": "페이지 설정 적용",
  "document.page.width": "너비",
  "document.page.height": "높이",
  "document.page.marginLeft": "왼쪽 여백",
  "document.page.marginRight": "오른쪽 여백",
  "document.page.marginTop": "위쪽 여백",
  "document.page.marginBottom": "아래쪽 여백",
  "document.page.orientation": "용지 방향",
  "document.orientation.portrait": "세로",
  "document.orientation.landscape": "가로",
  "segment.paraShapeLabel": "문단 모양",
  "segment.paraShapeKeyAria": "문단 모양 항목",
  "segment.paraShapeValueAria": "문단 모양 값",
  "segment.paraShapeUnitAria": "줄 간격 단위",
  "segment.unitPercent": "비율 (%)",
  "segment.unitPoints": "포인트 (pt)",
  "segment.setPara": "문단 모양 적용",
  "segment.hyperlinkLabel": "하이퍼링크 만들기",
  "segment.hyperlinkUrlPlaceholder": "URL",
  "segment.hyperlinkUrlAria": "링크 URL",
  "segment.hyperlinkTextPlaceholder": "링크 표시 문자열",
  "segment.hyperlinkTextAria": "링크 표시 문자열",
  "segment.createHyperlink": "하이퍼링크 만들기",
  "segment.shape.lineSpacing": "줄 간격",
  "segment.shape.indent": "첫 줄 들여쓰기",
  "segment.shape.left": "왼쪽",
  "segment.shape.right": "오른쪽",
  "segment.shape.top": "위쪽",
  "segment.shape.bottom": "아래쪽",
  "fields.createField": "필드 만들기",
  "fields.anchorPlaceholder": "위치 문단",
  "fields.anchorAria": "필드 위치 문단",
  "fields.namePlaceholder": "필드 이름",
  "fields.nameAria": "필드 이름",
  "fields.createFieldSubmit": "필드 만들기",
  "fields.deleteField": "필드 삭제",
  "fields.bookmarkNamePlaceholder": "책갈피 이름",
  "fields.bookmarkNameAria": "책갈피 이름",
  "fields.createBookmark": "책갈피 만들기",
  "fields.deleteBookmark": "책갈피 삭제",
  "table.addTable": "표 추가",
  "table.cloneTable": "표 복제",
  "table.anchorPlaceholder": "위치 문단",
  "table.anchorAria": "표 추가 위치 문단",
  "table.cloneAnchorAria": "복제 위치 문단",
  "table.cloneModeAria": "표 복제 방식",
  "table.cloneBlank": "빈 셀",
  "table.cloneKeep": "셀 내용 유지",
  "table.addTableRowsLabel": "표 행 (탭 또는 |로 셀 구분)",
  "table.addTableRowPlaceholder": "탭 또는 |로 셀을 구분하고 줄마다 한 행 입력",
  "tabs.document": "문서",
  "tabs.images": "이미지",

  "image.panelAria": "이미지",
  "image.insert": "이미지 삽입",
  "image.delete": "이미지 삭제",
  "image.file": "PNG/JPEG 이미지 파일",
  "image.fileHint": `${MAX_IMAGE_ASSET_MIB} MiB 이하의 PNG 또는 JPEG 이미지를 선택하세요.`,
  "image.unsupported": "이미지 업로드는 업로드 명령이 있는 호스트가 필요합니다. agent-hwp 엔진이라면 이 편집기가 업로드를 검증한 1.4.0 이상을 사용하세요. 엔진을 직접 공급하는 호스트는 이미지 자산 업로드를 지원한다고 알려야 합니다. 데스크톱 앱에는 업로드 명령이 없고 이 편집기는 로컬 파일에서 그림을 넣을 수 없으므로, 워드프로세서에서 그림을 넣은 뒤 이 편집기에서 문서를 다시 여세요.",
  "image.anchor": "이 문단 문자열 뒤에 삽입",
  "image.deleteAnchor": "삭제할 이미지의 위치 문자열",
  "image.width": "너비 (mm)",
  "image.height": "높이 (mm)",
  "image.reading": "이미지 읽는 중...",
  "image.invalidSize": `이미지가 비어 있거나 ${MAX_IMAGE_ASSET_MIB} MiB를 초과합니다. 더 작은 PNG/JPEG 파일을 선택하세요.`,
  "image.invalidType": "PNG/JPEG 이미지 데이터가 아닙니다. 지원하는 이미지 파일을 선택하세요.",
  "image.readError": "이미지를 읽을 수 없습니다. 파일을 다시 선택하세요.",
  "error.prefix.image": "이미지 작업 실패",

  "tabs.styles": "스타일",
  "styles.unavailable": (p: { version: string }): string =>
    p.version === ""
      ? "스타일 기능은 agent-hwp 1.4.0 이상이 필요합니다. 이 엔진은 버전을 보고하지 않습니다. 호스트의 agent-hwp를 업그레이드한 뒤 다시 시도하세요."
      : `스타일 기능은 agent-hwp 1.4.0 이상이 필요합니다. 이 엔진은 ${p.version}입니다. 호스트의 agent-hwp를 업그레이드한 뒤 다시 시도하세요.`,
  "styles.unavailableHost": "이 호스트는 스타일 명령을 제공하지 않습니다. 호스트의 엔진 어댑터를 업데이트한 뒤 다시 시도하세요.",
  "styles.checkingHost": "이 호스트가 스타일을 지원하는지 확인하는 중...",
  "styles.loading": "스타일 읽는 중...",
  "styles.loadFailed": "스타일 표를 읽지 못했습니다. 스타일 탭에서 표를 다시 읽으세요.",
  "styles.retry": "스타일 다시 읽기",
  "styles.empty": "이 문서에는 문단 스타일이 없습니다.",
  "styles.kindUnknown": "문서가 이 스타일의 종류를 기록하지 않아 여기서 편집할 수 없습니다. 문단을 직접 서식하거나, 스타일이 종류를 담고 있도록 문서를 다시 만드세요.",
  "styles.attrsUnresolved": "이 스타일의 서식 중 일부가 문서에서 확인되지 않아, 기본값으로 채우지 않고 해당 항목을 비활성화했습니다. 확인되는 항목만 설정하거나 문단을 직접 서식하세요.",
  "styles.usage": (p: { count: number }): string => `문단 ${p.count}개가 사용 중`,
  "styles.selectHint": "스타일을 선택하면 그 스타일을 쓰는 문단이 표시됩니다.",
  "styles.definition": "스타일 정의",
  "styles.size": "크기 (pt)",
  "styles.font": "글꼴",
  "styles.bold": "굵게",
  "styles.lineSpacing": "줄 간격 (%)",
  "styles.updateSubmit": "스타일 변경 예약",
  "styles.applyToSelection": "선택 영역에 적용",
  "styles.promoteName": "새 스타일 이름",
  "styles.promoteSubmit": "선택 영역을 스타일로 승격",
  "styles.promoteHint": "선택한 문단의 서식으로 문단 스타일을 만들고, 같은 서식을 쓰는 모든 문단에 적용합니다.",
  "styles.nameInvalid": "스타일 이름에는 제어 문자를 쓸 수 없습니다.",
  "styles.presetLabel": "프리셋",
  "styles.presetHint": "되돌리기 한 단계입니다. 본문 스타일과 표 서식을 한 번의 편집으로 함께 바꿉니다.",
  "styles.presetSubmit": "프리셋 적용",
  "styles.pendingEdits": "대기 중인 편집을 먼저 적용하거나 지우세요. 프리셋을 바꾸면 문서 전체를 교체하므로 아직 적용하지 않은 편집은 사라집니다.",
  "styles.noTableToStyle": "프리셋의 스타일 변경은 적용했습니다. 이 문서에는 서식을 바꿀 여러 열 표가 없습니다.",
  "styles.noTableToStyleNoChange": "바뀐 것이 없습니다. 이 문서에는 서식을 바꿀 여러 열 표가 없고, 본문 스타일은 이미 프리셋과 같습니다.",
  "styles.noBodyStyleToUpdate": "바뀐 것이 없습니다. 이 문서에는 프리셋이 바꿀 문단 스타일이 없고, 서식을 바꿀 여러 열 표도 없습니다.",
  "styles.presetUnchanged": "바뀐 것이 없습니다. 문서가 이미 이 프리셋과 같습니다.",
  "styles.needsParagraph": "먼저 문단을 선택하세요.",
  "segment.directFormatting": "직접 서식",
  "segment.directFormattingHint": "이 문단의 서식이 스타일과 다릅니다. 직접 서식을 지우면 스타일은 그대로 두고 덮어쓴 값만 제거합니다.",
  "segment.clearDirect": "직접 서식 지우기",
  "segment.directStyleUnknown": "문서의 스타일 표에 이 문단이 없어 스타일 이름을 알 수 없습니다. 덮어쓴 값을 안전하게 지울 수 없습니다. 문서를 다시 불러오고, 그래도 없으면 호스트의 스타일 명령이 이 문단을 알려주지 않는 것입니다.",
  "segment.directStyleLoading": "스타일 표를 아직 읽는 중이라 이 문단의 스타일 이름을 알 수 없습니다.",
  "segment.directStyleFailed": "스타일 표를 읽지 못해 이 문단의 스타일 이름을 알 수 없습니다. 덮어쓴 값을 안전하게 지울 수 없습니다. 스타일 탭에서 표를 다시 읽으세요.",
  "segment.directStyleUnavailable": "이 엔진은 스타일 이름을 알려주지 않습니다. 스타일 명령에는 agent-hwp 1.4.0 이상이 필요하므로 여기서는 덮어쓴 값을 안전하게 지울 수 없습니다.",

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
