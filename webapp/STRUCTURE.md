# AOS --- Repository Structure and Request/Data Flow

**Companion contract:** `RULES.md`\
**Stack:** Node.js + Express, MySQL, vanilla JavaScript, static frontend
with no build step\
**Run from:** `webapp/`\
**Primary commands:** `npm start` · `npm test` · `npm run migrate`

This file is the map of the AOS repository. `RULES.md` defines what is
allowed; this document describes where code belongs and how requests,
live data and integrations flow. Update this document in the same change
that adds, removes or moves a significant folder, route, feature,
integration or shared service.

This is a documented architecture map, not a claim that every file
currently matches it. When inspecting the live repository, call out
differences before changing them.

## 1. System overview

``` text
Browser
  ├─ HTML/CSS + vanilla JavaScript
  ├─ REST reads/actions: /api/v1/*
  └─ Server-Sent Events: /api/v1/live/stream
                    |
                    v
Express application: server/index.js
  ├─ Feature routes -> feature engines
  ├─ Live stream -> live hub -> registered feeds
  ├─ Authentication / panel authorization
  └─ Shared platform + integration services
        ├─ platform/       DB, sessions, HTTP, query manager, audit, domain
        ├─ integrations/   shared logins and upstream capabilities
        └─ live/           SSE topics, feed scheduling and change delivery
                    |
          +---------+-------------------+
          |                             |
          v                             v
        MySQL                 External systems/services
                              Grafana, Concinity,
                              Quadron, NexS, Google,
                              Slack (where configured)
```

Core principles:

-   Browser screens call only AOS `/api/v1/*` endpoints.
-   Upstream access and service authentication are server-owned.
-   Live data is delivered through the shared SSE hub; browser screens
    do not poll upstream systems.
-   Mutating operations use ordinary API requests and explicit operation
    tracking.
-   The same business metric must not be independently recalculated by
    different screens.
-   NexS connects on demand through the lease manager; an idle
    disconnected state is expected.

## 2. Repository map

``` text
webapp/
├─ RULES.md                         # engineering and design contract
├─ STRUCTURE.md                     # this repository map and flow guide
├─ CLAUDE.md                        # project-specific agent guidance, if present
├─ package.json
├─ .env                             # local secrets; never commit
├─ .env.example                     # documented configuration template
├─ public/
│  ├─ index.html                    # global shell and navigation/panel containers
│  ├─ app.css                       # base tokens, components and motion layer
│  ├─ icons.css                     # generated icon set
│  ├─ theme.css                     # shared design system v2
│  ├─ aos.css                       # AOS Ink (design system v3): shell + every screen except the Dashboard
│  ├─ brand/                        # AOS brand assets
│  ├─ fonts/                        # vendored fonts and accompanying licences
│  └─ js/
│     ├─ core/                      # global shell/client infrastructure
│     ├─ features/                  # one browser screen file per feature
│     └─ vendor/                    # approved vendored third-party assets
└─ server/
   ├─ index.js                      # Express boot, route mounting, middleware wiring
   ├─ config.js                     # environment-backed configuration
   ├─ features/                     # feature routes, engines and local helpers
   ├─ integrations/                 # upstream systems, capabilities and shared logins
   ├─ platform/                     # reusable app infrastructure and domain primitives
   ├─ live/                         # SSE hub, feeds and topic orchestration
   ├─ dev/                          # development-only tools
   ├─ scripts/                      # one-off/maintenance scripts
   ├─ google-sheets-setup/           # setup notes for Sheets integration
   └─ test/                         # tests mirroring source paths
```

The list above captures the documented top-level structure. Confirm
exact file names against the current checkout before moving or creating
files.

## 3. Frontend ownership

### 3.1 Shared shell

``` text
public/index.html
public/js/core/app.js
```

These own the shared navigation, header, tab/panel switching, connection
status, live indicators and screen lifecycle.

A feature screen renders only its own content. It does not build another
shell, sidebar, header or login screen.

### 3.2 Shared client infrastructure

`public/js/core/` contains generic browser helpers. The documented
examples include:

-   `api.js` --- AOS API access.
-   `live.js` --- SSE subscriptions, manual topic refresh and job
    watching.
