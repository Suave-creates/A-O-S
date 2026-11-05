# AOS --- Engineering, Architecture and Design Rules

**Product:** ASRS Intelligence & Automation (AOS)\
**Stack:** Node.js + Express, MySQL, vanilla JavaScript, static frontend
with no build step\
**Companion document:** `STRUCTURE.md`\
**Status:** Development rules for an evolving internal application

This document is the engineering contract for AOS. It defines the
boundaries that new work must respect. The rules are specific to AOS's
actual architecture and operational needs. Reference projects may inform
general engineering principles, but their framework choices, file
structures, UI composition, branding and styling must not be copied into
AOS.

When a proposed change conflicts with these rules, first explain the
conflict and propose the smallest safe alternative. Do not silently
bypass a rule or perform a broad rewrite.

## 0. Non-negotiable project constraints

1.  Preserve **Express + vanilla JavaScript + MySQL** and the existing
    no-build frontend unless the owner explicitly approves an
    architecture migration.
2.  Preserve existing operational behavior, ASRS calculations,
    classification rules, priorities, integrations, permission semantics
    and data contracts unless the task explicitly calls for a change.
3.  Do not port Next.js, TypeScript, Prisma, Tailwind or other
    reference-project implementation details into AOS merely because
    they exist in a reference repository.
4.  Do not copy another application's visual design. Borrow principles,
    not composition. AOS must have its own visual identity, layouts,
    tokens, icon treatment and interaction patterns.
5.  Prefer small, reviewable changes over full-application rewrites.
6.  Do not trigger real tote pulls, purges, uploads or other mutating
    warehouse actions during an audit or test unless explicitly
    authorized and safely isolated.
7.  Never invent operational data, identities, timestamps, service
    states or successful outcomes.
8.  If the repository differs from this document, identify whether the
    difference is intentional, legacy behavior or a defect before
    changing it.

## 1. Feature boundaries

A feature is a vertical slice with a thin HTTP surface, feature-owned
logic and a browser screen.

Typical layout:

``` text
server/features/<feature>/
  <feature>.routes.js
  <feature>Engine.js
  <feature-specific helpers as needed>

public/js/features/<feature>.js
```

-   Routes validate input, enforce access, call the appropriate engine
    and return a response. Business logic does not belong in route
    handlers.
-   The browser feature file owns that screen's state, event handlers
    and markup. Keep a screen cohesive; do not split it merely to
    shorten a file.
-   Helpers used by only one feature belong inside that feature and use
    feature-specific names.
-   Multiple route files inside one feature are permitted only when they
    represent genuinely distinct surfaces of the same feature. The
    existing Auto/Manual tote-puller arrangement is an example.
-   Do not create generic screens that switch between unrelated features
    through `kind`, `mode` or `variant` flags.
-   Small duplication between independent features is preferable to
    hidden business coupling. Extract a shared implementation only when
    the behavior is genuinely common and its ownership is clear.
-   Keep authored source files readable. The existing structural test
    enforces a 700-line limit; if a file grows beyond it, split within
    the owning feature rather than moving business logic into a
    catch-all folder.

## 2. Dependency layers

Dependencies point down only.

``` text
features/  -> platform/, integrations/
integrations/ -> platform/
platform/ -> platform/
live/ -> platform/, integrations/, feature engines for feed composition only
```

Rules:

-   `platform/` must not import `integrations/` or `features/`.
-   `integrations/` must not import `features/`.
-   A feature must not import another feature directly, except for
    explicitly tracked legacy/composition exceptions in
    `server/test/platform/structure.test.js`.
-   The exception list may shrink. Adding an exception requires a
    specific reason and a test/structure update.
-   If multiple features need the same domain behavior, move the truly
    shared part to `platform/domain/`. If they need the same upstream
    capability, place it in `integrations/<system>/`.
-   Avoid catch-all folders such as `lib/`, `utils/`, `helpers/` or
    `common/`. Every file must have a clear owner: a feature,
    `platform/<area>/`, `integrations/<system>/` or `live/`.

## 3. Deciding where code belongs

Use this order:

1.  Used by one feature only → that feature's folder.
2.  Pure domain logic used by multiple features (for example, tote
    classification, tote status or location parsing) →
    `platform/domain/`.
