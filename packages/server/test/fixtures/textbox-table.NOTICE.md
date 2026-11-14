# textbox-table.hwpx

Derived from `fixtures/samples/report-tables.hwpx` in agent-hwp v2.0.0
(tag commit 8319e8caea6a9c9beeef969c306845a2f6feae35, sha256
b304a203d977e3d32a33b2fea5ce7c5b01d0af74916fb30c60d96f355034de24),
licensed MIT OR Apache-2.0 (see agent-hwp's LICENSE-MIT and LICENSE-APACHE,
Copyright (c) 2026 hwp-cli contributors).

The source already holds a genuine text box (`hp:drawText` under the control of
top-level paragraph 50) whose content holds a table: published path
`[50, 0, 1, 0]`, nine body tables before it. One table was added after the box
with the released ahwp 2.0.0:

```sh
ahwp edit report-tables.hwpx --ops after.json -o textbox-table.hwpx
```

`after.json`:

```json
[{"op":"insert_blocks","address":{"at":{"section":0,"paragraph":50}},"position":"after",
  "blocks":[{"type":"table","columns":[{"width_mm":40},{"width_mm":40}],
  "rows":[{"cells":[{"blocks":[{"type":"paragraph","runs":[{"type":"text","text":"after-box"}]}]},
  {"blocks":[{"type":"paragraph","runs":[{"type":"text","text":"x"}]}]}]}]}]}]
```

Result: `ahwp info --json --body-stats` reports `body.tables` 11, `ahwp validate`
reports valid. sha256 230b7c791e20ed7eb92423a55fdf28d2f23a8f88efb59ec1d88c36e0efacd56f.
