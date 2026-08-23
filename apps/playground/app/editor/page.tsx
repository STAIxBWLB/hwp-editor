"use client";

/**
 * Phase 5 e2e surface: the real @hwp-editor/react UI over the HTTP engine
 * (/api/hwp-editor/* routes → real hwp binary). Same fixture picker as the
 * API harness on the index page; selecting a fixture loads it into the
 * editor immediately.
 */

import { useEffect, useState } from "react";
import { createHttpEngine } from "@hwp-editor/core";
import type { DocumentHandle } from "@hwp-editor/core";
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css";

const engine = createHttpEngine("/api/hwp-editor");

export default function EditorPage() {
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [file, setFile] = useState<DocumentHandle | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/fixtures/manifest.json")
      .then((res) => (res.ok ? res.json() : { fixtures: [] }))
      .then((body: { fixtures?: string[] }) => {
        const list = body.fixtures ?? [];
        setFixtures(list);
        setSelected((current) => (current === "" ? (list[0] ?? "") : current));
      })
      .catch(() => setFixtures([]));
  }, []);

  useEffect(() => {
    if (selected === "") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/fixtures/${selected}`);
        if (!res.ok) throw new Error(`fixture fetch failed: ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        if (!cancelled) {
          setFile({ name: selected, data });
          setFetchError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setFetchError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>hwp-editor playground — editor</h1>
        <label>
          fixture:{" "}
          <select
            aria-label="fixture"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {fixtures.length === 0 && <option value="">(none — run pnpm seed)</option>}
            {fixtures.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {fetchError !== null && <span role="alert">fixture 로드 실패: {fetchError}</span>}
      </header>
      <div style={{ flex: 1, minHeight: 0, marginTop: 12 }}>
        <HwpEditor engine={engine} file={file} />
      </div>
    </main>
  );
}
