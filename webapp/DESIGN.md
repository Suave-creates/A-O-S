# AOS --- Design System and UX Specification

**Product:** ASRS Intelligence & Automation (AOS)\
**Companion documents:** `RULES.md` (contract), `STRUCTURE.md` (map)\
**Stack constraint:** vanilla CSS/JS, no build step, no UI or chart
library additions\
**Status:** Design specification for an evolving internal application

`RULES.md` defines what is allowed. `STRUCTURE.md` defines where things
live. This document defines **how AOS looks, reads and behaves** for the
people using it.

**Precedence:** if anything here conflicts with `RULES.md`, `RULES.md`
wins. This document adds no new data flow, polling, upstream access,
persistence, permission or NexS behavior. It only specifies the
presentation of what the system already produces.

**Values marked *Proposed*** have not been verified against the current
`app.css` / `theme.css`. Before adopting one, check the stylesheet. If
an equivalent value already exists, the existing value wins and this
document is updated to match.

---

## 1. Design principles

1.  **Exceptions first.** The top of every screen answers "what needs
    action right now?" Normal values are secondary.
2.  **Every number declares its freshness.** A value is never shown
    without a way to tell whether it is live, stale or unavailable.
3.  **Readable in three seconds from a step away.** Large primary
    values, short labels, strong hierarchy. Detail is available on
    demand, not up front.
4.  **Trust over decoration.** No visual element may make data look
    more certain, more current or more complete than it is.
5.  **Safe by default for actions that change warehouse state.** Pulls,
    purges and uploads are previewed, confirmed and reported. They are
    never one-click.
6.  **One language, many layouts.** Tokens and components are shared.
    Page composition follows the task (§7), not a template.
7.  **Original.** Principles may be learned from references;
    composition, palette, typography and icons may not be copied
    (`RULES.md` §11.3).

---

## 2. Users and usage contexts

*Assumption --- confirm with the owner.* The design targets these
contexts:

| User | Typical context | Primary need |
|---|---|---|
| Plant leadership / HODs | Desk, meetings, wall display | Health at a glance, exceptions, shift comparison |
| Shift supervisors | Desk or standing workstation near the floor | Live monitoring, drill-down, deciding what to act on |
| Operators running tools | Workstation, possibly with a barcode scanner | Fast input, clear validation, safe actions, unambiguous results |
| Administrators | Desk | Users, permissions, queries, audit |

Design implications:

-   Primary values must be legible at roughly 1.5--2 m on a standard
    monitor (see type scale, §4.3).
-   Input screens must work with keyboard-only and keyboard-wedge
    scanner input (§10.9).
-   Nothing may depend on hover alone. Touch and keyboard users must
    reach the same information.

---

## 3. Visual identity

### 3.1 Direction

AOS should feel like a **precise operational instrument**: calm when
things are normal and unmistakable when they are not.

| Attribute | Means | Does not mean |
|---|---|---|
| Calm | Neutral surfaces, restrained accent use, generous spacing between groups | Low contrast or washed-out data |
| Precise | Fixed-width digits, aligned columns, exact timestamps, explicit units | Excess decimal places or visual noise |
| Unambiguous | Status shown with icon + label + color; consistent severity | Color-only signalling or decorative alarm effects |
| Industrial | Structured grids, clear edges, practical density | Heavy skeuomorphism or hazard-tape decoration |

### 3.2 Brand usage

-   Use only assets in `public/brand/`. The logo appears once, in the
    shell. Feature screens do not repeat it.
-   Fonts come only from `public/fonts/` (vendored, licensed). No
    remote font loading.
-   The accent color (`--accent`) marks interaction and focus: primary
    buttons, selected tabs, focus rings, active filters. It is **not** a
    status color and must not mean "good" or "bad".

### 3.3 Things AOS does not do visually

-   Gradient-heavy hero areas, glassmorphism, decorative blobs or
    illustrations on operational screens.
-   Per-module accent colors. (Exception, AOS Ink: each nav section has one soft pastel used **only** for
    the page-title icon tile - see `public/aos.css`. It never colours data, status or controls.)
-   Recolored copies of a reference product's layout.

---

## 4. Tokens

