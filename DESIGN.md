---
name: Tars
description: Flat, dense control room for running many AI coding-agent CLIs side by side. Electron desktop, dark by default.
default-theme: dark
colors:
  dark:
    bg: "#121212"
    surface: "#1A1A1A"
    surface-raised: "#222222"
    surface-elevated: "#262626"
    term-bg: "#0F0F0F"        # --term-bg; xterm never reads it
    border: "#2A2A2A"
    border-strong: "#3A3A3A"
    text-primary: "#F5F4F2"
    text-secondary: "#9B9B9B"
    text-muted: "#898989"
    accent: "#FF9E42"
    accent-dim: "#FF9E4216"
    accent-focus: "#FF9E4266"
    on-accent: "#1E1E1E"
    scrim: "#00000099"
    knob: "#121212"
    status-running: "#4CC38A"
    status-waiting: "#E8C547"
    status-error: "#E5534B"
    status-error-40: "#E5534B66"
    status-idle: "#898989"
  light:
    bg: "#FAF9F7"
    surface: "#FFFFFF"
    surface-raised: "#F3F1EE"
    surface-elevated: "#FFFFFF"
    term-bg: "#F3F1EE"        # --term-bg; xterm never reads it
    border: "#DAD6CE"
    border-strong: "#BFBAB1"
    text-primary: "#1E1E1E"
    text-secondary: "#4A4A4A"
    text-muted: "#6B6B6B"
    accent: "#C77012"
    accent-dim: "#C7701214"
    accent-focus: "#C7701266"
    on-accent: "#1E1E1E"
    scrim: "#1E1E1E66"
    knob: "#FFFFFF"
    status-running: "#1A7F37"
    status-waiting: "#9A6700"
    status-error: "#CF222E"
    status-error-40: "#CF222E66"
    status-idle: "#6B6B6B"
typography:
  families:
    ui: Roboto Condensed
    mono: Roboto Mono
    term-mono: JetBrains Mono, Menlo, Monaco, Courier New, monospace
    display: Instrument Serif
  scale: [9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 40, 44]
  roles:
    page-title:     { family: display, size: 24,   weight: 400, leading: 1.15 }
    page-subtitle:  { family: ui,      size: 12.5, weight: 400, leading: 1.4 }
    wordmark:       { family: display, size: 20 }
    splash-wordmark:{ family: display, size: 36 }
    body:           { family: ui,      size: 14,   weight: 400, leading: 1.5 }
    control:        { family: ui,      size: 12,   weight: 500 }
    label:          { family: ui,      size: 12,   weight: 500 }
    section-label:  { family: ui,      size: 10,   weight: 500, transform: uppercase }
    hint:           { family: ui,      size: 10 }
    terminal:       { family: term-mono, size: 13,  weight: 400 }
    value-mono:     { family: mono,    size: 12,   weight: 400 }
rounded:
  control: 2px
  dot: 999px
spacing:
  step: 8
  scale: [2, 4, 6, 8, 10, 12, 14, 16, 20, 24]
  gutters: [16, 24]
layout:
  sidebar-width: 240
  header-height: 84            # spec only - no page mounts ui/PageHeader
  header-padding: [0, 0, 14, 0]
  content-padding: [24, 24, 24, 24]
  pane-gap: 8
  control-height-small: 26
  control-height-standard: 32
