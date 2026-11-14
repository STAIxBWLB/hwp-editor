# Edit refusal reports

Section 1 of issue #119 moves edit classification to the refusal codes shipped
in agent-hwp 1.6.3. The source contract is the released 2.0.0
[edit-report-v1 schema](https://github.com/STAIxBWLB/agent-hwp/blob/v2.0.0/schemas/edit-report-v1.schema.json).
The minimum supported engine remains 0.20.0. Minor-schema support also follows
[agent-hwp at 7cff4c0f](https://github.com/STAIxBWLB/agent-hwp/blob/7cff4c0f19668fb1b8b1d2f675f3d36993777e2a/schemas/edit-report-v1.schema.json):
1.2 adds `document_protected` and 1.3 adds `verify_mismatch`. These extensions
are tested with synthetic schema-driven JSON fixtures; real-binary validation
waits for an agent-hwp release containing them. Do not use a source build as
release evidence.

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
| `document_protected` (1.2) | `protected` for certificate encryption, certificate DRM, DRM and signature, with the existing reason and `PROTECTED_NEXT_STEP`; `password` remains `failed` with a password-specific remedy |
| `verify_mismatch` (1.3) | `output_validation`; display validated invariant names only, or canonical digest mismatch when counts is empty, plus a retry step |
| `unclassified`, unknown nonempty codes in 1.x | `unclassified_refusal`; unknown values are projected to `{}` and their diagnostic message is retained as report data |

The code enum contains no dedicated run-conflict or address-resolution code.
Real 2.0.0 measurements return `unclassified` for those cases. Their old,
more specific remedies cannot be inferred from that code or from its prose.

The parser validates both top-level and per-op refusal objects with schema
major 1 matching. Unknown codes do not invalidate a supported-major report;
missing/invalid code, values, message, or any other consumed field still fails
closed. Known-code values retain their typed validation. It validates code-specific values, including the two
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

A valid structured `report.refusal` overrides conflicting legacy semantic
fields, including when its code is `unclassified`. A present malformed report
fails closed. If there is no structured refusal, existing host/server fields
or the existing fixed-head/tail stderr classifiers decide, then generic
diagnostics apply. This fallback is independent of engine version: asking for
a report on >=1.6.3 does not prove that the host forwarded one. The old
layout-overflow issue-list reader remains only on this no-report compatibility
path; structured numeric values take precedence whenever supplied.

For `hwped_edit`, the client sends `structuredRefusal: true` when
`refusalCodesSupported(caps.version)` holds (agent-hwp >= 1.6.3). This flag
means "can handle an object rejection with report"; it does not request a
report. The independent `report` flag controls report generation. In particular,
asking for a successful report on an older engine does not enable object errors.
A supporting host forwards the sanitized `{ code, message, report, engineVersion }`
rejection only with `structuredRefusal: true`; otherwise it keeps the prefixed
string error. Hosts that do not support object rejection may still return strings
to an opted-in client, which retains the string classifier. The existing object
branch validates the report and classifies its refusal code, never diagnostic prose.
Fake-host tests cover the opt-in handshake and both rejection shapes; installed
native-runtime forwarding remains unverified. No host source changes are included.

## Protection measurements

The released 2.0.0 schema 1.1 has no open-time protection code. Real released 2.0.0
runs with controlled HWP5 FileHeader protection flags write reports with
`code: unclassified` and empty values. Encrypted, DRM, certificate encryption,
certificate DRM and signature gates are covered. These are controlled gate
fixtures, not a genuinely encrypted-document corpus or proof of decryption.

The typed 1.2/1.3 outcomes are mapped by `reportRefusalFields` on server, HTTP
and Tauri boundaries before protection diagnostics. A password is a credential
requirement, never an instruction to remove certificate/DRM/signature protection.
The existing diagnostic backstop in `packages/core/src/errors.ts` is retained
for no-report hosts and schema 1.1 hosts, where protection codes were absent.
It does not override a valid newer structured refusal or rescue a malformed report.

`verify_mismatch.values.counts` consumes only the enumerated invariant `name`
and nonnegative safe-integer `expected`/`actual` counts. Messages never interpolate
report prose, document text or numeric count values. The synthetic 1.2/1.3
fixtures are in `packages/core/test/fixtures/refusal-reports-v1.3/`, with their
pinned-contract provenance and native-release deferral recorded separately.

## Evidence and review background

The fixtures in `packages/core/test/fixtures/refusal-reports-v1.1/` contain 27
exact released-binary reports covering all 17 codes, plus their stderr, request
ops, portable manifest and recorder. The README records input provenance and
limitations. The recorder was replayed against the checksum-verified release;
all report and stderr bytes matched, and every report passed the release schema.

The REVIEW.md classifier focus changed on 2026-11-14 because the modern
machine-code contract eliminates the need to infer classes and widths from
user-valued diagnostic strings. The old reader remains only on the no-report
compatibility path, and protection remains separate because its code is absent.