3.  Communication with Grafana, NexS, Concinity, Quadron, Google or
    Slack → `integrations/<system>/`.
4.  App-wide infrastructure without business meaning (database, HTTP
    middleware, sessions, query management, audit, time helpers) →
    `platform/<area>/`.
5.  Server push and feed orchestration → `server/live/`, following the
    live-data rules below.
6.  If still unclear, keep it in the feature until there is a proven
    need to share it.

Do not move code into shared infrastructure merely to make a feature
file smaller.

## 4. Application shell and navigation

-   `public/index.html` and `public/js/core/app.js` own the shared
    shell: navigation, header, tab switching, connection status and
    global live indicators.
-   A feature screen renders its own panel content only. It must not
    build a second sidebar, header, navigation system or login
    interface.
-   Add navigation entries in the established shell locations
    (`public/index.html` and `public/js/core/app.js`).
-   Each screen must be registered through the existing screen lifecycle
    and `screensFor` mechanism.
-   Shared shell elements must not be duplicated by a feature.

## 5. Browser JavaScript rules

-   `public/js/core/` contains the shell and generic client helpers such
    as API, live subscriptions, cards, charts, toasts, modals, status
    and operation-log helpers.
-   `public/js/features/` contains one cohesive browser file per screen.
-   `public/js/vendor/` contains approved vendored third-party assets.
-   Do not add loose files directly to `public/js/`; the structure test
    enforces this.
-   A feature may use generic helpers from `core/`; it must not read
    another feature's globals, DOM or storage.
-   If behavior is genuinely shared, implement it in `core/` without
    embedding feature names or business rules.
-   Browser code talks only to this AOS server's `/api/v1/*` endpoints.
    Never call Grafana, NexS, Concinity, Quadron or another upstream
    service directly from the browser.
-   No secrets, credentials, service tokens or private upstream URLs in
    browser code.
-   The frontend has no build step and uses classic script tags.
    `type="module"` is allowed only where the existing 3D view requires
    it. Keep the frontend dependency-light.
-   Do not add polling loops to browser screens. Use the established
    live subscription mechanism.

## 6. Integrations, service logins and NexS lifecycle

### 6.1 Backend-owned upstream access

A browser never causes an upstream login or directly executes an
upstream request. Integration calls are server-side and go through the
appropriate integration capability/client and shared login.

-   Keep service logins centralized under `integrations/logins/`.
-   Do not create per-user, per-request or route-local service logins.
-   Reuse existing integration capabilities and query management rather
    than adding parallel clients.
-   Never expose credentials or raw secrets in logs, API responses,
    browser code or error messages.

### 6.2 Live feeds and SSE

-   A live screen subscribes through `Live.subscribe(topic, callback)`
    in `public/js/core/live.js`.
-   Topic registration belongs in the established `server/live/` feed
    files (`feeds.js`, `dashboardFeeds.js` and the applicable existing
    feed registry).
-   A feed has one fetch function and one documented cadence.
-   The live hub (`server/live/liveHub.js`) is responsible for
    single-flight fetching, running only while subscribed, pushing
    changed data through SSE, backing off on failures and marking stale
    data rather than inventing values.
-   Feeds reuse existing engines and shared service logins.
-   Per-user data must be scoped to the user. A feed must never leak one
    user's history or logs to another user.
-   Job-progress topics use the established key/ownership checks.
-   Manual refresh must go through `Live.refresh(topic)` and the
    server's rate limiting; it must not hammer an upstream service.
-   Mutations (tote pull, purge, upload or other writes) are normal API
    requests, not live topics.
-   A screen exposes `start()` and `stop()` and subscribes only while
    its tab is active.
-   Running-job progress uses `Live.watch("query:" + id, callback)`
    rather than a polling loop.
-   Do not use `setInterval`, or `setTimeout` + repeated `Api.get`, to
    poll data in a browser screen.

### 6.3 Refresh cadence and failure behavior

Choose refresh cadence based on source cost and document why in the
feed:

-   Cached/database reads: normally at least 5 seconds between fetches.
-   Upstream queries: normally at least 60 seconds between fetches.
-   Heavy fan-outs: normally at least 5 minutes between fetches.