All tokens live in `:root` in the established stylesheets
(`RULES.md` §11.1). Feature CSS consumes tokens and never defines
colors. Light and dark themes redefine the **same token names**.

### 4.1 Color roles

Existing tokens (named in `RULES.md` §11.2) and their roles:

| Token | Role |
|---|---|
| `--bg` | Application background |
| `--panel` | Primary surface (panels, cards, tables) |
| `--panel-2` | Secondary surface (headers, nested areas, zebra rows, inputs) |
| `--accent` | Interaction and focus only (§3.2) |
| `--ok` | Severity: OK |
| `--warn` | Severity: Watch |
| `--danger` | Severity: Action needed and Critical |

*Proposed* additions --- add only if no equivalent exists:

| Token | Role |
|---|---|
| `--text` / `--text-muted` / `--text-faint` | Three text emphasis levels |
| `--border` / `--border-strong` | Dividers / input and focus-adjacent edges |
| `--neutral` | Severity: neutral / informational |
| `--stale` | Stale data treatment (must not resemble `--warn`) |
| `--unavailable` | Unavailable data treatment (muted, distinct from `--danger`) |
| `--ok-bg`, `--warn-bg`, `--danger-bg`, `--neutral-bg` | Low-intensity tinted backgrounds for pills and rows |
| `--focus-ring` | Focus outline (defaults to `--accent`) |

Rules:

-   Text on any surface must meet **WCAG AA**: 4.5:1 for body text,
    3:1 for large text and essential UI boundaries, in both themes.
-   Tinted backgrounds (`*-bg`) must keep the foreground text at AA.
    Verify both themes.
-   In dark theme, semantic colors are adjusted for contrast, not just
    reused. `--danger` on a dark surface usually needs higher lightness.

### 4.2 Spacing

*Proposed* 4 px base scale:

| Token | Value | Typical use |
|---|---|---|
| `--sp-1` | 4px | Icon-to-label gap, pill padding |
| `--sp-2` | 8px | Inside compact controls, table cell vertical padding (compact) |
| `--sp-3` | 12px | Table cell padding (comfortable), form field gap |
| `--sp-4` | 16px | Panel inner padding (compact), card gap |
| `--sp-5` | 24px | Panel inner padding (default), section gap |
| `--sp-6` | 32px | Gap between major page regions |
| `--sp-7` | 48px | Empty-state vertical padding, wall-display gutters |

Rule: spacing *between* groups is larger than spacing *within* groups.
That is how hierarchy is created before reaching for borders or color.

### 4.3 Typography

