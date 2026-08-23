# Theme contract: `--hwped-*`

`@hwp-editor/react` is themeable only through CSS custom properties. Hosts
never override the editor's internal classes; they set these variables on the
editor root (`.hwped`) or any ancestor, and the editor's `var()` uses pick
them up — including dark-mode swaps done by an ancestor theme attribute.

## Variables

| Variable | Role | Default (light) | Default (dark) |
|---|---|---|---|
| `--hwped-bg` | surface background | `#ffffff` | `#17191d` |
| `--hwped-fg` | primary text | `#1a1d21` | `#e5e7eb` |
| `--hwped-muted` | secondary text / disabled | `#6b7280` | `#9ca3af` |
| `--hwped-accent` | primary actions, selection | `#1f5fbf` | `#5b8def` |
| `--hwped-border` | hairline borders | `#d7dbe0` | `#33373f` |
| `--hwped-radius` | corner radius | `6px` | `6px` |
| `--hwped-font` | font stack | Pretendard → system Korean stack | same |

Defaults ship in `packages/react/src/theme.css` with a
`prefers-color-scheme: dark` fallback, so an unmapped host still gets a sane
dark editor. A host that manages its own dark mode (class/attribute switch)
must map both themes itself — media-query fallbacks do not follow host state.

## Per-host mapping examples

### maru (hand-rolled tokens, no Tailwind)

maru's palette lives in `src/styles.css` (`--panel`, `--ink`, `--muted`,
`--accent`, `--line`, `--radius`; dark values under its theme selector), so
the mapping is pure aliasing and dark mode is automatic:

```css
.hwp-editor-host {
  --hwped-bg: var(--panel);
  --hwped-fg: var(--ink);
  --hwped-muted: var(--muted);
  --hwped-accent: var(--accent);
  --hwped-border: var(--line);
  --hwped-radius: var(--radius);
  --hwped-font: "Pretendard", "Malgun Gothic", "맑은 고딕", -apple-system,
    "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
}
```

Full recipe: [integration-maru.md](./integration-maru.md).

### Fluent UI (`@fluentui/react-components`)

Fluent tokens are JS values; bridge them with inline style or a small CSS
block generated from the active theme:

```tsx
import { tokens } from "@fluentui/react-components";

<div
  style={{
    "--hwped-bg": tokens.colorNeutralBackground1,
    "--hwped-fg": tokens.colorNeutralForeground1,
    "--hwped-muted": tokens.colorNeutralForeground3,
    "--hwped-accent": tokens.colorBrandBackground,
    "--hwped-border": tokens.colorNeutralStroke1,
    "--hwped-radius": tokens.borderRadiusMedium,
  } as CSSProperties}
>
  <HwpEditor ... />
</div>
```

### Radix Themes

```css
.hwp-editor-host {
  --hwped-bg: var(--color-background);
  --hwped-fg: var(--gray-12);
  --hwped-muted: var(--gray-11);
  --hwped-accent: var(--accent-9);
  --hwped-border: var(--gray-6);
  --hwped-radius: var(--radius-2);
}
```

Radix already rescopes its variables per theme, so one mapping covers light
and dark.

### Base UI / plain design tokens

Base UI is unstyled; map whatever custom properties the host defines:

```css
.hwp-editor-host {
  --hwped-bg: var(--surface);
  --hwped-fg: var(--text-primary);
  --hwped-muted: var(--text-secondary);
  --hwped-accent: var(--primary);
  --hwped-border: var(--divider);
  --hwped-radius: var(--radius-md);
}
```

### No tokens at all

Set the seven variables literally on the mount element. That is still the
supported path — the contract is the variable names, not any token system.
