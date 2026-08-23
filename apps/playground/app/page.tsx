"use client";

/**
 * Phase 2 smoke-test harness: exercises the /api/hwp-editor/* routes and
 * dumps raw JSON. The real editor UI lands in Phase 3 — deliberately no
 * design work here.
 */

import { useCallback, useEffect, useState } from "react";

type Action = "read" | "validate" | "capabilities";

async function callApi(action: Action, file?: File): Promise<unknown> {
  if (action === "capabilities") {
    const res = await fetch("/api/hwp-editor/capabilities");
    return res.json();
  }
  if (file === undefined) throw new Error("choose a fixture or upload a file first");
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/hwp-editor/${action}`, { method: "POST", body: form });
  return res.json();
}

export default function Home() {
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [upload, setUpload] = useState<File | null>(null);
  const [output, setOutput] = useState<string>("(no call yet)");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/fixtures/manifest.json")
      .then((res) => (res.ok ? res.json() : { fixtures: [] }))
      .then((body: { fixtures?: string[] }) => {
        const list = body.fixtures ?? [];
        setFixtures(list);
        setSelected(list[0] ?? "");
      })
      .catch(() => setFixtures([]));
  }, []);

  const run = useCallback(
    async (action: Action) => {
      setBusy(true);
      try {
        let file = upload ?? undefined;
        if (file === undefined && selected !== "") {
          const blob = await fetch(`/fixtures/${selected}`).then((res) => {
            if (!res.ok) throw new Error(`fixture fetch failed: ${res.status}`);
            return res.blob();
          });
          file = new File([blob], selected);
        }
        const result = await callApi(action, file);
        setOutput(JSON.stringify(result, null, 2));
      } catch (error) {
        setOutput(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [upload, selected],
  );

  return (
    <main>
      <h1>hwp-editor playground</h1>
      <p>
        Thin smoke-test harness over <code>/api/hwp-editor/*</code>. Seed fixtures with{" "}
        <code>pnpm seed</code>.
      </p>

      <section style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          fixture:{" "}
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {fixtures.length === 0 && <option value="">(none — run pnpm seed)</option>}
            {fixtures.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          or upload:{" "}
          <input
            type="file"
            accept=".hwp,.hwpx"
            onChange={(e) => setUpload(e.target.files?.[0] ?? null)}
          />
        </label>
        <button disabled={busy} onClick={() => void run("read")}>
          POST /read
        </button>
        <button disabled={busy} onClick={() => void run("validate")}>
          POST /validate
        </button>
        <button disabled={busy} onClick={() => void run("capabilities")}>
          GET /capabilities
        </button>
      </section>

      <pre
        style={{
          marginTop: 16,
          padding: 12,
          border: "1px solid #ccc",
          maxHeight: "70vh",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {output}
      </pre>
    </main>
  );
}
