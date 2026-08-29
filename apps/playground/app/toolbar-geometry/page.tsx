"use client";

/**
 * G-03-1 toolbar-geometry harness. Reaches the one state the `/editor` route
 * can never reach: read-only with a long engine reason at `locale="ko"`.
 *
 * A stub engine rather than the HTTP one because the real engine always
 * reports `editable: true`, so the read-only notice never renders; the stub
 * also means this route needs neither the hwp binary nor `pnpm seed`.
 *
 * `/editor` is deliberately NOT reused: it mounts `<HwpEditor>` with no
 * `locale` prop on purpose, which makes `editor.spec.ts` the repository's only
 * end-to-end proof that the shipped default locale is English.
 */

import { useMemo, useState } from "react";
import type {
  CatEnvelope,
  DocumentHandle,
  HwpEngine,
  PageImage,
} from "@hwp-editor/core";
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css";
import { LONG_REASON, SHORT_REASON } from "./reasons";

const FILE: DocumentHandle = {
  name: "toolbar-geometry-stub.hwpx",
  data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
};

const MARKDOWN = "툴바 지오메트리 확인용 문단입니다.\n";

const ENVELOPE: CatEnvelope = {
  markdown: MARKDOWN,
  segments: [
    { start: 0, end: MARKDOWN.length, kind: "para", section: 0, para: 0 },
  ],
};

const PAGES: PageImage[] = [
  {
    page: 1,
    width: 595,
    height: 842,
    dpi: 96,
    format: "svg",
    data: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842">' +
        '<rect width="595" height="842" fill="#ffffff"/></svg>',
    ),
  },
];

/** Read-only engine whose only variable is the refusal prose it reports. */
function makeStubEngine(reason: string): HwpEngine {
  return {
    capabilities: () =>
      Promise.resolve({
        version: "0.0.0-stub",
        editable: false,
        reason,
        formats: ["hwpx"],
      }),
    read: () => Promise.resolve(ENVELOPE),
    render: () => Promise.resolve(PAGES),
    // Resolves so `.hwped-badge` renders — the badge is one of the controls
    // that collapses.
    validate: () => Promise.resolve({ valid: true, errors: [] }),
    edit: () => Promise.reject(new Error("stub engine: edit unsupported")),
    compose: () => Promise.reject(new Error("stub engine: compose unsupported")),
  };
}

export default function ToolbarGeometryPage() {
  const [long, setLong] = useState(false);
  const reason = long ? LONG_REASON : SHORT_REASON;
  // A NEW engine identity per reason: HwpEditor calls capabilities() only from
  // the load effect, which is keyed on [engine, file, store].
  const engine = useMemo(() => makeStubEngine(reason), [reason]);

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>
          hwp-editor playground — toolbar geometry
        </h1>
        <label>
          long reason:{" "}
          <input
            type="checkbox"
            aria-label="long-reason"
            checked={long}
            onChange={(e) => setLong(e.target.checked)}
          />
        </label>
      </header>
      <div style={{ flex: 1, minHeight: 0, marginTop: 12 }}>
        <HwpEditor engine={engine} file={FILE} locale="ko" />
      </div>
    </main>
  );
}
