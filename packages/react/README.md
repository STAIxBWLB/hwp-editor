# @hwp-editor/react

Embeddable React UI for Korean HWP/HWPX documents, built on
[`@hwp-editor/core`](https://www.npmjs.com/package/@hwp-editor/core). All document work (read/render/edit/compose/
validate) goes through the `HwpEngine` interface — this package contains UI
only.

## Install

```sh
pnpm add @hwp-editor/react
```

`@hwp-editor/core` arrives as a peer, deduped to a single copy; you do not name
it unless your own source imports from it. React 18 or 19 is a peer too.

The stylesheet is **not** auto-injected. An install that skips the import below
produces an editor that loads and renders unstyled, which no import check
notices.

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
`EditOp`s; the apply button commits all queued ops in one `engine.edit()`
call and re-renders; the undo button restores the snapshot taken before the
last applied edit. Both buttons are labelled from the active locale table,
so referring to them by a fixed label goes stale the moment the copy or the
locale changes. Protected/distribution documents open read-only with a notice
(engine `capabilities().editable === false`).

Keyboard: `Escape` clears the selection; `Cmd/Ctrl+Enter` applies pending ops.

## Props

| Prop | Type | Notes |
| ---- | ---- | ----- |
| `engine` | `HwpEngine` | Required. Every read/render/edit/compose/validate call goes through it. |
| `file` | `DocumentHandle \| null` | Required. `null` shows the empty state with the new-document entry point. |
| `locale` | `"en" \| "ko"` | UI chrome language. Defaults to `"en"`. Read at mount and on change, and also drives the editor root's `lang` attribute. Document content and engine-authored error prose are never translated. |
| `messages` | `Partial<MessageTable>` | Per-key overrides applied on top of the locale table. Merge order is `en` -> locale table -> `messages`, so a key you do not list keeps its locale default. An unknown key is a compile error. Import `en` / `ko` from this package to discover the keys. |
| `readOnly` | `boolean` | Forces the editor read-only regardless of what the engine reports, and never re-enables a document the engine reports as protected. **A UI affordance, not an authorization boundary** - it hides and disables controls in one browser, and a host that must actually prevent writes enforces that server-side, in front of the route handler. `@hwp-editor/server` provides that hook: `authorize(req, action)` refuses a request with HTTP 403 before any body is read, and its return value is also the tenant scope every server-side cache key is salted with. See [its trust boundary section](../server/README.md#trust-boundary). |
| `onReady` | `(document: DocumentHandle) => void` | Fires once per completed document load, after both the read and the render resolve, with the document that was loaded. Fires again on every `file` change. Never fires for `file={null}` or for a load cancelled by unmount. |
| `onError` | `(error: unknown) => void` | Fires for every engine failure (load, apply, undo, refresh, compose) carrying the caught value **verbatim**, so a host can branch on the stable `code` of a `HwpEngineError`. The inline alert renders either way; this is an addition to it, not a replacement. |
| `onChange` | `(document: DocumentHandle) => void` | Fires whenever the document bytes change: an applied edit, an undo, or a compose. |
| `onDirtyChange` | `(dirty: boolean) => void` | Fires when the dirty flag (pending ops queued) transitions. |
| `className` | `string` | Applied to the editor root. |
| `style` | `CSSProperties` | Applied to the editor root; the usual place to set `--hwped-*` variables. |

`locale` is a name collision worth stating plainly: this prop is the UI
chrome language and has nothing to do with `createCliEngine({ locale })` in
`@hwp-editor/server`, which sets the hwp-cli child process's `HWP_LANG`.
Setting one does not set the other.

## Imperative handle

`ref` exposes exactly four methods and no state getters, because hosts
observe state through the callbacks above, which stay in sync with React
rendering in a way a getter read from outside the render cycle cannot.

| Method | Returns | No-op when |
| ------ | ------- | ---------- |
| `apply()` | `Promise<void>` | The queue is empty, no document is loaded, an apply is already in flight, or the editor is read-only. Resolves without touching the engine. |
| `revert()` | `Promise<void>` | The snapshot stack is empty. Resolves without touching the engine. |
| `refresh()` | `Promise<void>` | Never a no-op: it re-reads and re-renders the current document after an external change. **Rejects** if the engine fails, after firing `onError` and showing the alert. |
| `openCompose()` | `void` | Never; it opens the new-document compose dialog. |

Host callbacks are non-reactive: passing a fresh inline arrow on every
render is fine and does not re-trigger a document load. The component holds
the latest identity behind a ref, so you do not need `useCallback` and you
never receive a stale closure.

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