Use the existing bounded/retried upstream calls and last-good-data
fallback. Mark fallback data as stale. Show "Data unavailable" when the
source has never produced usable data; never replace a failure with
zero.

### 6.4 NexS is intentionally on-demand

NexS uses a constrained shared account/session and is **not intended to
remain connected at all times**.

-   NexS connects on demand when a user starts an operation that needs
    it.
-   The screen uses the existing `NexsConnect.run(...)` flow and the
    server uses the lease manager at `integrations/logins/nexsLease.js`.
-   A screen keeps its lease while it is active; NexS is released when
    the user leaves and no operation still needs it.
-   A server job holds its own lease through `nexsLease.guardJob`, so
    navigating away does not break a running job.
-   Background feeds and ordinary page loads must not require a NexS
    session. Use the existing `skipNexs` behavior or counts/cache-only
    data where appropriate.
-   Only `nexsLease` may open a NexS session. Connection-status UI is
    passive and must not cause a connection.
-   Shutdown releases the session according to the existing lifecycle.
-   Every new NexS-using route must use `nexsLease.guardJob` and its
    screen must use `NexsConnect.run(...)`.
-   A disconnected NexS badge can be normal when idle. Do not change the
    lifecycle just to keep a green status indicator. Distinguish
    idle/disconnected from connection failure when a NexS-dependent
    operation is requested.

## 7. Data ownership and metric consistency

-   Each metric has one authoritative calculation/definition.
-   Dashboard and One Pager Report use the shared metric functions in
    `features/dashboard/dashboardMetrics.js`; do not independently
    reimplement the same metric.
-   To add a metric, implement it in the shared metric layer and expose
    it to each required view.
-   Keep source values, calculated values, reporting period, fetch time
    and freshness state distinguishable.
-   A current-state metric must not silently be presented as a
    historical snapshot. A report must identify its reporting date and
    the freshness of live sections.
-   Partial reports must identify unavailable sections. Do not silently
    mix stale, live and historical data as if they were captured at the
    same time.
-   Never turn missing data, a timeout or an invalid source response
    into a valid-looking zero.
-   Keep domain rules such as tote capacity, frame/lens classification,
    mixed-tote exceptions, priorities and facility-specific behavior in
    their established authoritative layer.

## 8. Database and persistence

-   MySQL access goes through the existing `platform/db` infrastructure.
    Never create another connection pool.
-   Use parameterized SQL only.
-   Pool settings, timeouts and database error classification belong in
    `platform/db`.
-   Add the fewest tables and columns necessary.
-   Before creating a table, confirm that the data must survive a
    restart, cannot be reliably derived from existing data, and has its
    own identity or lifecycle.
-   Do not create tables for transient UI state, speculative future
    requirements or unrelated catch-all data.
-   Schema changes use new numbered migrations under
    `platform/db/migrations/`.
-   Never edit an already-applied migration. Commit the migration with
    the code that requires it.
-   Reuse an existing table only if it represents the same business
    entity; do not overload an unrelated table to avoid a migration.
-   Preserve existing data and backward compatibility unless a migration
    explicitly requires a controlled change.

## 9. Alerts and auditability

### Alerts

-   Alert rules are pure functions in `features/alerts/alertRules.js`:
    input rows produce alert events.
-   Every rule has a stable `dedupeKey`; adding a rule includes a test.
-   Thresholds are configurable through the existing `config.js`
    mechanism and environment overrides where supported.
-   Alert evaluation reuses shared cached CC data and must not create a
    separate upstream load.
-   Rules evaluate only through the existing alert feed/lifecycle.
-   Admin-editable thresholds and enable/disable settings use the
    existing `alert_rule_settings` storage.
-   GLOBAL alerts remain visible in the sidebar until acknowledged;
    NORMAL alerts remain on the Alerts page.
-   Acknowledgements and remarks are audit-logged. Preserve the
    established shared acknowledgement semantics and one editable remark
    per alert.

### Audit trail

-   Sensitive or mutating operations must remain attributable to the
    authenticated actor and traceable to an operation/query ID.
-   Do not fabricate actor identity when it is missing. Resolve the
    source of identity or mark it explicitly unknown according to the
    existing data contract.
-   Never log credentials, session cookies, tokens or secrets.
-   Reuse the existing audit infrastructure and tables where they
    represent the same purpose; do not create parallel audit stores
    without a documented need.