components:
  button-primary:
    height: 32
    background: "{accent}"
    text: "{on-accent}"
    border: "1px solid {accent}"
  button-secondary:
    height: 32
    background: "{surface}"
    text: "{text-primary}"
    border: "1px solid {border}"
  button-ghost:
    height: 32
    background: transparent
    text: "{text-secondary}"
    border: 1px solid transparent
  button-danger:
    height: 32
    background: transparent
    text: "{status-error}"
    border: "1px solid {status-error} @ 40%"
  field:
    height: 32
    background: "{surface-raised}"
    border: "1px solid {border}"
    focus-border: "{accent} @ 40%"
    text: 12
  field-read-only:
    background: "{surface}"
    border: "1px solid {border}"
    focus-border: "{accent} @ 40%"
    text: "{text-secondary}"
    cursor: default
  nav-item-active:
    background: "{accent} @ 20%"
    text: "{accent}"
  tab-active:
    background: "{surface}"
    text: "{text-primary}"
  segmented-active:
    background: "{surface-raised}"
    border: "1px solid {border-strong}"
  toggle:
    track: 40x20
    knob: 14x14
    on-track: "{accent}"
    on-knob: "{on-accent}"
    off-track: "{surface-raised}"
    off-knob: "{text-secondary}"
  card:
    background: "{surface}"
    border: "1px solid {border}"
    rounded: 2px
    shadow: none
  terminal-pane:
    header: "{surface}"
    body: "{term-bg}"
    border: "1px solid {border}"
  status-dot:
    size: 6
    shape: square
  agent-mark:
    grid: 4x4, the left half drawn from the agent's name, the right half mirrored
    sizes: [16, 24]
    square: "3 at 16, 5 at 24, gaps of 1"
    lit: "{text-secondary}"
    lit-orchestrator: "{accent}"
    unlit: "{surface-raised}"
  brand-mark:
    size: 10
    shape: square
    color: "{accent}"
  modal:
    scrim: "{scrim}"
    panel: "{surface}"
    border: "1px solid {border}"
---

## Overview

Tars runs twenty agents at once. The screen is a wall of live terminals, agent
cards, cost figures and diffs, and the interface's whole job is to get out of
the way of that data. So: flat surfaces, no shadows, no gradients, a single 2px
radius, and colour reserved for things that mean something: an agent's state,
money, an accent on the one control you are meant to press.

Depth is done with value, not elevation. Four greys stack in dark
(`bg` → `surface` → `surface-raised` → `surface-elevated`, 18 → 26 → 34 → 38 in
sRGB) and a 1px `border` line separates anything the greys don't. A card is a
rectangle with a hairline around it. It never lifts off the page.

Three families, three jobs. **Instrument Serif** carries the page title and the
wordmark and nothing else: it is the only warm thing on the screen and it earns
its place by being rare. **Roboto Condensed** is the UI: it fits more label into
a 240px sidebar and a narrow table column than an unnarrowed grotesque, which is
the whole argument for it. **Roboto Mono** is for anything the machine wrote: branch
names, paths, model ids, versions, token counts. The terminal is the one exception:
xterm is handed `JetBrains Mono, Menlo, Monaco, Courier New, monospace` directly.

Dark is the launch default (`<html class="dark">` in `src/app/layout.tsx`, with
an inline script that reads `localStorage['tars-theme']` before first paint so a
cold start never flashes white). Light is a full peer, not a tint: every token
has a light value, and both are checked against the same contrast floor.

## Colors

The tokens live in `src/app/globals.css`: light on `:root`, dark on `.dark`,
re-exported to Tailwind through `@theme inline`.