-   `app.js` --- shell and screen lifecycle.
-   `loginFx.js` --- the sign-in screen's circuit backdrop, password eye
    and the post-sign-in transition (visual only; app.js calls it after
    the server accepts the login).
-   `operationLog.js` --- Pull Logs: Manual + Auto pull sessions (live
    topic `operations`), filter, tote search, per-kind totals.
-   `kpiCard.js` --- shared KPI rendering and value-change behavior.
-   `mutationFlow.js` --- confirm modal for real warehouse mutations
    (action-named button, Cancel focused by default); used by Manual and
    Auto Tote Puller.
-   `freshness.js` --- shared freshness badge (live / updating / stale /
    unavailable / idle); callers pass the last-good fetch time.
-   `sparkline.js` --- small trend visuals.
-   `toast.js` --- non-blocking notifications.
-   `ui.js` --- generic UI support.
-   `modal.js` --- dialogs where a focused decision is needed.
-   `charts.js` --- shared chart utilities.
-   `connectionStatus.js` --- shared connection-status display.
-   `operationLog.js` and `activityStream.js` --- operation/activity UI
    helpers.
-   `toteListParser.js` --- generic tote-list parsing where appropriate.

Treat this list as the documented map, not proof that every file is
present in the current checkout. Reuse a helper only when it matches the
behavior needed.

### 3.3 Feature screens

`public/js/features/` contains the browser-side screen files. The
documented mapping is:

  -----------------------------------------------------------------------
  Screen/feature                      Browser file(s)
  ----------------------------------- -----------------------------------
  Dashboard and detail drill-down     `dashboard.js`,
                                      `dashboardDetail.js`

  Tote Utilisation                    `toteUtilisation.js`

  Aisle Occupancy (Monitor)           `aisleOccupancy.js`

  Locked Totes                        `lockedToteInfo.js`

  Picking Monitor                     `pickingMonitor.js`

  Tote Purge / Outside Tote Analysis  `totePurge.js`

  Manual Tote Puller                  `manualTotePuller.js`

  Auto Tote Puller                    `autoTotePuller.js`

  Location Audit / 3D view            `asrsLocations.js`,
                                      `asrsLocations3d.js`,
                                      `asrsLocationsAudit.js` (audit marks)

  CNG Validator                       `cngValidator.js`

  Bulk Inventory Check                `bulkInventoryCheck.js`

  Container Tracker                   `tracker.js`

  One Pager Report                    `onePagerReport.js`

  Users/Admin UI                      `admin.js` and/or the existing
                                      Users panel implementation

  Alerts                              `alerts.js` and the existing shared
                                      alerts tray

  Shared NexS connect popup           `core/nexsConnect.js`
  -----------------------------------------------------------------------

Some feature names and UI files do not map one-to-one because a single
screen can use multiple server-side features, or one server-side feature
can support another screen. Confirm the actual shell registry and paths
before modifying navigation.

## 4. Server feature layer

Path: `server/features/<feature>/`

Typical feature layout:

``` text
server/features/<feature>/
  <feature>.routes.js       # HTTP endpoints; validate, authorize, call engine
  <feature>Engine.js        # feature business logic
  <feature-specific helpers>
```

Routes should remain thin. Engines own domain behavior for that feature.
Helpers used by only one feature stay inside that feature folder.