## 10. Panel permissions and authorization

-   Every screen is a panel. Panel keys are defined in
    `platform/domain/panels.js`.
-   `users.panels = NULL` means all panels; admins see all panels,
    according to the current contract.
-   New feature routes must be mounted behind `requireAuth` and
    `requirePanel("<key>")` in `server/index.js`.
-   New live topics must be added to the existing `TOPIC_PANELS`
    authorization mapping.
-   The browser may hide controls for usability, but the server must
    enforce authorization independently.
-   Validate authorization for direct API calls, not just navigation
    visibility.
-   Preserve the current authentication/session behavior unless a task
    explicitly changes it.

## 11. Design system and original AOS identity

The design system exists to make AOS consistent, not to make every
module look identical. AOS must have an original visual identity and
must not reproduce the layout or styling of the NexS reference website.

### 11.1 Existing stylesheet layers

Keep the established loading order:

1.  `public/app.css` --- base tokens, foundational components and the
    motion layer.
2.  `public/icons.css` --- generated icon set.
3.  `public/theme.css` --- Design System v2 surfaces, shell, buttons,
    inputs, tables, KPI cards and toasts.
4.  `public/aos.css` --- AOS Ink, Design System v3. Restyles the shell
    (sidebar, top bar) everywhere and every screen except the Dashboard,
    which keeps its v2 look. Screen rules are scoped to
    `.tab-panel:not(#tab-dashboard)` / `body:not([data-screen="dashboard"])`
    (`app.js` sets `body[data-screen]` on every tab switch). New shared
    look-and-feel goes here, not into `theme.css`.
5.  Feature-specific CSS --- only for genuinely unique layouts or
    visualization behavior.

Do not create competing global design systems or add arbitrary overrides
to fix one screen.

### 11.2 Tokens and visual consistency

-   Use existing `:root` tokens for colors, spacing, radii, shadows and
    semantic states (`--bg`, `--panel`, `--panel-2`, `--accent`, `--ok`,
    `--warn`, `--danger`, `--radius`, `--shadow-1`, and related tokens).
-   Do not hard-code new colors in individual feature stylesheets. Add
    or adjust a token centrally when a real design need exists.
-   Use semantic states consistently: success, warning, danger, neutral,
    stale and unavailable must be visually distinct and must not rely on
    color alone.
-   Use the established typography and spacing scale. Avoid arbitrary
    one-off sizes and spacing.
-   Light and dark themes must both be supported by the same semantic
    token system.

### 11.3 Originality and reference handling

When using screenshots, websites or another repository as a reference:

-   Extract general principles such as readability, spacing discipline,
    component reuse, information hierarchy and accessible interaction.
-   Do not copy its hero composition, sidebar proportions, navigation
    grouping, exact card arrangement, typography, color palette,
    decorative shapes, icons, spacing or page composition.
-   Do not merely recolor the reference and call it original.
-   Build page layouts from AOS workflows and data requirements.
-   Use the AOS logo and brand assets; do not imitate another product's
    identity.
-   Before a major redesign, propose the visual direction and show one
    representative AOS screen. Implement broadly only after the
    direction is approved.

### 11.4 Module-specific UX

Keep one design language but tailor the information architecture to the
task:

-   Dashboard: operational health, critical exceptions, shift metrics
    and live activity.
-   Monitoring: dense data tables, distributions, freshness, ageing and
    drill-down.
-   Operations: queue, validation, progress, safe actions and operation
    history.
-   Inventory/validation: source comparison, discrepancy evidence,
    partitions and reconciliation.
-   Reports: reporting period, data provenance, comparisons and exports.
-   Administration: clear forms, permission states, auditability and
    searchable tables.

Do not force every screen into a uniform KPI-card grid.

### 11.5 Icons, components and motion

-   Use the generated icon set: `<i class="ico" data-i="chart"></i>`.
-   Panel titles use the existing `.h-ico` pattern. Add icons through
    the generator list and regenerate `icons.css`; do not add one-off
    emoji or pasted SVGs.
-   Reuse `.panel`, `KpiCard.mount`, `.status-pill`, `.live-pill`, table
    cell classes, `button.primary`, `button.link` and `Toast.show` where
    appropriate.