| Token | Dark | Light | CSS variable(s) | Used for |
|---|---|---|---|---|
| `bg` | `#121212` | `#FAF9F7` | `--background`, `--bg-primary` | The page behind everything |
| `surface` | `#1A1A1A` | `#FFFFFF` | `--card`, `--popover`, `--bg-secondary` | Cards, sidebar, panels, menus |
| `surface-raised` | `#222222` | `#F3F1EE` | `--secondary`, `--muted`, `--bg-tertiary` (and `--input`, dark only, light `--input` is `#FFFFFF`) | Field fills, chips |
| `surface-elevated` | `#262626` | `#FFFFFF` | `--bg-elevated` | The one step above a card |
| `term-bg` | `#0F0F0F` | `#F3F1EE` | `--term-bg` | Nominally the terminal canvas: nothing reads it; xterm carries its own literals |
| `border` | `#2A2A2A` | `#DAD6CE` | `--border`, `--border-primary` | Every hairline |
| `border-strong` | `#3A3A3A` | `#BFBAB1` | `--border-accent` | Hover edges, scrollbar thumb |
| `text-primary` | `#F5F4F2` | `#1E1E1E` | `--foreground`, `--text-primary` | Titles, values, active labels |
| `text-secondary` | `#9B9B9B` | `#4A4A4A` | `--muted-foreground`, `--text-secondary` | Subtitles, inactive labels |
| `text-muted` | `#898989` | `#6B6B6B` | `--text-muted` | Meta, timestamps, hints |
| `accent` | `#FF9E42` | `#C77012` | `--primary`, `--accent`, `--ring`, `--info` | The mark, one CTA, focus ring |
| `accent-dim` | `#FF9E42` @ 8.6% | `#C77012` @ 7.8% | `bg-primary/…` | Active-item fill |
| `accent-focus` | `#FF9E42` @ 40% | `#C77012` @ 40% | `border-primary/40` | A field's border while it holds the focus |
| `on-accent` | `#1E1E1E` | `#1E1E1E` | `--primary-foreground` | Text on an accent fill |
| `status-running` | `#4CC38A` | `#1A7F37` | `--success` | Agent working |
| `status-waiting` | `#E8C547` | `#9A6700` | `--warning` | Agent asking |
| `status-error` | `#E5534B` | `#CF222E` | `--danger`, `--destructive` | Agent failed, destructive action |
| `status-error-40` | `#E5534B` @ 40% | `#CF222E` @ 40% | `border-danger/40` | The danger button's border |
| `status-idle` | `#898989` | `#6B6B6B` | `--color-status-idle` → `--text-muted` | Agent spawned, doing nothing, or stopped |

Two colours are deliberately not what the Pencil frames drew:

- **`text-muted` dark.** The frames use `#727272`. That is 3.62:1 on a card and
  3.31:1 on a field: under AA for the 10-12px it is always used at. The code
  lifts it to `#898989`, the darkest value that still clears 4.5:1 on `bg`, `surface`
  **and** `surface-raised` at once (5.36 / 4.98 / 4.55): on a dark ground anything
  lighter passes too, so this is the floor, not the ceiling.
- **`status-idle`.** The frames drew it at `#727272` dark and `#9B9B9B` light;
  the light one is 2.64:1 on `bg`. The token is bound to `text-muted` instead,
  which is the same visual read and passes in both themes.

### Contrast, measured

Every ratio below is computed from the shipped hex values, not copied from a
comment. AA (4.5:1) is the floor for all body and control text.

**Dark**: text on `bg` / `surface` / `surface-raised` / `term-bg`:

| Colour | `#121212` | `#1A1A1A` | `#222222` | `#0F0F0F` |
|---|---|---|---|---|
| `text-primary` | 17.04 | 15.83 | 14.47 | 17.44 |
| `text-secondary` | 6.74 | 6.26 | 5.72 | 6.90 |
| `text-muted` | 5.36 | 4.98 | 4.55 | 5.48 |
| `accent` | 9.12 | 8.47 | 7.74 | 9.33 |
| `status-running` | 8.46 | 7.86 | 7.18 | 8.65 |
| `status-waiting` | 11.16 | 10.37 | 9.48 | 11.42 |
| `status-error` | 5.06 | 4.70 | 4.30 | 5.18 |

**Light**: text on `bg` / `surface` / `surface-raised`:

| Colour | `#FAF9F7` | `#FFFFFF` | `#F3F1EE` |
|---|---|---|---|
| `text-primary` | 15.84 | 16.67 | 14.79 |
| `text-secondary` | 8.42 | 8.86 | 7.86 |
| `text-muted` | 5.06 | 5.33 | 4.73 |
| `accent` | 3.47 | 3.65 | 3.24 |
| `status-running` | 4.83 | 5.08 | 4.51 |
| `status-waiting` | 4.63 | 4.87 | 4.32 |
| `status-error` | 5.09 | 5.36 | 4.75 |

Fills, and the two numbers that decide the light theme:

- `on-accent` on `accent`: **8.11:1** dark, **4.57:1** light. White on `#C77012`
  is 3.65:1 and fails, which is why `--primary-foreground` is `#1E1E1E` in both
  themes. (The frames draw the dark button's label at `#121212`, 9.12:1; the code
  uses `#1E1E1E`. Either passes; the code value is canonical.)
- `text-primary` on an `accent-dim` fill: 13.53:1 dark (`#2E261E` over `surface`),
  15.28:1 light (`#FBF4EC` over `surface`). The active nav item is legible because
  of its text colour, not its fill.
- **Light `accent` never carries body text.** 3.47:1 on `bg` clears the 3:1 large-text
  threshold and nothing else. In light it is a fill, a border, and a 24px+ figure.
  A 12px orange label in light is a bug.
- `StatusBadge` puts its own colour at 10% behind itself, which costs roughly half
  a point: dark error lands at 4.22:1, light warning at 4.29:1, light info at 3.26:1.
  Badges are therefore always redundant: the same state is on the dot and in the
  row's text. Never put the only copy of a message inside one.

## Typography

The scale, in px: **9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 18,
20, 24, 28, 32, 36, 40, 44.** Nothing between the steps, nothing below 9.

| Size | Family | Where |
|---|---|---|
| 36 | display | Splash wordmark |
| 24 | display | Page title (`PageHeader`) |
| 20 | display | Sidebar wordmark (16 in the mobile top bar) |
| 14 | ui | Body default (`body { font-size: 14px; line-height: 1.5 }`), standard `ui/Button` |
| 13 | term-mono | Terminal (`xterm` `fontSize: 13`, JetBrains Mono) |
| 12.5 | ui | Page subtitle |
| 12 | ui / mono | Fields, dropdowns, badges, `sm` buttons, table cells |
| 11 | ui | Dense controls, dialog footers |
| 10.5 | mono | The detail line under a slow operation |
| 10 | ui | Section labels (uppercase), dropdown hints |
| 9 | ui | Smallest counters |

`Roboto Condensed`, `Roboto Mono` and `Instrument Serif` are pulled through
`next/font/google` in `src/app/layout.tsx` and self-hosted at build time, so
there is no runtime request to Google and the app types correctly offline.
They bind to `--font-sans-loaded` / `--font-mono-loaded` / `--font-serif-loaded`,
which `@theme inline` maps to `--font-sans` / `--font-mono` / `--font-serif`.

Serif is applied only through `.font-serif`: headings default to the UI family.
Body copy runs `letter-spacing: 0.01em` and `font-feature-settings: "ss01","ss02","cv01"`.
`td`, `th`, `code` and `pre` get `font-variant-numeric: tabular-nums`, so a
column of costs or token counts never jitters as it updates.

Two `text-[8px]` survivors, in `src/components/Sidebar.tsx` and
`src/app/usage/page.tsx`, are below the scale's floor and are the only
exceptions in the tree. Don't add a third.

## Layout & Spacing

The shell is identical on all sixty-odd frames.

- **Sidebar: 240px** (72 collapsed). `surface` fill, `border` on its right edge.
  Brand at the top (10px square + wordmark), the nav in the middle, then a
  What's new row and a connection line (a green dot and the word `Connected`,
  no port and no mono) and below those the Settings link and the Light/Dark
  toggle, which are what actually sit at the very bottom.
- **Header.** A 24px serif title, a 12.5px subtitle in `text-secondary` saying
  what the screen is for, and the page's actions right-aligned on the same block.
  `ui/PageHeader` carries only its own `pb-3.5`; the 22px top gutter is the page
  container's job, and 22 + title + 2 + subtitle + 14 is where the 84 comes from.
  It is written and mounted nowhere (no page imports it) so no 84px header
  ships today and every screen still rolls its own heading.
- **Content: padding 24 on all four sides** at desktop, 16 below `lg`
  (`p-4 lg:p-6 pb-6` on the main element). So the left edge of content is
  x=264 with the sidebar open: 240 + 24.