### 4.1 Documented feature inventory

  ------------------------------------------------------------------------
  Feature folder           Responsibility          Notes
  ------------------------ ----------------------- -----------------------
  `dashboard`              Live Control Center     `dashboardMetrics.js`
                           metrics and             is shared with the One
                           hour-by-hour drill-down Pager Report

  `tote-utilisation`       Utilisation             Uses the shared query
                           calculations, run       infrastructure
                           history and             
                           query-backed API        

  `locked-tote-info`       Locked totes,           Uses source data and
                           classification and      classification rules
                           locked-since details    

  `tote-purge`             Tote Purge and Outside  NexS may be required on
                           Tote Analysis           demand

  `tote-puller`            Manual and Auto tote    Includes purge-tracking
                           pulls through Quadron   behavior and pull
                                                   safeguards

  `locked-tote-info`       Locked totes, and       Analytics keeps closed
                           Locked Tote Analytics   days' CC trail in
                           (reported / ghost /     cc_day_rows
                           repeat cycle counts)    (ccDayRows.js)

  `one-pager-report`       One Pager (daily and    `asrsPerformance.js`
                           day-range) and ASRS     keeps one row per day
                           Performance (the One    (asrs_performance_days);
                           Pager kept day by day)  saved 06:05 IST by
                                                   live/asrsPerformanceAuto

  `pull-logs`              Pull Logs history: any  Read-only; the live
                           IST date range, paged,  "operations" feed still
                           and CSV export (one row serves the latest 100
                           per tote)               

  `nexs-asrs-dump`         NexS ASRS dump refresh  Supports other screens
                           and storage             

  `asrs-locations`         Location audit and 3D   Includes 3D-specific
                           view support            browser code. Audit
                                                   marks (`auditMarks.js`,
                                                   table
                                                   `location_audit_marks`,
                                                   migration 0021): an
                                                   auditor's finding at an
                                                   empty slot for the
                                                   current 06:00 site day;
                                                   POST `/audit-marks`
                                                   [`/clear`], live topic
                                                   `asrs-locations.marks`

  `cng-validator`          Cross-system            NexS access follows the
                           inventory/tote          lease rules
                           reconciliation          

  `bulk-inventory-check`   Bulk inventory checking Confirm current
                                                   implementation before
                                                   changing

  `tracker`                Container/tote tracking Feature-specific
                                                   behavior stays here

  `one-pager-report`       Date-based report and   Uses the Dashboard's
                           export/integration      shared metric layer
                           actions                 

  `nexs-connection`        NexS connect, heartbeat Lease manager owns the
                           and lease release API   actual session
                                                   lifecycle

  `users`                  User administration and Includes account
                           panel permissions       lifecycle and
                                                   soft-delete/history
                                                   behavior

  `alerts`                 Alert rules,            GLOBAL alerts can
                           persistence,            appear in the shell;
                           acknowledgement,        NORMAL alerts appear on
                           remarks and analytics   the page

  `connection-status`      Service                 UI indicator must not
                           connection-status API   initiate a connection

  `auth`                   Login, logout and       Shell-facing
                           session handling        

  `admin`                  Active Queries and      Query status must be
                           administrative actions  accurate and
                                                   attributable
  ------------------------------------------------------------------------

This table reflects the supplied AOS structure document. If the live
repository has renamed or consolidated features, update this table from
the actual source rather than creating duplicate folders to match the
document.

## 5. Integration layer

Path: `server/integrations/`

Integrations own communication with external systems and shared service
authentication. Features should call the appropriate integration
capabilities rather than directly contacting upstream services.

### 5.1 Documented integration areas

  -----------------------------------------------------------------------
  Area                                Responsibility
  ----------------------------------- -----------------------------------
  `logins/`                           Shared Grafana, Concinity and NexS
                                      authentication; NexS lease manager;
                                      shared connection status

  `capabilities/`                     Capability registry/manager, direct
                                      execution, coalescing, TTL cache,
                                      cancellation and safe public query
                                      representation

  `grafana/`                          Grafana capabilities and
                                      direct/multi-query helpers

  `gtp/`                              GTP station master data
                                      (`GET_GTP_STATION_CONFIG`, shared
                                      Concinity login)

  `nexs/`                             NexS blocked-inventory/discrepancy
                                      capabilities and provider

  `quadron/`                          Quadron inventory and pull
                                      operations, pull lock and rate
                                      limiting

  `google/`                           Apps Script client for ASRS dump
                                      and Google Sheets client

  `slack/`                            Slack notifications
  -----------------------------------------------------------------------

The actual available capabilities and file names must be verified before
reuse or extension. Do not add a second client for an upstream system
without proving the existing integration cannot support the use case.

### 5.2 Shared logins

The backend holds shared service logins. Browser users do not
authenticate directly to upstream systems.

-   Do not create per-request service login logic.
-   Do not put upstream credentials in browser code.
-   Keep login, lease, refresh and release behavior in the existing
    integration layer.
-   Keep the connection badge observational; it must not initiate
    upstream authentication.

### 5.3 NexS on-demand lease

