# Edit refusal reports

Section 1 of issue #119 moves edit classification to the refusal codes shipped
in agent-hwp 1.6.3. The source contract is the released 2.0.0
[edit-report-v1 schema](https://github.com/STAIxBWLB/agent-hwp/blob/v2.0.0/schemas/edit-report-v1.schema.json).
The minimum supported engine remains 0.20.0.

## Mapping

| Engine refusal code | Editor kind or insertion class |
| --- | --- |
| `range_tag_shift` | `range_tag` |
| `keep_together_unsupported` | `keep_together_unsupported` |
| `section_owner_insert`, `section_owner_move` | `section_owner` |
| `add_table.anchor_not_found` | `anchor_not_found` |
| `insert_blocks.unknown_style` | insertion `unknown_style`, with the typed style value |
| `insert_blocks.invalid_definition`, `insert_blocks.style_not_paragraph`, `insert_blocks.duplicate_style`, `insert_blocks.style_cycle`, `insert_blocks.style_id_overflow`, `insert_blocks.invalid_spec` | insertion `invalid_definition`; the stable cause code remains in the report |
| `layout_overflow` | insertion `layout_overflow`; widths come only from numeric report values |
| `preservation_loss` with a `font_type_info_unrepresentable` event | `font_type_info` |
| Other `preservation_loss` events | `preservation_loss` |
| `unapplied_requests` | `unmatched_replace` only when the complete failed outcome list consists of replacements; otherwise `unapplied_requests` |
| `no_applicable_edits` | `no_applicable_edits` |
| `unclassified` | `unclassified_refusal` |

The code enum contains no dedicated run-conflict or address-resolution code.
Real 2.0.0 measurements return `unclassified` for those cases. Their old,
more specific remedies cannot be inferred from that code or from its prose.

The parser validates both top-level and per-op refusal objects with schema
major 1 matching. It validates code-specific values, including the two
`invalid_definition` shapes, numeric widths, structured issue paths and
preservation events. User anchors, styles and issue messages are report data;
none selects the cause class. The same mapping drives Apply and immediate
insertion, with cause and next-step messages in English and Korean.

## Transport boundary

The CLI adapter automatically requests `--report` on engines >= 1.6.3 and reads
it before failed-run cleanup. Successful response reports remain opt-in.
The route's optional `error.report` and `error.engineVersion` fields carry the
failed report to the HTTP client; a structured Tauri rejection accepts the
same additive fields. The report is validated again on receipt. Output names
are replaced with the caller's name, and staged paths in report diagnostics
are removed before the report is exposed as an error cause. Typed user anchors,
style names and structured issue-path segments retain their exact values; they
are identifiers rather than diagnostic filesystem paths.

A report overrides conflicting legacy semantic fields. An absent or malformed
modern report leaves a generic diagnostic; it never enables a stderr fallback.
Only a known engine version below 1.6.3 authorizes the legacy fixed-head/tail
classifiers and their old layout-overflow issue-list reader. A host without a
version/report can still fail normally, but supplies no verified semantic kind.

Current Maru source does not yet return edit reports from failed IPC calls.
The client supports structured report-bearing hosts and handles current hosts
without report-based classification. This is adapter-contract coverage, not
proof that the installed native host forwards reports; that requires separate
host integration. No Maru or agent-hwp source changes are included here.

## Protection measurements

The 17-code schema has no open-time protection code. Real released 2.0.0
runs with controlled HWP5 FileHeader protection flags write reports with
`code: unclassified` and empty values. Encrypted, DRM, certificate encryption,
certificate DRM and signature gates are covered. These are controlled gate
fixtures, not a genuinely encrypted-document corpus or proof of decryption.

The open-time backstop in `packages/core/src/errors.ts` therefore remains
unchanged and takes precedence over generic report mapping. Issue #119's
protection-text residuals 1.1-1.3 remain open. Ordinary password-required input
also reports `unclassified`; that is a separate password prompt, not a new
certificate/DRM/signature backstop case.

## Evidence and review background

The fixtures in `packages/core/test/fixtures/refusal-reports-v1.1/` contain 27
exact released-binary reports covering all 17 codes, plus their stderr, request
ops, portable manifest and recorder. The README records input provenance and
limitations. The recorder was replayed against the checksum-verified release;
all report and stderr bytes matched, and every report passed the release schema.

The REVIEW.md classifier focus changed on 2026-11-14 because the modern
machine-code contract eliminates the need to infer classes and widths from
user-valued diagnostic strings. The old reader remains only behind the explicit
legacy version gate, and protection remains separate because its code is absent.