- **Status bar** at the foot of the terminal grid, not the content column
  (`TerminalsView/components/StatusBar.tsx`): the agent count and the per-state
  counts (running, waiting, idle, error) on the left, the total output-line
  count on the right. No branch, no spend, no tokens, no gateway.

The spacing step is **8**: the terminal grid's gap is 8, and card grids and
section stacks are multiples of it. Inside a component the steps are 2, 4, 6, 8,
10, 12, 14, 16, 20, 24. The shell's 24 gutter is on the step; the sidebar's own
`px-6` / `px-5` (24 / 20) are the only shell values worth looking up.

Control heights are **26 (small)** and **32 (standard)**. There is no third
height. A padding-driven height drifts with its content (an icon makes a button
taller than the word beside it) so `ui/Button` and `ui/Field` both hard-code
`h-[26px]` / `h-8` and a field sits flush with the button next to it.

## Components

Everything that defines raw appearance is meant to live in `src/components/ui/`.
That is the rule `scripts/design-lint.mjs` protects: it reads the `.ts`, `.tsx`
and `.css` files under `src/` for banned styling and excludes two paths,
`src/components/ui/` and `src/app/icon.tsx`. The hex rule excludes one more,
`src/app/globals.css`, where the colours are named.

The migration behind the rule has moved since this paragraph said two files
imported a primitive. Measured on 2026-09-18: 83 files outside `ui/` import from
it, `Button` in 52 of them, `BrandSpinner` in 19, `Dropdown` in 17, `PageHeader`
in 12, and `MetaChip`, `LoadingState` and `StatusBadge` in the rest. The
`Toggle` primitive still lives at `src/components/Settings/Toggle.tsx`, outside
`ui/`. Read this section as the target it still is, not as an inventory of what
every screen does today.

### Buttons: `ui/Button`
Four variants, two sizes, nothing else. `primary` is an accent fill with
`on-accent` text; `secondary` is `surface` with a `border`; `ghost` is
`text-secondary` with a transparent border; `danger` is red text on a 40% red
border, no fill. Every variant carries a border (transparent where it should
not show) because a fill with no border renders 2px shorter than the outlined
button beside it and no two buttons in a row share an edge.

One primary per screen, and nothing claims it yet: `variant="primary"` appears
nowhere in `src/`, and `src/components/Dashboard/index.tsx` renders no button at
all, only a heading and a dynamic import of `TerminalsView`.

### Fields: `ui/Field`
`Label`, `Input`, `PasswordInput`, `Select`, `Textarea` and `FieldError`. 32px
tall, `surface-raised` fill, 1px `border`, 12px text, `border` → `accent @ 40%`
on focus. Pass `error` and the border goes `danger`; pair it with a `FieldError`
caption (one short 11px line of red text under the field), never a tooltip.
Disabled is the browser's own state at 40% opacity. Read-only (`readOnly` on
`Input`, `PasswordInput` or `Textarea`) reads as read-only: the panel's
`surface` fill instead of `surface-raised`, the value in `text-secondary` and the
default cursor; the text stays selectable. On focus, by click or by keyboard, it
takes the standard `accent @ 40%` border like any field, since a field draws no
focus outline and that border is the only sign it holds the focus. A disabled
field keeps the disabled look, and `Select` never takes this one, since the
browser matches `:read-only` on both. The frame is `Settings · Connection`, rows
`row Gateway URL · Local` and the incoming webhook, and the focus state `RKPfa`.

### Dropdown: `ui/Dropdown`
The themed replacement for `<select>`. A native select renders its popup through
the OS and ignores the palette entirely, so every model picker looked like a
stock macOS menu; this draws the list itself on `surface` with a `border`, a
lucide `check` on the selected row, and an optional right-aligned hint (price
per million, model id). Closes on outside mousedown and on Escape. The panel is
as wide as its own content, at least as wide as the trigger and at most 24rem:
sized to the trigger alone it left the model picker in a team's member grid too
narrow to read a model name in, and uncapped a long label would widen the page.

