# omo-plutus UI — Design System

## 0. Research Log (greenfield)

- Embedded refs: shortlisted `vercel.md` (black/white precision, Geist), `warp.md` (terminal-native dark IDE), `sentry.md` (data-dense dashboard) → picked **vercel.md** as Layer B + **taste-skill.md** as Layer A, because the product is a developer configuration tool (terminal-native, data-dense, operational) and vercel's restraint + mono accents fit a command-center surface without decorative noise. Sentry's density patterns informed the tables; warp's block-command framing informed the Run surface.
- Lazyweb: skipped — the four verified prior-art dashboards (oh-my-opencode-dashboard, opencode-token-dashboard, phrouros, opencode-usage) were already source-verified in this session and provide the functional layout grammar (sidebar nav, per-agent tables, run panels).
- Imagen drafts: skipped — no imagegen tool available in this environment.
- Skipped lanes: lazyweb (covered by prior-art source review above), imagen (no tool).

## 1. Atmosphere & Identity

A quiet command center for model allocation. Dense when operating, calm when watching.
The signature is **muted depth on near-black**: surfaces separate by tonal shift, not borders
or shadow — the only color that glows is the accent that marks "this is what Plutus decided."
Every run is a transaction you can audit: the surface reads like a flight deck where each
panel (assignments, token history, chains) is an instrument. The one memorable moment is the
**solve diff** — the before/after assignment table where changed slots lift out of the flat
surface with a single accent column.

## 2. Color

### Palette

| Role | Token | Value (dark) | Usage |
|------|-------|-------------|-------|
| Surface/base | `--surface-base` | `#0A0A0B` | App background |
| Surface/panel | `--surface-panel` | `#111113` | Cards, panels, sidebar |
| Surface/raised | `--surface-raised` | `#18181B` | Hover, active panel, modals |
| Surface/sunken | `--surface-sunken` | `#080809` | Inputs, code blocks, report |
| Text/primary | `--text-primary` | `#FAFAFA` | Headlines, body |
| Text/secondary | `--text-secondary` | `#A1A1AA` | Captions, hints |
| Text/tertiary | `--text-tertiary` | `#52525B` | Disabled, metadata |
| Border/default | `--border-default` | `#26262B` | Panel dividers |
| Border/subtle | `--border-subtle` | `#1B1B1F` | Soft separations |
| Accent/primary | `--accent-primary` | `#7C6CF0` | Solve results, active nav, CTAs |
| Accent/hover | `--accent-hover` | `#9789F5` | Hover on accent |
| Accent/glow | `--accent-glow` | `rgba(124,108,240,0.18)` | Focus ring, selected row wash |
| Status/success | `--status-success` | `#34D399` | Valid, schema pass |
| Status/warning | `--status-warning` | `#FBBF24` | Overflow, untrusted |
| Status/error | `--status-error` | `#F87171` | Validation fail, exit 2/3 |
| Status/info | `--status-info` | `#60A5FA` | Doctor, notes |
| Mono/accent | `--mono-accent` | `#A78BFA` | Inline code, model ids |

### Rules
- Accent is reserved for Plutus's *decisions* (assignments, pins, solve state) — never decorative.
- Status colors carry the trust taxonomy: success=trusted, warning=overflow/untrusted, error=invalid.
- Never introduce a raw hex outside this table; extend the table first.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Display | 32px / 2rem | 650 | 1.15 | -0.02em | Page titles |
| H1 | 22px / 1.375rem | 600 | 1.3 | -0.01em | Section headers |
| H2 | 17px / 1.0625rem | 600 | 1.4 | 0 | Panel titles |
| Body | 14px / 0.875rem | 400 | 1.55 | 0 | Default text |
| Body/sm | 13px / 0.8125rem | 400 | 1.5 | 0 | Secondary info |
| Caption | 12px / 0.75rem | 500 | 1.4 | 0.01em | Labels, metadata |
| Overline | 11px / 0.6875rem | 600 | 1.3 | 0.08em | Section labels, uppercase |
| Mono | 13px / 0.8125rem | 400 | 1.5 | 0 | Code, model ids, paths |
| Mono/sm | 12px / 0.75rem | 400 | 1.5 | 0 | Table data, timestamps |

### Font Stack
- Primary: **Geist, Inter, system-ui, -apple-system, sans-serif** (vercel lineage — crisp, neutral)
- Mono: **Geist Mono, JetBrains Mono, ui-monospace, SFMono-Regular, monospace**

### Rules
- Body never below 13px; tables may use 12px mono.
- Model ids, provider names, paths, exit codes ALWAYS in mono.
- No font-weight below 400 anywhere.

## 4. Spacing & Layout

### Base Unit: 4px

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Icon-to-label |
| `--space-2` | 8px | List items, inline groups |
| `--space-3` | 12px | Form field padding |
| `--space-4` | 16px | Card padding (default) |
| `--space-6` | 24px | Panel padding, section gap |
| `--space-8` | 32px | Between panel groups |
| `--space-12` | 48px | Major section breaks |

