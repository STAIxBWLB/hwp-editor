# @hwp-editor/core

The framework-free core of hwp-editor: the `HwpEngine` contract every document
operation flows through, the typed `hwp edit` op grammar, segment coordinate
math, generated spec types, and the editor state store. It has zero runtime
dependencies and deliberately contains no React, no Node-only APIs, and no HWP
parsing of its own: platform functions (`fetch`, `invoke`) are injected rather
than imported, so the same build runs in a browser, in Node, and in a Tauri
webview. The UI lives in [`@hwp-editor/react`](https://www.npmjs.com/package/@hwp-editor/react) and the binary-spawning
adapter in [`@hwp-editor/server`](https://www.npmjs.com/package/@hwp-editor/server).

## Install

```sh
pnpm add @hwp-editor/core
```

Most hosts do not install this directly: it arrives as a peer of
`@hwp-editor/react` and `@hwp-editor/server`, deduped to a single copy. Add it
explicitly only when your own source imports from it — `createHttpEngine` and
the `DocumentHandle` type being the usual reasons — because a strict
`node_modules` layout does not expose an automatically installed peer to the
application.

## Usage

```ts
import { createHttpEngine, opsToArgv, createStore } from "@hwp-editor/core";

const engine = createHttpEngine("/api/hwp-editor");
const { data } = await engine.read(document);
```

Pick a transport (`createHttpEngine` or `createTauriEngine`), or implement
`HwpEngine` yourself. Host code changes only the factory call; nothing else in
this package or in `@hwp-editor/react` knows which transport is in use.

## Reference

| Export | Type | Notes |
| ------ | ---- | ----- |
| `HwpEngine` | interface | The six-method document contract: `read`, `render`, `edit`, `compose`, `validate`, `capabilities`. Everything else here exists to build arguments for it or to interpret its results. |
| `HwpEngineError`, `HwpErrorCode` | class + union | The error every transport throws, carrying a stable `code` a host can branch on. `isHwpEngineError` narrows an unknown catch value; `toHwpErrorCode` maps a wire code. |
| `EditOp`, `opsToArgv`, `argvToOps`, `OP_FLAGS` | union + functions | Type-safe mirror of every `hwp edit` flag, pinned to the hwp-cli contract. `opsToArgv` serializes an op list to argv; `argvToOps` parses it back, so a queue survives a round trip. |
| `parseCatEnvelope`, `offsetToRef`, `segmentAtRef`, `segmentText` | functions | Pure helpers over the `hwp cat --with-segments` envelope. They bridge rendered markdown offsets and the stable `{section, para}` source coordinates `EditOp` targets. |
| `DocumentSpecV2`, `TemplateSpecV1`, `TemplateDataV1` | types | Generated from the frozen JSON schemas in `schemas/`. These are the compose inputs; regenerate with `pnpm gen:types` after a schema change. |
| `createStore`, `reducer`, `initialState` | functions + value | Framework-free reducer store holding the document, pending ops, undo snapshots and status. React hosts bind it with `useSyncExternalStore`; others wrap it in their own reactivity. |
| `createHttpEngine`, `createTauriEngine` | factories | The two shipped transports. Both return an `HwpEngine` and both send the same JSON, so they are interchangeable. |

## Develop

```sh
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
```