-   Keep shared motion in the `MOTION LAYER` of `app.css`.
-   Reuse `Live.setHtml`, `KpiCard.mount`, `.live-appear`, `.cell-flash`
    and `.skeleton` where they fit.
-   Respect `prefers-reduced-motion`. Motion must communicate a data
    change or interaction, not distract operators.
-   Do not animate every element on every refresh or make live updates
    cause layout shifts.

### 11.6 Screen states and accessibility

Every screen must handle loading, empty, error, stale and success states
appropriately. Empty states should explain the next action; never show a
bare dash as the only explanation.

-   Never show fabricated metrics.
-   Show source freshness and meaningful error messages when relevant.
-   Use a toast for routine connection changes or interrupted live
    updates; reserve modals for decisions that genuinely require focus
    or confirmation.
-   Put long explanatory text in a collapsed
    `<details class="info-note">` when appropriate rather than a
    permanent wall of text.
-   Preserve keyboard navigation, visible focus, accessible labels,
    readable contrast and usable layouts at smaller viewport sizes.
-   Tables, charts, forms and dialogs must remain usable in both themes.

## 12. Configuration, secrets and dependencies

-   Configuration is read through `server/config.js` and environment
    variables.
-   Never commit `.env`; keep `.env.example` aligned with the actual
    required configuration.
-   Remove obsolete configuration variables only when the associated
    feature is actually removed and all references have been checked.
-   Credentials must not appear in logs, API responses or browser code.
-   Adding an npm dependency requires a clear justification. Prefer
    existing platform capabilities such as Node `fetch`, `crypto` and
    `node:test` where suitable.
-   Do not add a dependency solely to achieve a visual effect that can
    be implemented safely with the current stack.

## 13. Tests and verification

-   Tests mirror the source tree under
    `server/test/<same path as source>/<name>.test.js`.
-   Full suite: `npm test`.
-   Single test: `node --env-file-if-exists=.env --test <file>`.
-   Pure logic tests use injected clocks/time/network and must not
    depend on real timers or live upstream services.
-   Add a regression test for a bug that failed before the fix.
-   Run relevant tests after each bounded change; run the full suite
    before handoff when the environment permits.
-   Distinguish pre-existing/environment-dependent failures from new
    regressions. Never delete or weaken a test just to obtain a green
    run.
-   The existing documentation records a historical baseline of
    approximately 52 failures across five files when MySQL is
    unavailable or unreachable. Verify the current baseline before using
    that number; do not assume it is still current.
-   For UI changes, check navigation, all control states, browser
    console errors, responsive overflow, light/dark themes, reduced
    motion and module-specific behavior.
-   For integration changes, test failure, timeout, recovery, stale data
    and duplicate request scenarios without invoking real warehouse
    mutations.

## 14. Safe workflow for Claude Code and contributors

1.  Inspect the relevant files and current implementation before
    planning.
2.  For audits or planning tasks, do not edit files unless explicitly
    asked.
3.  State the affected files, expected behavior and risks before a broad
    change.
4.  Make one bounded change or one tightly related set of changes at a
    time.
5.  Preserve existing business logic and API contracts unless the task
    explicitly changes them.
6.  Run targeted tests and inspect the diff.
7.  Update `STRUCTURE.md` in the same change that adds, removes or moves
    a folder, route, feature or important shared service.
8.  Report what changed, tests run, tests not run, known issues and any
    unresolved risks.
9.  Do not commit or push unless asked.
10. Never bypass hooks with `--no-verify` or force-push.
11. Remove dead code and obsolete comments instead of leaving stubs or
    commented-out implementations.
12. Comments should explain why a constraint exists or record a
    meaningful operator decision; include a date for operator decisions
    where appropriate.

## 15. Definition of done

A change is complete only when:

-   It respects the feature and dependency boundaries.
-   It preserves unrelated workflows and existing data contracts.
-   It has appropriate validation and error states.
-   It does not add browser-side upstream access or polling.
-   It includes regression coverage appropriate to the risk.
-   It uses the AOS design system without copying another product's UI.
-   Relevant tests and checks have been run, with failures disclosed
    honestly.
-   `STRUCTURE.md` is updated if the architecture or repository map
    changed.
-   The handoff clearly identifies changes, verification and remaining
    limitations.