### Grid
- App shell: fixed sidebar (240px) + scroll-owning main column.
- Max content width: 1440px; columns: 12-grid, 16px gutter.
- Breakpoints: sm 640, md 768, lg 1024, xl 1280.

### Rules
- The sidebar is the only fixed element; every panel scrolls inside its own shell (`min-block-size: 0` on scroll children).
- Tables use `minmax(min(16rem,100%),1fr)` grid tracks where density matters.

## 5. Components

### AppShell
- **Structure**: `sidebar (nav) | main (scroll owner)`
- **Variants**: collapsed (mobile: overlay + backdrop)
- **States**: nav item default / active (accent bar) / hover (raised)
- **Accessibility**: skip-to-content link; nav is `<nav aria-label>`; active item `aria-current="page"`
- **Motion**: nav indicator slides 150ms ease-out; sidebar overlay fades 200ms

### Panel
- **Structure**: `header (overline + title + actions) | body`
- **Spacing**: `--space-6` padding; header separated by `--border-subtle`
- **States**: default; loading (skeleton rows, 900ms shimmer via opacity pulse); empty (centered caption); error (status-error text + retry)
- **Motion**: 200ms ease-in-out on enter

### DataTable
- **Structure**: `thead (mono/sm caption) | tbody (mono rows)`
- **States**: row hover (raised); selected row (accent-glow wash); sorting indicator on header
- **Accessibility**: real `<table>` semantics; sortable headers are buttons with aria-sort
- **Empty state**: "No data" caption with status-info tint

### RunButton (primary action — Solve / Optimize / Discover / Restore)
- **Variants**: primary (accent), ghost (panel), danger (restore — status-error)
- **States**: default / hover (accent-hover) / active (translateY(1px)) / disabled (tertiary, no pointer) / running (spinner + label "Solving…", disabled)
- **Accessibility**: focus ring = `--accent-glow` 2px ring; full keyboard
- **Motion**: press = 100ms ease-out translateY; running spinner = GPU rotate, 800ms linear infinite

### Badge
- **Variants**: success (trusted), warning (untrusted/overflow), error (invalid), info (doctor), accent (pinned)
- **Structure**: `caption mono/sm`, 4px radius pill, tonal background (10% color on surface-panel)
- **States**: static (no hover)

### StatusDot
- 6px circle, status color; pulse animation only when a run is active (meaning: "working"), else static
- Reduced motion: static always

### CodeBlock
- **Structure**: `pre` in `--surface-sunken`, mono 13px, scrolls horizontally
- Used for: report markdown, config JSON, inventory YAML, raw quota output

### Toggle (merge / mode switches)
- 32×18px track + 14px knob; checked = accent; focus ring = accent-glow
- Motion: knob 120ms ease-out (GPU transform only)

### Toast
- **Variants**: success / error / info; fixed bottom-right, 320px
- **Motion**: enter translateY(8px)→0 + fade 200ms; auto-dismiss success 4s; error persists until closed
- **Accessibility**: `role="status"` (success/info) / `role="alert"` (error)

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 100–150ms | ease-out | Button press, toggle, nav indicator |
| Standard | 200–300ms | ease-in-out | Panel enter, toast, sidebar overlay |
| Emphasis | 400–600ms | cubic-bezier(0.16,1,0.3,1) | First paint of solve results |
| Running pulse | 800ms | linear infinite | StatusDot while a run is active |

### Rules
- Only animate `transform` + `opacity`. Never layout properties.
- Every interactive element has hover + active + focus.
- **Slop ban**: no hover that changes nothing; no motion on non-interactive elements; the only persistent animation is the running StatusDot (it communicates state).
- Reduced motion: `@media (prefers-reduced-motion: reduce)` disables all non-essential animation — spinner becomes a static "Running…" label, pulses stop, toasts fade instantly.

## 7. Depth & Surface

### Strategy: **tonal-shift** (no borders-as-crutches, minimal shadows)

- `--surface-base` → `--surface-panel` → `--surface-raised` ladder creates depth without box-shadows.
- Panels are separated by `--border-subtle` top edge only where tonal shift is insufficient (stacked tables).
- Focus rings and selected rows use `--accent-glow` (soft wash), never a border color.
- Modals/popovers step one rung to `--surface-raised` and carry a single 0 8px 24px rgba(0,0,0,0.4) shadow to lift above the panel ladder.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA; contrast floor 4.5:1 body / 3:1 large text (accent `#7C6CF0` on `#111113` = 4.6:1 ✓).
- Visible focus on every interactive element (`--accent-glow` 2px ring + 2px offset).
- Full keyboard reachability: all buttons, nav, table sort, toggles, tabs.
- `prefers-reduced-motion` respected globally.
- Tables use real `<table>`; icons are decorative with `aria-hidden` + text labels where needed.
- No emojis anywhere — SVG icons only (inline or Lucide).

### Accepted Debt
| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| No dark/light theme toggle | App-wide | v1 ships dark-only (developer tool, matches terminal); light theme adds token surface + QA cost | v2 — revisit with theme-aware tokens |
| Charts (token history) are tables, not graphs | Token History view | v1 prioritizes auditability over visualization; table is exact, graphs are v2 | v2 — add SVG sparkline with existing tokens |