### Tabs and the segmented control
Project tabs on the Dashboard: the active tab is a `surface` box against the
`bg` strip. `ui/Button`'s `active` prop is the segmented cell: a 26px cell whose
border darkens to `border-strong` over a `surface-raised` fill, never an accent
fill. Nothing uses it yet. The seven layout presets
(`single 2-col 2-row 2x2 3x2 3x3 focus`, in `TerminalsView/constants.ts`) ship as
a chevron dropdown in `LayoutPresetSelector.tsx`, not a row; and there is no
`Dark Light System` picker anywhere: the sidebar has a single Light/Dark toggle
button and `Settings/TerminalSection.tsx` offers two cards for the *terminal*
theme, dark and light. Where state is shown, it is the box. There is no
underline and no bar.

### Toggle
A 40×20 track with a 14×14 square knob and a 2px inset. On: `accent` track and
border, an `on-accent` knob, knob right. Off: `surface-raised` track, a
`text-secondary` knob, knob left. Square, like everything else. It lives at
`src/components/Settings/Toggle.tsx`, outside `ui/`, and the `--knob` variable
drawn for it is unused.

### Cards and panels
`surface` fill, 1px `border`, 2px radius, no shadow. An agent card
(`AgentList/AgentManagementCard`) is: the agent's mark at 16, its name, and the
status as a word in its tone, right-aligned; one line of task text, or the error
reason in red, or for a stopped agent who stopped it, when and why in
`text-secondary`; provider, model and branch as plain mono words, `claude · opus 5 ·
main`; then the four word buttons, open, stop or start, edit, delete. Frames:
`Agents · dark`, `Agent stopped · who and why`.

### Terminal panes
A 32px `surface` header (`TerminalsView/components/TerminalPanelHeader`): the
agent's mark at 16, its name, its branch (or, in error, the reason in red, and
stopped, who stopped it, when and why in `text-secondary`), then
right of the gap the status as a word in its tone and `provider · model` in
mono, start or stop, a 26px fullscreen button (lucide `maximize-2`, and
`minimize-2` while the pane fills the window), and the `···` menu with clear,
and remove outside fullscreen. No word names the pane's view: it has one, its
session (JeanBrasse, 13/10). Frames: `Dashboard · dark`, `Agent error · reason`,
`Panel header · fullscreen`, `Agent stopped · who and why`. xterm gets its palette
as a JS object rather than from CSS variables, and there are two of them:
`src/components/Terminal.tsx` draws on `#0D0B08`, while `TERMINAL_THEME` in
`src/components/AgentWorld/constants.ts` (re-exported by `TerminalsView`) draws
on `#1a1a2e` and `TERMINAL_THEME_LIGHT` on `#FFFFFF`. It is the one surface the
tokens don't reach, and the one place the pre-fork teal (`#3D9B94`) survives.

### Status dots and badges: `ui/StatusBadge`
A state is a 6px **square** in its colour, `StatusSquare`, or the word itself in
that colour, `StatusBadge`: no fill, no border, no pill. Four tones, running,
waiting, error and idle, with the older five names folded onto them. The square
marks rooms, notices and the menus that pick an agent as a target (the room's
recipients, Add agent), where the state decides the pick. A row about an agent
itself leads with its agent mark instead and writes the state as the word.
`StatusDot`, a 6px circle, is deprecated and the only round shape left.

### Agent mark: `ui/AgentMark`
Every agent has a mark: a 4×4 grid of squares, the Tars mark one size down,
drawn from its name by `src/lib/agent-mark.ts`. The left two columns take 8
bits of a hash of the name, stirred until 3 to 6 are lit, and the right two
mirror them, so the same name draws the same mark on every screen and every
machine, and a renamed agent gets a new one. Lit squares are `text-secondary`,
or the `accent` for the orchestrator (the role, never the name); unlit ones
are `surface-raised`. Two sizes, in whole pixels: 16 (squares of 3, gaps of 1)
in cards, panel headers, the Chat's team and fleet and each New team member; 24
(squares of 5) in the agent window's header and beside New agent's name field,
where it redraws as the name is typed. It is hidden from assistive tech: the
name beside it is what is read.

