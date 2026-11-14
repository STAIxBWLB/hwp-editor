# Refused edit reports from ahwp 2.0.0

The 27 reports are exact released-binary output, covering all 17 refusal codes in the release's `edit-report-v1` schema. `manifest.json` records the asset checksum, schema source, each report's expected code, raw stderr and portable command arguments. The raw reports and stderr are never rewritten to fit a proposed mapping.

The inputs are controlled test documents created by the released binary. The range-tag cases add an opaque sentinel through JSON IR, following the engine's `range_tag_edits.rs` recipe; they are not Hancom-saved range-tag samples. Protection cases set FileHeader bits on an engine-authored HWP5 document, following `cli_surface.rs`; they demonstrate the actual open-time gates, not decryption of a genuinely encrypted corpus document.

To reproduce, use a checksum-verified `ahwp-v2.0.0-<target>` release asset and a Python environment with `olefile`:

```sh
python record.py --bin /path/to/released/ahwp --output-dir /path/to/scratch/captures
```

The recorder creates disposable inputs and replays the exact relative commands from the manifest. The `.ops.json` files hold request data as given to the engine. No source build or original document is modified.

Measurement results:

- A missing replace yields `unapplied_requests`; a mixed missing replace/field batch carries that same code, so inspect failed op kinds before choosing a replace-only remedy.
- With all requests unmatched and `--allow-partial`, the code is `no_applicable_edits` and the failed `replace` op remains in `ops`.
- `insert_blocks.invalid_definition` has both measured shapes: `issues` with `container_width_mm`, or `style` with `detail`. An injected-looking style name remains one structured issue-path segment.
- `layout_overflow` provides numeric `container_width_mm` and issue `measured_width_mm`; prose is unnecessary for the widths.
- `preservation_loss` carries event codes for font typeInfo and, separately, paragraph range tags. It must not imply a font cause for every preservation event.
- Run-range conflicts and missing addresses report `unclassified`. Their old text-specific remedies cannot be inferred from that code.
- Every measured protection refusal still writes a valid report, with `code: unclassified` and empty `values`. The schema has no protection code; a present report does not replace the protection backstop.
