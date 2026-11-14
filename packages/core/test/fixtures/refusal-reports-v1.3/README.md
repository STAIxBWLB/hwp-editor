# Synthetic edit-report 1.2 and 1.3 fixtures

These files are synthetic, schema-driven unit data. They were not captured from a released or source-built native binary and make no claim of native behavior. The shapes follow `schemas/edit-report-v1.schema.json` at pinned `agent-hwp` commit `7cff4c0f19668fb1b8b1d2f675f3d36993777e2a`.

The reports use empty operation lists and zero counts to isolate top-level refusal parsing. Their public messages and output names are fixed synthetic strings. Protection fixtures cover all five `document_protected` values. The two verification fixtures cover count invariants and an empty count list (canonical digest mismatch only).

Real-binary validation is deferred until `agent-hwp` publishes a release containing edit-report 1.2 and 1.3. Do not build the source revision to create captures.