It replaced the emoji faces and the character picker (JeanBrasse's choice, 2026-09-23,
option C of the identity board). The `character` field stays in an agent's
data and nothing draws it. With it went the coloured provider badges: where a
provider is a fact about an agent, it is a plain mono word in `text-muted`,
`claude · opus 5 · main`. Its 8 free squares allow 210 marks, so two agents of
a large fleet can share one; the name beside it is what tells them apart.
Frame: `Agent mark`.

### Modals
Full-bleed `scrim`, then a `surface` panel with a `border`. Header band: serif
title, subtitle, divider. Footer band: divider, cancel on the left, the
forward action on the right, the primary last. Multi-step dialogs (New agent →
Project / Model / Tools / Task) put a row of step markers under the header: 28px
numbered circles joined by 40px connector lines, the reached ones filled
`text-primary` with `bg` as their numeral, the current one also ringed. They are
round, against the rule.

### Loading: `ui/Loading`
Three stages, because a spinner that shows for 200ms is a flash and one that
spins for eight seconds says nothing:

1. **Under 400ms: nothing.** No spinner, no flash.
2. **400ms-3s: the mark filling.** `BrandSpinner`, the 4×4 grid whose squares
   light one by one, 30px, over one line saying what is loading. Grey skeleton
   rows are gone: in a centring container they collapsed into a column of small
   grey squares that did not read as Tars. A wait inside a row takes the mark at
   26px, where the row's control would sit.
3. **Past 3s: name what is slow.** The mark at 24px, one line saying what is
   being waited on (`Still reading the Hermes gateway…`), the endpoint and
   elapsed seconds in 10.5px mono, and a Cancel button.

Every wait goes through this: `LoadingState` for the ladder, `LoadingPanel` for
a panel given over to waiting at once. None is a bare `Loading…` line, and no
list says it is empty before its first read has answered. Frame: `Loading states`.

The launch sequence uses the same vocabulary: the 4×4 `SquareGrid` fills through
three steps (reading your projects, detecting providers, connecting to Hermes),
then the wordmark fades in. The steps advance on fixed `setTimeout` timers
260ms apart (the main process reports nothing) so it is reassurance, not
progress.

## Do's and Don'ts

- **Don't use an accent rule.** Never a 2px orange bar to the left of, or under,
  an active item. Active state is carried by the *box*: an `accent-dim` fill for
  nav and menu rows, or `surface` + `border` for tabs and segmented cells. The
  label of an active nav item should stay `text-primary`: measured off the frames,
  the active and inactive rows differ only by fill and by `text-primary` vs
  `text-secondary`. `Sidebar.tsx` does neither: nav rows, What's New and Settings
  all render active as `bg-primary/20 text-primary`, a 20% accent fill under an
  orange label, which in light also fails contrast. `Dropdown` is the one that
  reads right, at `bg-primary/10` with `bg-primary/5` on hover. Orange rules and
  orange labels are AI design slop.
- **Don't use `>_` as a mark.** The mark is an orange **square**. Loaders and the
  app icon are a 4×4 grid of them that fills. `src/components/Brand.tsx` is the
  single source of the identity: rebranding is editing that file and the OS icon,
  nothing else.
- **Don't add a shadow.** `scripts/design-lint.mjs` fails on `shadow-sm|md|lg|xl|2xl`,
  and `globals.css` neutralises anything matching `[class*="shadow-"]` with
  `box-shadow: none !important`. The pre-fork Dorothy utilities `.card-hover`,
  `.card-accent`, `.hover-lift` and `.shadow-elevated`, with its teal and its warm
  brown shadow, left `globals.css` on 2026-08-23 (a337e7a). Not to be revived.