NexS has a special lifecycle because the shared account/session is
constrained:

``` text
User starts a NexS-dependent operation
  -> UI uses NexsConnect.run(...)
  -> server acquires/guards a lease via nexsLease
  -> operation executes
  -> screen/job releases its lease when finished
  -> NexS disconnects when no lease remains
```

-   Only `nexsLease` opens a NexS session.
-   A long-running server job holds its own lease through
    `nexsLease.guardJob`.
-   Background feeds and ordinary page loads must not require NexS.
-   NexS showing disconnected while idle is normal and must not be
    treated as a defect.
-   A NexS-dependent operation should show a clear connection/failure
    state if the connection cannot be established when needed.

## 6. Platform layer

Path: `server/platform/`

`platform/` contains infrastructure and domain primitives that do not
belong to one external system or one feature.

Documented areas include:

-   `db/` --- the single MySQL pool, database helpers, error handling
    and numbered migrations.
-   HTTP middleware and request infrastructure.
-   Session/authentication support.
-   Query Manager and query lifecycle handling.
-   Audit infrastructure.
-   Time helpers.
-   Domain primitives, including panel definitions and shared
    classification/status/location logic.

Use the actual current directory tree to confirm exact subfolder names.
`platform/` must not import feature or integration code. If a new helper
contains business meaning, it may belong in `platform/domain/`; if it is
feature-specific, keep it in that feature.

## 7. Live data architecture

Path: `server/live/`

Documented components include:

-   `liveHub.js` --- shared SSE hub, subscription lifecycle,
    single-flight fetching, change detection, failure backoff and
    stale-state behavior.
-   `feeds.js` and `dashboardFeeds.js` --- topic registration and feed
    definitions. `dashboard.utilisation` (the Tote Utilisation and Totes in
    ASRS tiles, latest run only; clicking either opens the Tote Utilisation
    screen - they have no popup) is event-driven: a new NexS dump starts the
    run (`nexsAsrsDumpEngine.onCompleted`), a finished run reloads the tiles
    (`toteUtilisationJob.onCompleted`), Dashboard Refresh re-checks for a newer
    dump, and a 6-hour poll is the safety net. A run only happens when the
    dump is newer than the latest result. `aisle-occupancy.current` feeds
    the Aisle Occupancy screen (panel `aisleOccupancy`; the Dashboard's Aisle
    Occupancy tile opens it): the tile's Grafana read plus the Location Audit
    breakdown, sharing both caches with the tile and Location Audit. Its
    shaping stays in `features/dashboard` (`dashboardEngine`,
    `dashboardDetail.aisleAuditSummary`) because the tile uses it too.
-   `alertsFeed.js` --- alert evaluation/delivery using shared cached
    inputs.
-   `pickingFeeds.js` --- reads for the Picking Monitor topic
    `picking.monitor:<TYPE>-<PRIORITY>-<MINUTES>[-<STATION TYPE>-<STATION PRIORITY>]` (registered in `feeds.js`).
    One capability call (`GET_GRAFANA_PICKING_STATIONS`, items picked per
    GTP station) per refresh; closed hours are remembered, the result is
    cached per filter choice so every viewer shares one upstream read.
    The shaping lives in `features/picking-monitor/pickingMonitorEngine.js`
    (pure; it has no routes, the screen is fed by the live topic only).
    Station facts come from `GET_GTP_STATION_CONFIG` (type, operation, logged in, priority
    weight; cached minutes) and the PTL queue/slots from `GET_GRAFANA_PTL_QUEUE`; both are
    optional - if one is down the picks still show. Station filters are applied on top of the
    cached read. Capacity health (`picking-monitor/stationHealth.js`: 300 items/hour design,
    weight 0 = non-priority, 300000000 = priority, other = supervisor to check) is judged on the
    station's load across ALL orders (one extra unfiltered window read when an order filter is set).
    The order pipeline strip is a second topic, `picking.pipeline:<TYPE>-<PRIORITY>-<MINUTES>`
    (the 5 order-flow counts via `GET_GRAFANA_ORDER_PIPELINE`, every 3 min, shaped by
    `features/picking-monitor/orderPipeline.js`); a count that fails is
    null with a reason, and the call only fails if all five do.