*Proposed* scale (use the vendored font; fall back to the system UI
stack):

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--fs-display` | 40 / 44 | 600 | Primary KPI value; wall display |
| `--fs-xl` | 28 / 32 | 600 | Secondary KPI value |
| `--fs-lg` | 20 / 28 | 600 | Page title |
| `--fs-md` | 16 / 24 | 600 | Panel title |
| `--fs-base` | 14 / 20 | 400 | Body, table cells, inputs |
| `--fs-sm` | 12 / 16 | 500 | Labels, captions, freshness badge, column headers |

Rules:

-   All numeric displays (KPI values, table numbers, timestamps,
    counters) use `font-variant-numeric: tabular-nums`, so live values
    do not shift horizontally when they change.
-   Column headers and labels are `--fs-sm`, sentence case. Avoid ALL
    CAPS except for short codes that are capitalized in the source
    (e.g. tote IDs, station codes).
-   Minimum text size anywhere: 12 px.

### 4.4 Radius, elevation, layering

| Token | Use |
|---|---|
| `--radius` (existing) | Panels, cards, modals |
| `--radius-sm` *(Proposed, ~half of `--radius`)* | Inputs, buttons, pills |
| `--shadow-1` (existing) | Panels on `--bg` |
| `--shadow-2` *(Proposed)* | Popovers, dropdowns, toasts |
| `--shadow-3` *(Proposed)* | Modals |

*Proposed* z-index tokens: `--z-sticky` (table headers), `--z-shell`
(header/sidebar), `--z-popover`, `--z-toast`, `--z-modal`. Never use
literal z-index numbers in feature CSS.

### 4.5 Motion

*Proposed* durations: `--dur-fast` 120 ms (hover, press),
`--dur-base` 200 ms (expand, toast), `--dur-flash` 900 ms (`.cell-flash`
value change). Easing: one standard ease-out curve.

All motion lives in the `MOTION LAYER` of `app.css` and is disabled or
reduced to an instant change under `prefers-reduced-motion: reduce`
(`RULES.md` §11.5).

---

## 5. Application shell

The shell is owned by `public/index.html` and `public/js/core/app.js`
(`RULES.md` §4). Feature screens render only inside the content region.

```text
+----------------------------------------------------------------+
| Shell header: logo · current screen · connection status ·      |
|               live indicator · theme · user                    |
+------------+---------------------------------------------------+
| Sidebar    | Content region (one feature panel)                |
| navigation |  +---------------------------------------------+  |
|            |  | Page header (§6)                            |  |
| GLOBAL     |  +---------------------------------------------+  |
| alerts     |  | Module layout (§7)                          |  |
| tray       |  |                                             |  |
|            |  +---------------------------------------------+  |
+------------+---------------------------------------------------+
```

Shell rules:

-   **Navigation grouping** follows module type (§8) so related tools
    sit together. Labels are nouns for the thing being looked at
    ("Locked Totes"), not verbs.
-   **Connection status** is passive and observational. A disconnected
    NexS while idle is shown as neutral **Idle**, never as an error
    (`RULES.md` §6.4). It becomes an error only when a NexS-dependent
    operation fails to connect.
-   **GLOBAL alerts** in the sidebar show severity icon, a one-line
    summary and age, and stay until acknowledged (`RULES.md` §9).
-   **Sidebar collapse:** at narrower widths (§13) the sidebar collapses
    to icons with accessible labels/tooltips; at the smallest width it
    becomes a toggled drawer.
-   **Skip link:** the shell provides a "Skip to content" link as the
    first focusable element.

---

## 6. Standard page header

Every feature screen starts with the same header anatomy, so users
always know where to look.

```text
+----------------------------------------------------------------+
| [icon] Page title                       [Freshness] [Primary ▸]|
| Scope / filters: [Type ▾] [Priority ▾] [Window: 60m ▾] [Reset] |
+----------------------------------------------------------------+
```

-   **Left:** `.h-ico` icon + page title (`--fs-lg`). One optional
    short subtitle (≤ 1 line) if the screen's purpose is not obvious.
-   **Right:** the freshness badge (§9.1) for the screen's main data,
    then at most **one** primary action. Secondary actions go in the
    relevant panel, not the header.
-   **Second row (optional):** scope and filters that apply to the whole
    screen. Panel-local filters stay in the panel.
-   Long explanations go in a collapsed `<details class="info-note">`
    directly under the header (`RULES.md` §11.6).

---

## 7. Module layouts

One design language, different compositions (`RULES.md` §11.4). Each
module type below defines the default reading order. A screen may
deviate when its workflow demands it, with the reason stated in a
comment.

### 7.1 Dashboard --- operational health

```text
[Exceptions strip: only items at Watch or worse; hidden when none]
[Primary KPIs: 3–5 cards max, each with trend + freshness]
[Shift view: current shift vs previous, hour-by-hour (§12.3)]
[Live activity stream | Secondary metrics]
```

-   The exceptions strip is first. If nothing needs action, it collapses
    to a single **All clear** line with the time checked, rather than
    disappearing silently.
-   Do not exceed 5 primary KPI cards. More metrics move to secondary
    panels or drill-down.

### 7.2 Monitoring --- dense records

```text
[Summary bar: total · by status · by age bucket]
[Distribution (bar or ageing histogram)]
[Filterable table (§11) with drill-down]
```

-   Summary-bar segments double as filters: clicking "Locked > 24 h"
    filters the table.
-   Ageing uses consistent buckets per screen, labelled with explicit
    ranges ("4–24 h"), not vague words ("old").

### 7.3 Operations --- queue, validate, act

```text
[Input / queue panel]  ->  [Validation result]  ->  [Action + confirm]
[Progress of running job]
[Operation history (this user / recent)]
```

-   Strict left-to-right or top-to-bottom flow that matches the
    workflow order. The action button is disabled until validation
    passes, with the reason shown next to it.
-   Uses the mutation flow in §10.10.

### 7.4 Inventory / validation --- compare sources

```text
[Sources compared: System A · System B · fetch time of each]
[Match summary: matched · only in A · only in B · conflicting]
[Discrepancy table: evidence columns side by side]
```

-   Every compared source shows its own name and fetch time. Two
    sources fetched at different times must say so.
-   Discrepancy rows show the evidence (both values), not just a
    "mismatch" flag.

### 7.5 Reports --- period and provenance

```text
[Reporting period (prominent) · generated at · data sources]
[Sections, each with: period type (historical / live), freshness]
[Comparison (vs previous period) · Export]
```

-   The reporting date appears at the top and in every export.
-   A section that mixes live current-state data into a historical
    report carries a visible **Live at <time>** label
    (`RULES.md` §7).
-   Unavailable sections render as an explicit unavailable block, not
    as zeroes and not omitted.

### 7.6 Administration --- forms, permissions, audit

```text
[Searchable table of entities]
[Detail / edit drawer or panel: form + permission state]
[Audit trail for the selected entity]
```

-   Permission states are explicit: **All panels**, **Selected panels
    (n)**, **Admin**. Never infer "all" from an empty list visually
    without saying so.
-   Destructive admin actions (deactivate, delete) use the confirm
    pattern in §10.10.

---

## 8. Screen inventory and module type

*Proposed* classification, based on `STRUCTURE.md` §3.3 and §4.1.
Confirm against the live shell registry before applying.

| Screen | Module type | Notes |
|---|---|---|
| Dashboard / detail drill-down | Dashboard | Exceptions strip first; shift view |
| Tote Utilisation | Monitoring | Run history is a secondary panel |
| Locked Totes | Monitoring | Ageing buckets on locked-since |
| Picking Monitor | Monitoring | Station health uses severity scale (§9.2); pipeline strip is the summary bar |
| Tote Purge / Outside Tote Analysis | Operations (+ Monitoring analysis panel) | NexS on demand; mutation flow |
| Manual Tote Puller | Operations | Mutation flow; purge toggle needs explicit confirm copy |
| Auto Tote Puller | Operations | Show running state and safeguards prominently |
| Location Audit / 3D view | Inventory / validation | 3D view is supplementary; a table view must exist for accessibility |
| CNG Validator | Inventory / validation | Source comparison layout |
| Bulk Inventory Check | Inventory / validation | Scanner/paste input (§10.9) |
| Container Tracker | Monitoring (lookup) | Search-first; timeline of events |
| One Pager Report | Reports | Period + provenance header |
| Users / Admin | Administration | |
| Active Queries | Administration | Status from server state only |
| Alerts | Monitoring (exception queue) | Severity, age, acknowledge, remark |

---

## 9. Data trust: freshness, states and severity

### 9.1 Freshness badge

A single shared component, placed in the page header (§6) and on any
panel whose data source differs from the page's main source.

| State | Icon | Label pattern | Visual |
|---|---|---|---|
| Live | filled dot | `Live · 14:32` | `--ok` dot, normal text |
| Refreshing | spinner/pulse (static under reduced motion) | `Updating…` | Neutral |
| Stale | half-filled dot | `Stale · last good 14:12` | `--stale`; values below get stale treatment |
| Unavailable | cross | `Unavailable · <source> <reason>` | `--unavailable` |
| Idle (NexS) | hollow dot | `NexS idle · connects when needed` | Neutral, not an error |

-   The time shown is the **last successful fetch** from the server, not
    the browser clock time of render.
-   Hover/focus/tap reveals: source system, fetch time, cadence (e.g.
    "updates about every 60 s").
-   A manual refresh control, if present, sits beside the badge and goes
    through `Live.refresh(topic)` only.

### 9.2 Severity scale

One scale for alerts, pills, KPI thresholds, station health and table
row markers:

| Level | Meaning | Token | Icon shape | Label |
|---|---|---|---|---|
| OK | Within normal range | `--ok` | check | `OK` |
| Neutral | Informational, no judgement | `--neutral` | circle | context-specific |
| Watch | Trending wrong; no action yet | `--warn` | triangle | `Watch` |
| Action needed | Someone should act this shift | `--danger` | diamond | `Action` |
| Critical | Act now; operations affected | `--danger` filled background | octagon | `Critical` |

Rules:

-   Severity is always **icon + label + color**. Color alone is never
    the only signal (`RULES.md` §11.2).
-   Thresholds come from the existing configuration and alert settings.
    The design never hard-codes a threshold.
-   "Supervisor to check" style states (e.g. unknown station priority
    weight) map to **Watch**, with the specific reason in the label or
    tooltip.

### 9.3 Screen and section state matrix

Every screen and every independently loaded section handles these states
(`RULES.md` §11.6):

| State | Show | Never show |
|---|---|---|
| Loading (first load) | `.skeleton` shaped like the final content | Spinner over a blank page; zeros |
| Empty (valid, no rows) | Why it is empty + next action (§14.2) | A bare `—` |
| Live | Data + freshness badge | |
| Stale | Last good data with stale treatment + badge | Data styled as live |
| Unavailable (never had data) | Unavailable block: source + reason + what to do | `0`, blank cells |
| Error (request failed) | Error message template (§14.1) with reference ID | Raw stack traces, secrets |
| Partial | Available sections normally + unavailable blocks for the rest | Missing sections without explanation |

**Stale value treatment:** value text drops to `--text-muted`, a
`--stale` left border or subtle diagonal hatch is applied to the
container, and the badge says Stale. The value stays readable.

---

## 10. Components

Reuse existing classes and helpers (`RULES.md` §11.5,
`STRUCTURE.md` §3.2). New shared components go in `public/js/core/` and
must not contain feature names or business rules.

### 10.1 Panel (`.panel`)

-   Title row: `.h-ico` icon + title (`--fs-md`) · optional freshness
    badge · panel actions (right, max 2 visible, overflow in a menu).
-   Panels do not nest more than one level.

### 10.2 KPI card (`KpiCard.mount`)

```text
+---------------------------+
| Label              [i]    |
| 1,284        ▲ 6% vs prev |
| ~~~~~ sparkline ~~~~~     |
| Live · 14:32  · target 1,500 |
+---------------------------+
```

-   One primary value only. The unit is shown (`totes`, `items/h`,
    `%`).
-   Delta shows direction icon + value + comparison basis ("vs prev
    shift"). Whether up is good or bad is defined per metric; the delta
    color uses severity only when a threshold says so, otherwise
    neutral.
-   Value change uses `.cell-flash` once. No counting animations.
-   Click/Enter on a card opens its drill-down, if one exists.

### 10.3 Status pill (`.status-pill`) and live pill (`.live-pill`)

-   Status pill = severity icon + label, `*-bg` background, `--fs-sm`.
-   Live pill is reserved for live-connection state, not for data
    severity.

### 10.4 Buttons

| Variant | Use |
|---|---|
| `button.primary` | The one main action of a screen or dialog |
| default button | Secondary actions |
| `button.link` | Navigation-like or low-emphasis actions |
| danger variant *(Proposed)* | Confirm step of a destructive action only |

States: default, hover, active, focus-visible, disabled (with reason
available on focus/hover), busy (label changes to the action in
progress, e.g. "Pulling…", button disabled to prevent double submit).

### 10.5 Inputs and forms

-   Visible label above every field; placeholder is an example, not the
    label.
-   Inline validation after the field is left or submitted, not on every
    keystroke.
-   Error text below the field states the fix ("Enter a tote ID like
    T-12345") --- *the exact ID format must come from the domain layer;
    the example here is illustrative.*
-   Required fields are marked; optional fields say "Optional".

### 10.6 Filter chips

-   Active filters appear as removable chips under the page header or
    panel title, with a **Clear all** link.
-   Filter state is reflected in the table count ("Showing 120 of
    4,302").

### 10.7 Toast (`Toast.show`)

-   For routine, non-blocking events: connection changes, live update
    interrupted/resumed, copy-to-clipboard, background job finished.
-   Auto-dismiss after ~5 s; errors that need action persist until
    dismissed and include the next step.
-   Max 3 visible; newest on top.

### 10.8 Modal (`modal.js`)

-   Only for decisions that require focus or confirmation
    (`RULES.md` §11.6).
-   Focus moves into the modal, is trapped while open, Esc cancels, and
    focus returns to the triggering control on close.
-   The primary button describes the action ("Pull 42 totes"), never
    "OK" or "Yes".

### 10.9 Scanner / bulk input

*Assumption:* some operators use keyboard-wedge barcode scanners.
Confirm per screen.

-   The input is auto-focused when its screen becomes active (and only
    then).
-   Enter submits a single scan; multi-line paste is accepted and parsed
    through `toteListParser.js` where applicable.
-   After paste, show a parse summary before acting: "128 IDs · 3
    duplicates removed · 2 invalid (show)".
-   Each scan gives visible feedback (row added / error inline).
    Audio feedback is optional, off by default, and never the only
    signal.

### 10.10 Mutation flow (pull, purge, upload, admin delete)

```text
1 Preview  ->  2 Confirm  ->  3 Progress  ->  4 Result
```

1.  **Preview:** what will happen, to how many items, in which system,
    with any items that will be skipped and why.
2.  **Confirm:** modal (§10.8). For large batches (*Proposed*
    threshold: configurable, e.g. 50+ items) the operator types the
    count to confirm. The purge toggle and similar irreversible options
    are restated in the confirm text.
3.  **Progress:** via `Live.watch("query:" + id, …)`. Show counts done
    / failed / remaining and the query ID. Leaving the tab does not
    cancel a server job; the UI says so.
4.  **Result:** three explicit outcomes per item:
    -   **Succeeded**
    -   **Failed** (with reason)
    -   **Uncertain --- reconcile before retrying** (timeouts and
        ambiguous upstream responses; `STRUCTURE.md` §11)

Retry is offered only for **Failed**, never automatically for
**Uncertain**. Results are exportable and link to the operation
history.

### 10.11 Operation log / activity stream

-   Newest first, time (HH:mm:ss), actor, action, target count, result
    pill, query ID (copyable).
-   New entries use `.live-appear` once; existing rows never reflow.

### 10.12 Info note (`details.info-note`)

-   Collapsed by default. Summary line ≤ 8 words ("How this is
    calculated").

### 10.13 Icons

-   Only the generated set: `<i class="ico" data-i="…"></i>`
    (`RULES.md` §11.5). New icons go through the generator.
-   Icons accompany labels; icon-only buttons require `aria-label` and
    a tooltip.

---

## 11. Tables

-   **Header:** sticky (`--z-sticky`), `--fs-sm`, sentence case, sort
    indicator on sortable columns, `aria-sort` set.
-   **Alignment:** text left, numbers and durations right, status
    centered or left with pill, IDs left in tabular figures.
-   **Density:** comfortable (default) and compact. The choice is a
    per-viewer preference stored in `localStorage` wrapped in
    try/catch --- it is UI state and must not go to MySQL
    (`RULES.md` §8).
-   **Count line:** "Showing *n* of *total*" above the table, plus
    active filter chips.
-   **Row interactions:** whole-row click opens drill-down where one
    exists; ID cells have click-to-copy with a toast confirmation.
-   **Large result sets:** paginate or progressively render; never
    render tens of thousands of DOM rows at once.
-   **Live updates:** changed cells use `.cell-flash`; rows are not
    re-sorted under the user's cursor while they are interacting
    (apply new order on next sort or after interaction ends).
-   **Empty table:** in-table empty state (§14.2), not a zero-height
    table.
-   **Export:** CSV uses the same column names as the screen and
    includes the reporting period/fetch time in the file name or first
    row.

---

## 12. Charts

Use the existing `charts.js` and `sparkline.js`. No chart library
additions (`RULES.md` §12).

### 12.1 Allowed forms

| Question | Chart |
|---|---|
| How is it trending over time? | Line (or sparkline in a KPI card) |
| How do categories compare? | Horizontal bar, sorted by value |
| How is it distributed / ageing? | Histogram / bucketed bar |
| Part of a whole | Stacked bar (single bar or 100% bar) |

No pie/donut, 3D, dual y-axes or decorative gradients.

### 12.2 Rules

-   Series colors use a dedicated *Proposed* categorical token set
    (`--series-1` … `--series-6`), distinct from severity colors.
    Severity colors appear in charts only for threshold lines or
    breached segments.
-   Maximum 6 series; more are grouped into "Other" or moved to a
    table.
-   Axes: start bars at zero; label units; time axis in 24-hour IST.
-   Tooltips work on hover **and** keyboard focus, and show value, unit,
    time and series name.
-   Missing data is a gap in the line, not a drop to zero
    (`RULES.md` §7).
-   Every chart has a text alternative: a caption summarising the
    takeaway, or an accessible data table toggle.

### 12.3 Shift bands

Time-series charts covering more than one shift shade shift periods
(A / B / C) with alternating subtle background bands and label them.

*Shift boundaries must come from existing configuration or the domain
layer, not be hard-coded in chart or feature code. If no source exists
yet, this is an open decision (§18).*

---

## 13. Responsive behavior

*Proposed* breakpoints:

| Name | Width | Behavior |
|---|---|---|
| Wide | ≥ 1440px | Full sidebar; multi-column module layouts |
| Standard | 1024–1439px | Full sidebar; KPI rows wrap |
| Narrow | 768–1023px | Icon sidebar; panels stack to one column |
| Small | < 768px | Drawer navigation; tables scroll horizontally inside their panel |

-   No horizontal scrolling of the page itself; only tables and the 3D
    view may scroll within their containers.
-   Page header filters wrap; the primary action stays visible.

---

## 14. Content and microcopy

### 14.1 Error message template

```text
<What happened>. <What it affects>. <What to do>.  Ref: <query/operation ID>
```

Example: "Quadron didn't respond in time. Tote counts on this panel may
be out of date. Retry in a minute, or check Active Queries. Ref: Q-8f3a"

-   No raw exception text, stack traces, credentials or upstream URLs
    (`RULES.md` §6.1, §12).
-   Blame the system, never the user.

### 14.2 Empty state template

```text
<Why it's empty>. <Next action, as a link or button if possible>.
```

Examples: "No locked totes right now. Checked at 14:32." · "No results
for these filters. Clear filters."

### 14.3 Voice

-   Short, direct, operational. Sentence case everywhere.
-   Verbs on buttons describe the result ("Pull totes", "Acknowledge"),
    not the mechanism ("Submit", "Execute").
-   Numbers in copy include units.

### 14.4 Terminology

Use one term per concept across all screens. Before adding a new screen,
check this list and extend it rather than inventing a synonym. *The
owner fills or confirms definitions; terms below are taken from
`RULES.md` and `STRUCTURE.md`.*

| Use | Avoid | Definition |
|---|---|---|
| Tote | Bin, box, crate | *(owner to confirm)* |
| Locked tote | Blocked tote, stuck tote | *(owner to confirm)* |
| Pull (tote pull) | Retrieve, fetch, call | *(owner to confirm)* |
| Purge | Clear, empty, flush | *(owner to confirm)* |
| Outside tote | External tote | *(owner to confirm)* |
| GTP station | Pick station, workstation | *(owner to confirm)* |
| Container | *(owner to confirm vs tote)* | *(owner to confirm)* |
| Stale | Old, outdated, cached | Last good data, older than its expected cadence |
| Unavailable | Error, N/A, blank | Source has not produced usable data |
| Idle (NexS) | Disconnected, offline | Not connected because nothing needs it |

---

## 15. Formatting conventions

Implement once in a generic client formatting helper in
`public/js/core/` (*confirm whether one already exists before adding*).
Features never format numbers or times ad hoc.

| Kind | Format | Example |
|---|---|---|
| Integer counts | Grouped, locale per §18 | `12,345` or `12,345` / `1,23,456` |
| Percentages | 0 decimals by default; 1 when < 10% and meaningful | `87%`, `4.2%` |
| Rates | Value + unit | `284 items/h` |
| Durations | Largest two units | `2 h 14 m`, `45 s` |
| Time of day | 24-hour, IST | `14:32` |
| Date | Unambiguous, day first | `20 Oct 2026` |
| Date-time in tables | `20 Oct 14:32` (year when not current) | |
| Relative time | Only alongside absolute time | `14:32 · 3 min ago` |
| Missing | Reason word, never a bare dash | `Unavailable`, `No data in window` |

-   The page header states "Times in IST" once; cells do not repeat the
    timezone.
-   Exports use ISO 8601 timestamps with offset
    (`2026-10-20T14:32:00+05:30`) so spreadsheets sort correctly, plus
    the display column if useful.

---

## 16. Accessibility

-   WCAG 2.1 AA as the target for both themes.
-   Visible focus on every interactive element using `--focus-ring`
    (2 px outline + offset); never remove outlines without a
    replacement.
-   Logical tab order matching visual order; no positive `tabindex`.
-   Live regions: freshness changes and critical alert arrivals are
    announced via a polite `aria-live` region owned by the shell, not by
    each feature. Routine value updates are **not** announced.
-   Click targets at least 32 × 32 px (44 × 44 px in wall display and
    any touch-first screen).
-   The 3D location view must have an equivalent table or list view.
-   Respect `prefers-reduced-motion` and `prefers-color-scheme`, with
    the in-app theme choice taking precedence.

---

## 17. Wall display mode (optional --- shell change)

A presentation mode of the **Dashboard** for large shared screens.

-   Activated by an explicit control or URL parameter handled by the
    shell (`app.js`). This is a shell change and must be proposed and
    approved before implementation (`RULES.md` §4, §11.3).
-   Hides sidebar and filters; keeps the shell's connection status and
    freshness badge always visible.
-   Uses the same live subscriptions as the Dashboard. No new feeds,
    no polling, no faster cadence.
-   Type steps up one level (`--fs-display` for primary values), gutters
    use `--sp-7`, exceptions strip is enlarged.
-   When data becomes stale or unavailable, the whole display shows a
    clear banner, because no one is reading tooltips on a wall.
-   Requires an authenticated session with the Dashboard panel like any
    other viewer; no public or token-in-URL access.

---

## 18. Open decisions for the owner

These are not decided by this document. Until decided, follow the
default noted.

| Decision | Default until decided |
|---|---|
| Number grouping: Indian (`1,23,456`) or international (`123,456`) | `en-IN` for screens; exports unformatted |
| Shift A/B/C boundaries and their source of truth | No shift bands until a configured source exists |
| Whether operators use scanners on AOS screens | Support paste + Enter; auto-focus only on input-first screens |
| Typed-count confirmation threshold for bulk mutations | Configurable; no value hard-coded in UI |
| Terminology definitions (§14.4) | Use the "Use" column; definitions pending |
| Whether to build wall display mode (§17) | Not built |
| Reconciling *Proposed* tokens with `app.css` / `theme.css` | Existing values win |

Related documentation gaps found while writing this (outside this file):

-   `STRUCTURE.md` §4.1 does not list `picking-monitor`, although §3.3
    and §7 reference it.
-   `STRUCTURE.md` §3.3 would benefit from a "Module type" column
    matching §8 of this document.

---

## 19. Applying this document

-   Changes made to satisfy this document are presentation-only. They
    must not alter feeds, cadences, API contracts, calculations,
    permissions or NexS behavior.
-   Shared components and tokens are added centrally first, then
    consumed by features. Features do not create local versions.
-   A major visual change is shown on one representative screen and
    approved before broad rollout (`RULES.md` §11.3).
-   When this document and the stylesheets disagree, record which is
    correct and update the other in the same change.

### 19.1 Design QA checklist (per screen change)

-   [ ] Page header follows §6; one primary action at most.
-   [ ] Layout matches the screen's module type (§7, §8) or the
        deviation is justified.
-   [ ] Every live value has a freshness indication (§9.1).
-   [ ] Loading, empty, live, stale, unavailable, error and partial
        states all render correctly (§9.3).
-   [ ] No value shows `0` for missing or failed data.
-   [ ] Severity uses icon + label + color (§9.2).
-   [ ] Numbers use tabular figures and §15 formatting.
-   [ ] Mutations follow §10.10, including the Uncertain outcome.
-   [ ] Tables meet §11; charts meet §12.
-   [ ] Light and dark themes checked; contrast AA.
-   [ ] Keyboard-only walkthrough; focus visible; modal focus returns.
-   [ ] `prefers-reduced-motion` checked.
-   [ ] Narrow and small widths checked; no page-level horizontal
        scroll.
-   [ ] No hard-coded colors, spacing or z-index in feature CSS.
-   [ ] No new dependency, polling loop or browser-side upstream call.
-   [ ] Browser console clean.
