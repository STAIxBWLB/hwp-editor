# ahwp 2.0.0 compatibility verification

Issue #171 keeps the 0.20.0 floor, the 1.x `hwp` fallback and supported-major
schema matching. CI's e2e and font-less-render jobs now install the released
`ahwp-v2.0.0-x86_64-unknown-linux-gnu` asset, not a source build.

## Capture provenance

The local captures used the [v2.0.0 release](https://github.com/STAIxBWLB/agent-hwp/releases/tag/v2.0.0)
asset `ahwp-v2.0.0-aarch64-apple-darwin.tar.gz`, verified against its `.sha256`
sidecar before extraction. SHA-256:
`6ce7d60f2816d49078ea6269023bf53ed9150d02ebd5518801c65006fd7b92fc`.
The extracted executable reported `ahwp 2.0.0`.

To reproduce, download that archive and sidecar with `gh release download`, run
`shasum -a 256 -c ahwp-v2.0.0-aarch64-apple-darwin.sha256`, then extract only `ahwp`.
The recorder writes temporary documents and captures into the supplied scratch
directory; it never overwrites committed fixtures:

```sh
python3 scripts/record-ahwp2-fixtures.py /path/to/ahwp /path/to/scratch \
  /path/to/hwp-cli-plan-template.hwpx
```

The optional original is `src-tauri/testdata/hwp-cli-plan-template.hwpx` from
maru, SHA-256 `f1cbb613b48c6ebc3bf2a2f74e78a706042f5c96b89100cd24c051e776b7f6e2`.
The recorder documents the exact three addressed replacements for its literal
variant. Rendering reported two substituted fonts on this host; the geometry
comparison below is a regression check against the stored layouts, not a claim
of font parity.

## Fixture changes and re-measurement

| Fixture | Result and reason |
| --- | --- |
| `core/test/fixtures/cat-segments-controls.json` | New real 1.2 capture. A stored HWPX `<hp:tab/>` projects to a space with `{kind: "tab", at: 1, source: 1}`. The tab occupies eight source units. Wire projection, decoded validation and selection preserve it. |
| `core/test/fixtures/cat-segments-ranges-2.0-hwpx.json` | New measured ranges: plain text, trimmed leading space, whitespace around bold text, whitespace-only emphasis, escapes, and the upstream #557 minimal overlap example. |
| `core/test/fixtures/cat-segments-ranges-2.0-hwp.json` | Same cases in native HWP5, retaining the stored paragraph break's extra source unit. |
| `react/test/fixtures/plan-template/cat-v2.json` | Only `schema_version` changes from 1.1 to 1.2; Markdown and all segments match the fresh capture. |
| `react/test/fixtures/plan-template/literal-v2.json` | Only `schema_version` changes from 1.1 to 1.2; document IR, Markdown and all segments match. Captured with `--format json`, as before. |
| `react/test/fixtures/plan-template/{cat-v1,literal-v1,all-layout,literal-layout}.json` | Unchanged. All four fresh captures match the stored JSON values exactly. |
| `core/test/fixtures/cat-segments-runs.json` | Unchanged on purpose: retains schema 1.1 compatibility coverage. Recomposition on 2.0.0 gives identical Markdown and segments, with schema 1.2. |
| `core/test/fixtures/font-type-info-stderr.txt` | New raw 2.0.0 font refusal capture, shared by core and server tests. |
| `core/test/fixtures/refusal-stderr.ts` | Loads the raw font refusal capture; the comment records its generation. |
| `core/test/fixtures/edit-report-font-type-info-refusal.json` | New exact 1.1 refusal report captured on the failed edit, proving that the structured preservation code and font event are already emitted. |

Paths in the table are under `packages/`.

The old and new release binaries were also run on the same generated range
and control documents. The v1.6.2 macOS archive was verified against its sidecar;
its executable reported `ahwp 1.6.2`. Markdown stays identical in these cases.
The control fixture gains only the optional controls array. The existing
plain-text, trimmed-space, emphasis and escape cases keep their ranges.

The upstream #557 example is three runs: bold 12pt space, bold 10pt space,
then plain `x`. In both formats, 1.6.2 publishes the trimmed first space and
`x` under the same Markdown range `[48, 49)`. Version 2.0.0 drops the trimmed
space's phantom piece and keeps only run `[7, 2]`, whose source begins at 2.
The new tests confirm formatting selects only that visible owner. Existing
1.6.x synthetic selection expectations remain unchanged.

## Refusal boundary

The release's font refusal without `--verify` begins with
`Error: 출력 검증 실패 (대상: <output path>)`. Its font-specific event code occurs
only below `Caused by:`. The structured edit report written on this refused run
has schema 1.1 and
contract `hwp-edit-report-v1`. Its `refusal.code` is `preservation_loss`, with
`refusal.values.events[0].code` equal to `font_type_info_unrepresentable`
(`count: 1`, `disposition: "unrepresentable"`, `resource: "metadata"`).
Under the #171 AC4 ruling, the interim editor classified only the first `Error:` line's
fixed head `Error: 출력 검증 실패 (대상: ` and fixed tail `)`. The output path
between them stays opaque; no `Caused by` or preservation-event list is read.
This is the broader `output_validation` class, not a font-specific diagnosis.

AC4 is met under that ruling: both locales say the engine's output preservation
check refused to write the file, name unmapped HWPX font metadata as one known
cause, and give the two remedies below. For another cause they direct the user
to run the same edit with the engine's `--verify` report to see which check
failed. Apply and immediate insertion use that same localized message.

That interim class is now limited to legacy engines. Section 1 of #119 adds
failed-report code consumption for modern transports and a font-specific
classification; see [Edit refusal reports](edit-refusal-reports.md). The codes
already shipped in 1.6.3, as the measured 2.0.0 report above confirms.

The same measured font input successfully edits to `.hwpx`. Explicit
`ahwp convert` without `--strict` reports `font_type_info_unrepresentable` as
a preservation warning, writes `.hwp`, and a subsequent edit of that converted
file succeeds. Neither successful edit's report has a refusal. These checks
used temporary documents only.
