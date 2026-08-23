# @hwp-editor/react

Embeddable React UI for Korean HWP/HWPX documents, built on
[`@hwp-editor/core`](../core). All document work (read/render/edit/compose/
validate) goes through the `HwpEngine` interface — this package contains UI
only.

## Usage

```tsx
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css"; // required: styles are not auto-injected

<HwpEditor
  engine={engine}            // HwpEngine (e.g. createHttpEngine from core)
  file={document}            // DocumentHandle | null
  onChange={(doc) => ...}    // document bytes changed (apply / undo / compose)
  onDirtyChange={(dirty) => ...}
/>
```

Editing model: segment-based structured editing. Rendered pages are the
visual canvas; clicking selects a segment; the side panel builds typed
`EditOp`s; **Apply** commits all queued ops in one `engine.edit()` call and
re-renders; **되돌리기 (Revert)** restores the snapshot taken before the last
applied edit. Protected/distribution documents open read-only with a notice
(engine `capabilities().editable === false`).

Keyboard: `Escape` clears the selection; `Cmd/Ctrl+Enter` applies pending ops.

## Styling contract

Zero component-kit imports, zero Tailwind, zero runtime CSS-in-JS. All
classes carry the `.hwped` prefix. Hosts theme ONLY via CSS variables, set on
the editor root or any ancestor:

| Variable         | Purpose                              |
| ---------------- | ------------------------------------ |
| `--hwped-bg`     | surface background                   |
| `--hwped-fg`     | primary text                         |
| `--hwped-muted`  | secondary text / disabled            |
| `--hwped-accent` | primary actions, selection highlight |
| `--hwped-border` | hairline borders                     |
| `--hwped-radius` | corner radius                        |
| `--hwped-font`   | font stack (default: Pretendard -> system) |

Defaults ship in `theme.css` with a `prefers-color-scheme: dark` fallback.

## Components

- `HwpEditor` — top level: toolbar (apply/revert/validation badge/pending
  count/protected notice/new document) | `PageCanvas` | side panel tabs.
- `PageCanvas` — multi-page scroll; SVG inline render (sanitized:
  script/foreignObject/event handlers stripped) with `<img>` fallback;
  click -> nearest segment; highlight bands for the selected segment and
  segments covered by pending ops.
- `SegmentInspector` — replace text, insert para before/after, delete para,
  set-align, set-format (bold/size/color subset).
- `TableGrid` — cell selection, set-cell, add/delete row/col, merge/split
  cell, delete-table. Addressing follows the CLI's 0-based
  `table:row:col` grammar (row 0 = header row).
- `FieldsPanel` — lists `{{name}}` placeholder slots from the read()
  envelope; set-field editing; click jumps to the containing segment.
- `ComposePanel` — preset picker (official/report/plan/notice/minutes/
  gaejosik/press) + guided form -> DocumentSpec v2 -> `engine.compose()`.

## Known limitations (engine contract)

- **Hit-testing is approximate.** Neither the core segment envelope nor the
  hwp-cli SVG renderer exposes per-paragraph page geometry. Clicks and
  highlight bands use a linear text-flow model (see `src/geometry.ts`); the
  highlight is the exact inverse of the click mapping, so they always agree.
  A future hwp-cli layout API can replace this without UI changes.
- **FieldsPanel lists template slots, not native fields.** The engine
  contract has no `hwp fields` / `hwp bookmarks` route, so the panel works
  with `{{name}}` placeholders in the markdown.
- **Table structure is read from GFM markdown.** Merged cells are flattened
  to their anchor cell text; merge/split ops still address the real HWP
  table via CLI coordinates.

## Develop

```sh
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
```