### 7.1 Shared data flow

``` text
Browser screen
  -> Live.subscribe(topic, callback)
  -> SSE stream (/api/v1/live/stream)
  -> server live hub
  -> registered feed
  -> existing feature engine/integration
  -> cached/fresh result
  -> emit only changed data
  -> browser updates affected UI
```

The browser does not run its own upstream polling loop.

### 7.2 Feed rules

-   **No automatic refresh timers (operator decision 2026-11-04).**
    Screen-data topics are on-demand (`hub.markOnDemand([...])` at the
    end of `server/live/feeds.js`): the first viewer gets a first read,
    after that a topic reads again only when a screen asks. A screen
    asks only on its Refresh button - opening a tab shows the shared
    snapshot and never re-reads. The Dashboard alone has an auto
    refresh, and it is CENTRAL: `liveHub.setAutoInterval` runs one
    timer per tile source for the whole site, only while someone has
    the Dashboard in view, so load follows the interval and never the
    number of viewers. An ADMIN sets the minutes
    (`live/dashboardAutoRefresh.js`, `app_settings`, migration 0027;
    `PUT /api/v1/dashboard-auto-refresh`); every browser shows the same
    settings and countdown via `dashboard.autoRefresh`. There is no 15-minute Locked Totes snapshot and no
    6-hour NexS dump timer: a Dashboard refresh takes a Locked Totes
    snapshot when the last is over 1 minute old, and a Dashboard / Tote
    Utilisation refresh asks for a NexS dump when the last is over 6
    hours old (`live/nexsDumpOnRequest.js`). Still on their own pace,
    because they are not screen refreshes: job progress (`query`, pull
    sessions, purge / range-report runs, Auto Puller), the alert list
    and its 2-minute evaluation, connection indicators, the purge
    verifier and the 06:05 ASRS Performance save. A new screen topic
    goes in the `markOnDemand` list.

-   **The open site day is read incrementally from Grafana (operator
    decision 2026-11-04).** `integrations/grafana/grafanaDayCache.js`
    keeps CC rows and ASRS Production per hour, and Compaction /
    Tote Freed per shift. A refresh reads only the last 60 minutes.
    The running shift is read in full when its last full read is
    30+ min old, and a finished shift gets one final read 30 min
    after it ends, then is frozen. Hours not started are never asked
    for. Settled slots are kept in `live_day_cache` (migration 0025)
    across restarts. A closed day is never served from it: its first
    read (the 06:05 save) is a full read, which is the day's final
    tally, and `dashboardMetrics` logs any difference from the cache.
    A new section name carries a version (`cc:v1`); bump it when the
    stored value's meaning changes.

-   **What anyone loads is shared with everyone (operator decision
    2026-11-04)** until a manual or auto refresh; the pullers are the
    exception. Run-type screens (Outside Totes, CNG Validator, Bulk
    Tote Inv Check) store their latest run in `shared_results`
    (`platform/storage/sharedResults.js`, migration 0026), announce it
    on `shared.<panel>` and serve it at `<route>/last`; the browser
    follows it with `core/sharedRun.js`. Computed views (Locked Tote
    Analytics) stay memoised until Refresh (`fresh=1`).

-   One topic/feed owns one fetch function and a documented cadence.
-   The hub fetches only while subscribers exist.
-   Concurrent requests for the same feed are coalesced.
-   Push only changed data where the existing hub supports change
    detection.
-   Back off on repeated failure and mark data stale.
-   Manual refresh routes through the hub and its rate limits.
-   Per-user history/log topics must enforce user scoping and ownership.
-   Job progress uses the established query topic/watch mechanism.
-   Mutations are normal API requests, not SSE feeds.

## 8. Shared metrics and reports

The Dashboard and One Pager Report must use the same authoritative
metric definitions.

``` text
features/dashboard/dashboardMetrics.js
    ├─ Dashboard: live/current view and drill-down
    └─ One Pager Report: selected-date report metrics
```

A new metric should be added to the shared metric layer and then exposed
to the relevant screens. Do not duplicate its formula in the browser, a
report-only helper and the Dashboard engine.

Each metric/report section should make clear when necessary:

-   source/system;
-   reporting period or snapshot time;
-   last successful fetch;
-   freshness/stale state;
-   whether it is current state, historical state or a calculated
    aggregate.

The One Pager Report can combine date-specific metrics with live
current-state sections only when those semantics are clearly labeled. A
failed source should produce an explicit unavailable/stale state, not a
fabricated zero.

## 9. Database and migration flow

``` text
Feature route/engine
  -> platform/db
  -> single configured MySQL pool
  -> MySQL
```

-   All MySQL access uses `platform/db`.
-   Never create a second pool.
-   Use parameterized SQL.
-   Add a new numbered migration for a real schema change under
    `platform/db/migrations/`.
-   Do not edit an applied migration.
-   Commit migration and dependent code together.
-   Keep the number of tables and columns minimal.
-   Avoid persisting UI-only state or data that can reliably be derived.
-   Use existing tables only when they represent the same business
    entity.
-   The pool keeps TCP keep-alive on, pings itself every 30 s to stay warm,
    and `platform/db` retries a read (never a write) that fails on a dropped
    connection. Tuned by `DB_KEEPALIVE_MS`, `DB_WARM_PING_MS`, `DB_READ_RETRIES`.
-   Large results (`tote_utilisation_results`, `one_pager_reports`) are
    stored gzipped through `platform/storage/jsonBlob.js`; old plain rows
    still load. Don't `JSON_EXTRACT` a packed column.
-   Update this document when a new persistent feature or important data
    store is introduced.
-   `purge_pulls` (migrations 0017-0019, accessed only through
    `platform/storage/purgeMarks.js`) holds totes pulled with the Manual
    Puller Purge toggle: the Quadron baseline taken when calling finished,
    a 2-day watch status (PENDING, PURGED, RESTOCKED, EXPIRED) and the
    time a tote was first seen empty. `features/tote-puller/purgeTracking.js`
    decides the status; `live/purgeVerify.js` wires it to Quadron and a
    server timer. The CC metrics and alerts read only PURGED rows, as a
    pull-to-purged time window.

## 10. Authentication, panels and route wiring

-   Panel definitions live in `platform/domain/panels.js`.
-   The documented contract is: `users.panels = NULL` means all panels;
    admins always see all panels.
-   New protected feature routes are mounted in `server/index.js` behind
    `requireAuth` and `requirePanel("<key>")`.
-   New live topics must be mapped through the existing `TOPIC_PANELS`
    authorization map.
-   The UI may hide inaccessible navigation, but server-side access
    control remains authoritative.
-   Audit actor identity must come from the authenticated
    request/context; never fabricate a user for missing data.
-   Direct API access must be tested, not only navigation visibility.

## 11. Alerts and operation tracking

### Alerts

``` text
features/alerts/alertRules.js
  -> pure rule evaluation
  -> stable dedupeKey
  -> alert storage/engine
  -> Alerts page and/or shell tray
```

-   Rules use the shared cached CC data and should not add a new
    upstream fetch.
-   GLOBAL alerts remain in the sidebar until acknowledged; NORMAL
    alerts appear on the Alerts page.
-   Thresholds and enabled/disabled state use the existing configuration
    and `alert_rule_settings` mechanism.
-   Acknowledge and remark actions are audit-logged.
-   Adding a rule requires a test.
-   Storage (`alertStore.js` is the only file that touches it):
    `alerts` (current state, plus searchable `station` / `tote` /
    `metric` / `threshold` columns), `alert_events` (history: raised,
    grew, acknowledged, remark saved, remark undone - who and when) and
    `alert_daily` (per IST day x rule x station rollup, rebuilt by
    `live/alertsFeed.js` after each evaluation: fully once after start,
    then only the days whose alerts changed). Migration 0020.
-   Analytics (`features/alerts/alertAnalytics.js`) is a pure summary of
    a period's alerts, their history and the daily rollup, served by
    `GET /api/v1/alerts/analytics` and shown in the Alerts page's
    Analytics view. `GET /api/v1/alerts/:id/history` returns one
    alert's history. No upstream call; the view refetches on open, on a
    period change, or when the live `alerts` topic changes.
-   The alert popup (`core/alertsTray.js`) acknowledges and takes a
    remark in place.