- **Don't use a gradient.** Lint fails on `bg-gradient`.
- **Don't set a radius inline.** Lint fails on `style={{ borderRadius`. Radius
  comes from the theme: 2px on buttons, inputs, selects, and every `.rounded-*`
  class the app still carries. `rounded-full` is meant to survive only on dots and
  avatars under 12px, and it has not held: the agent card's status pill
  (`AgentCard.tsx:118`), the sidebar's 20px badge counters and the New-agent step
  circles are all round today. Each is a bug, not a precedent.
- **Don't write a hex colour out.** Lint fails on `#` followed by 3, 4, 6 or 8
  hex digits anywhere but `src/app/globals.css`, where the tokens are defined,
  and `src/components/ui/`. The tree has none left: `src/lib/terminal-theme.ts`
  reads xterm's palette off the tokens through a probe element, and the vendor
  marks, whose white glyph is knocked out of a coloured square, live in
  `src/components/ui/ProviderBadge.tsx`.
- **Don't use a raw Tailwind palette colour.** Lint fails on
  `(text|bg|border)-(red|green|blue|amber|purple|cyan|yellow|orange|zinc|slate|gray)-[0-9]`.
  Use the tokens. Tailwind's `cyan-*` scale is remapped to the tangerine ramp in
  `@theme inline` precisely so old teal classes degrade into the brand instead of
  into a wrong colour.
- **Don't animate for decoration.** Lint fails on `animate-ping`. The intended vocabulary is
  `fade-in`, `slide-up`, `square-pulse`, and 150ms colour transitions on
  interactive elements, and the tree does not keep to it: `animate-spin` occurs
  100 times and `animate-pulse` 13, against one `animate-fade-in` and one
  `animate-slide-up`, and `globals.css` carries a `pulse-subtle` keyframe nothing
  uses.
- **Do define appearance only in `src/components/ui/`.** Everything else should
  compose those primitives; today two files do, and closing that gap is the
  standing job. Run `npm run lint:design` before you push.
- **Do give every data surface all five states**: loading (the three-stage
  ladder), empty, error, needs-sign-in, permission-denied.
- **Do keep the focus ring.** `*:focus-visible` is `2px solid var(--primary)` at
  `outline-offset: 2px`, on both themes. Removing an outline without replacing it
  is not a style choice.
- **Do check both themes.** A token has two values or it isn't a token. The theme
  class is toggled on `<html>`; nothing reads a media query.

## Iconography

[lucide](https://lucide.dev) (`lucide-react`), at 12px (`w-3 h-3`) in dense
controls and 16px (`w-4 h-4`) at standard size: 204 and 267 occurrences, the two
that carry the app. A third size leaked in and stayed: 20px (`w-5 h-5`, 75
occurrences) is every sidebar nav icon and the agent-card status glyphs. Default
stroke, coloured with `text-secondary` or `text-muted` and lifting to
`text-primary` on hover. Used in the frames: `chevron-down` (dropdowns), `check`
(selected row), `menu` / `x` (mobile sidebar), `download` / `external-link` /
`rotate-cw` (updater), `loader-2`, which is meant to be updater-only, the app's
own waiting state being the square pulse, but is imported by 49 files today,
including `AgentList/AgentCard.tsx`, where it is the running-agent spinner.

**The grey squares in the Pencil exports are placeholders, not a specification.**
Every sidebar entry, settings group, menu row and provider row in
`design/exports/` shows a flat grey square where an icon belongs. They stand for
"an icon goes here"; they are not squares-as-icons and they are not the brand
mark. Pick the lucide glyph that names the thing.

Provider marks are the exception: Claude, Codex, Gemini, Grok and the rest keep
their own logos where a provider is chosen, New agent's provider cards, Settings
and Usage. Where a provider is a fact about an agent, it is a plain word (see
Agent mark). `src/components/ui/ProviderBadge.tsx` renders the logos from one
registry (`src/lib/providers.ts`) at 14px (`w-3.5 h-3.5`): most as inline SVG
on `currentColor` so they inherit the row's text colour, a few as bitmap assets
from `public/` where the vendor mark is not reducible to a single path.