### Query/operation lifecycle

The Active Queries interface should reflect actual server-side state,
not merely browser state. Track the appropriate query/operation ID,
authenticated actor, operation type, timestamps, status and safe error
details.

Use clear terminal states for completion, failure, timeout and
cancellation where supported. A timeout does not necessarily mean an
external mutation failed to happen; uncertain write outcomes require
reconciliation before retrying.

Do not leave queries permanently marked as running after their
worker/request has ended. Do not expose secrets in error details.

## 12. Design-system architecture

Stylesheet loading order:

``` text
public/app.css       # base tokens, foundational components, motion layer
public/icons.css     # generated icon set
public/theme.css     # shared Design System v2
public/aos.css       # AOS Ink (v3): shell everywhere; screens scoped to .tab-panel:not(#tab-dashboard)
feature CSS          # only feature-specific layout/visualization
```

The shared system should supply colors, typography, spacing, radii,
surfaces, buttons, inputs, tables, KPI cards, status indicators, toasts
and motion hooks.

AOS's UI must be original. Use external screenshots and reference
projects to learn principles such as visual hierarchy, consistency,
responsive behavior and component reuse; do not copy their page
composition, navigation arrangement, card grid, hero design, typography,
palette or icon treatment.

Use different information layouts where the task requires them:

-   Dashboard --- operational health, exceptions, shift summary and
    activity.
-   Monitoring --- dense records, distributions, ageing, filters and
    drill-down.
-   Operations --- queues, validation, progress, safe controls and
    history.
-   Inventory/validation --- source comparisons and discrepancy
    evidence.
-   Reports --- reporting period, provenance, comparison and export.
-   Administration --- permissions, user lifecycle, query state and
    audit.

One design system does not mean one page template. Respect both light
and dark themes, reduced motion, accessible contrast, keyboard focus and
responsive layouts.

## 13. Test layout and commands

Tests mirror the source tree:

``` text
server/test/<matching source path>/<name>.test.js
```

Commands documented by the project:

``` bash
npm test
node --env-file-if-exists=.env --test <path-to-test-file>
npm run migrate
```

-   Pure logic tests should use injected time, clocks and network
    dependencies.
-   Avoid real timers and live upstream calls in unit tests.
-   Test timeout, failure, recovery, stale data, authorization and
    duplicate-request paths where relevant.
-   The rules document records an historical MySQL-dependent failure
    baseline. Re-check the actual current suite before treating it as
    current.
-   Never delete tests to make a change pass.
-   Report tests that could not run because MySQL, environment variables
    or upstream dependencies are unavailable.

## 14. New feature checklist

Before marking a new feature complete:

1.  Place it in the closest existing feature/module area.
2.  Add a thin route and feature engine in the correct server feature
    folder.
3.  Add or update its browser screen under `public/js/features/`.
4.  Register its navigation and screen lifecycle in the existing shell.
5.  Use existing API, live, query, audit, login and UI infrastructure
    where appropriate.
6.  Do not create browser-side upstream calls or polling.
7.  Apply authentication and panel authorization to routes and live
    topics.
8.  Reuse authoritative metrics/domain rules rather than duplicating
    them.
9.  Add a numbered migration only if persistent schema changes are
    justified.
10. Add tests for domain behavior, failure paths and authorization as
    appropriate.
11. Check empty, loading, success, error, stale and unavailable states.
12. Check light/dark theme, responsive behavior, keyboard focus and
    reduced motion.
13. Update `RULES.md` only if a new enduring contract is introduced.
14. Update this `STRUCTURE.md` whenever folders, routes, feature
    ownership, shared services or data flow change.
15. Run relevant tests and provide a truthful handoff listing changed
    files, verification, unrun tests and known limitations.

## 15. Keeping this map accurate

When modifying the repository:

-   Inspect the actual checkout before relying on a documented path.
-   Do not create a duplicate folder just because the map lists a name
    that has since changed.
-   If a documented component has been renamed or removed, update the
    map in the same change.
-   Keep architecture descriptions concise enough to maintain, but
    detailed enough for a developer or coding agent to locate the
    correct ownership layer.
-   Document meaningful exceptions and their reason rather than silently
    bypassing the architecture.
