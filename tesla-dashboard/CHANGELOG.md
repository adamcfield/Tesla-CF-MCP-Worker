# Changelog

All notable changes to the Tesla dashboard (`tesla-dashboard/`) are recorded here.
The current version is shown in the sidebar footer (`v<version>`).

Versioning is informal (not strict semver): bump the **minor** version for a new
feature or screen, the **patch** version for fixes/tweaks/copy changes, and the
**major** version only for a breaking change to how the dashboard is used or
configured. See `CLAUDE.md` at the repo root for the policy on keeping this file
and `APP_VERSION` (in `app.js`) in sync.

## 1.13.0 — 2026-07-11

**#39**: clicking a driver card on the Drivers screen now opens that
driver's detail page — their stats (avg/top speed, speeding %, night %,
braking), a map of their recent routes, and their drives list (each row
opens the full drive detail). Quick-assign and auto-assignment are
unchanged; this is the read side.

## 1.12.0 — 2026-07-11

Three fixes from the BugDrop backlog (issues #35, #36, #37).

- **#35/chart tooltips**: every line chart (charge level, battery timeline,
  cabin climate, telemetry field history, battery health…) now shows a
  tooltip following the mouse — the nearest data point's time and value,
  with one labeled line per series on multi-series charts.
- **#36/sidebar headers**: the nav group headers (Driving, Media, Charging,
  Battery, Data) are more noticeable — slightly larger, bolder, darker,
  with a hairline separator above each group.
- **#37/duplicate timeline rows**: consecutive same-state rows ("Offline"
  right after "Offline" — connectivity flaps split one outage into several
  records) are now combined into a single row spanning from the earliest
  start, with the durations summed. A drive or charge in between still
  separates them. Applies to the Timeline and Overview's recent activity.

## 1.11.0 — 2026-07-11

Telemetry fields: every field is now explorable **over time**, not just its
latest value — asked as "I want to see them over time, every data that was
captured".

- Click any tracked field row → a popup with that field's full recorded
  history: a time-series chart for numeric fields, a change log (timestamp +
  value, consecutive repeats collapsed) for enums/strings. Time scope
  switchable between 24 h / 7 d / 30 d / 90 d.
- Reads the existing `/data/series` endpoint, which serves both the
  per-sample driving columns and the on-change event store — so it covers
  everything captured since tracking began (raw history is kept ~400 days
  before pruning).

## 1.10.1 — 2026-07-11

Tyres, in the units you actually think in — and a popup instead of a jump.

- Clicking the Overview Tyres readout now opens a popup with all four
  wheels (PSI primary, bar underneath), per-wheel warnings, any
  falling-pressure trend spelled out in PSI/week, and a button through to
  the full pressure history on Statistics. Previously it navigated to
  Statistics and left you at the top of the page.
- The Statistics tyre card switched from bar to PSI (bar kept as the small
  secondary line) — the Overview readout said "41 PSI" while Statistics
  said "2.9", which read as "3 instead of 42".

## 1.10.0 — 2026-07-11

New "Cabin climate" card on Overview — asked as "it's very hot outside, can
we tell if the AC is working to keep the interior temp in check?".

- A 24-hour inside-vs-outside temperature chart (solid = inside, dashed =
  outside), so you can see at a glance whether the cabin is being held
  below ambient (AC winning) or soaring above it (parked in the sun,
  nothing running).
- A one-line verdict underneath from the latest telemetry: AC on and
  holding / on but still catching up / off while the cabin heats up
  (with the Climate Keeper mode when it's active) — warning color when
  the cabin is cooking.
- The Inside/Outside readouts at the top of Overview click through to
  this card.

## 1.9.2 — 2026-07-11

Overview readouts are now click-through: Tyres (including when it shows a
pressure warning) opens the Statistics screen's TPMS card, Status opens the
state Timeline, and Inside/Outside jump to the new cabin-climate section —
so an issue you can see is one click from the screen that explains it.

## 1.9.1 — 2026-07-11

**#24**: the drive-detail page showed the driver in three separate spots (a
header input + Save, a "Not right? Reassign to:" chip row, and a Household
hint row). Consolidated to ONE control: a single "Driver:" chip row built
from the Tesla-account roster — the assigned driver is highlighted, a
system-suggested driver shows with a "?" for one-tap confirmation, and an
"other…" link reveals the free-text input for names not on the roster. The
system still finds the driver on its own when it's confident (unchanged
auto-assignment), so usually there's nothing to do here at all.

## 1.9.0 — 2026-07-11

New "Telemetry fields" screen (Data section in the sidebar): every attribute
from Tesla's fleet_streaming_fields reference (239 fields, vendored as a CSV
into the dashboard) in a scrollable spreadsheet-style table — field name,
category, the latest value this car actually sent, when it was last seen,
and the official description. Filter by category chips or free-text search.
Dimmed rows are fields the worker deliberately doesn't record (powertrain
diagnostics, Semi-truck-only, static config). Built to answer "what is
actually coming in, and what could I do with it".

- Backend: new `GET /data/telemetry-fields?vin=` route
  (`getTelemetryFieldStatus` in `ingest.ts`, which owns the field mapping) —
  joins `FIELD_MAP` against the latest-state doc and per-field last-seen
  timestamps (one indexed GROUP BY over `telemetry_events`).
- Also added the missing page titles for this screen and the 1.8.0 Battery
  timeline screen (it shipped without a header title).

## 1.8.0 — 2026-07-11

**#23**: new Battery timeline screen — a stock-chart-style SoC line over a
chosen time scope (24 hours / 7 days / 30 days), with a stage strip and
legend underneath showing how much of that window was spent driving,
charging, resting (parked, unplugged), or connected but not charging
(e.g. sitting at the charge limit after a session finished). Reached by
clicking Overview's "Charge level" card.

- Backend: new `getBatteryTimeline` derivation in `tracking.ts`, built
  from `positions`' already-derived `activity` + `charging_state` (not
  `vehicle_states`, which only tracks driving/charging/online/asleep/
  updating and has no "plugged in but idle" state). New
  `GET /data/battery-timeline?vin=&hours=` route and `get_battery_timeline`
  MCP tool (read-scope).

## 1.7.3 — 2026-07-11

API usage screen: stop hiding why the call log is missing. Reported as "the
page with all the calls doesn't work" while the month's budget was nearly
exhausted — the screen was silently swallowing the `/data/budget-calls`
failure and rendering an empty table, indistinguishable from "no spend".

- A failed call-log fetch now renders an explicit card saying what went
  wrong: a 404 explains that the **deployed worker predates this feature**
  (and how to redeploy it — the usual cause, since the dashboard auto-ships
  on merge but the worker doesn't); 401/403 points at the token; anything
  else shows the actual error.
- When the table's total covers less than the month's spend (per-call
  accounting started mid-month with a worker deploy), a note now says so
  instead of letting the two numbers silently disagree.
- The month-total card still renders even if the summary endpoint fails.

## 1.7.2 — 2026-07-11

**#22**: the "Name this place" field in the Add-a-place modal is now
pre-filled with the spot's address/label (from the current-location
reverse-geocode, a frequent-stop, or a search result) instead of opening
blank and forcing a manual name every time — the text is pre-selected so
typing a custom name still just overwrites it in one keystroke.

## 1.7.1 — 2026-07-08

**#21**: map cards now zoom with the mouse wheel (was disabled outright).
Click-drag panning was already on by default in Leaflet — nothing to
change there, just confirmed it wasn't being blocked by anything else on
the map card.

## 1.7.0 — 2026-07-07

New changelog viewer: clicking the version number in the sidebar now opens a
timeline screen listing every version in this file, most recent first, each
as a card with its date, intro, and bullet points (with `code`, **bold**, and
link markdown lightly rendered). It's a same-origin `fetch("./CHANGELOG.md")`
parse at render time, not a build step — so this file stays the single
source of truth for what shipped when.

## 1.6.3 — 2026-07-07

Five more small fixes from the BugDrop feedback backlog (issues #15, #16,
#17, #19, #20).

- **#15/current location**: Overview's map card now shows a real reverse-
  geocoded address instead of raw lat/lon when the car isn't at a saved
  place (new `GET /data/reverse-geocode` route, reusing the same
  Nominatim-backed, grid-cached lookup drive endpoints already use). When
  parked somewhere unsaved, a "Save this place" button opens the Add-a-
  place modal pre-filled with that point.
- **#16/car status**: the "Security" readout (Locked/Unlocked) is now
  "Status" (Driving/Charging/Parked/Asleep/Offline/Updating), from the same
  state-timeline the Timeline screen uses — no live read required.
- **#17/recent activity detail**: drive entries in Recent Activity now show
  the assigned driver + their per-drive score, or a one-tap quick-assign
  row when nobody's assigned yet (same affordance already on the Drives
  list/detail).
- **#19+#20/connection status**: there were three different status-with-a-
  dot indicators (sidebar, an Overview-only "Online/Reporting" pill, and
  the header's sync heartbeat) — consolidated to one, in the sidebar.
  It's optimistic (green) by default, matching that this worker never
  auto-polls/wakes, and only flips off-green when there's genuinely no
  telemetry or it's gone stale (>6h); hover shows the last-data timestamp.
  The redundant Overview pill is gone.
- Also fixed a pre-existing, date-dependent test flake in
  `getBudgetForecast`'s regression test (unrelated to the above — found
  while verifying the gate; it seeded a spend row on the real "today" which
  only worked when run on the 1st/2nd of a month).

## 1.6.2 — 2026-07-07

Overview's "Battery health" metric card showed the literal text "see detail"
instead of an actual number — fixed to show the real battery health %
(fetched from the same degradation data the Battery Health page uses),
still clickable through to that page for the full breakdown. (Reported via
the new BugDrop feedback widget — issue #14.)

## 1.6.1 — 2026-07-06

Fixed raw, unrounded SoC percentages (e.g. "78.71022247254293%") showing on
the Overview recent-activity feed, the Charges list, and the charge-detail
page — all three read `start_soc`/`end_soc` straight off the API response
without rounding. The Drives equivalents were already correctly rounded
(`fmt0`); these three just missed it. Also fixed the Overview "Charge limit"
chip the same way.

## 1.6.0 — 2026-07-06

Places: adding one is now a popup instead of always-on-page clutter, and a
place can be tagged to whichever household driver(s) it belongs to.

- "Add a place" (frequent stop or address search) is now a modal opened via
  a small "+ Add a place" button, instead of two cards permanently taking up
  space on the Places screen. Selecting a spot shows a map pin to confirm
  the location before saving (previously just raw lat/lon numbers).
- New: tag a place with which driver(s) it's for — e.g. "Home" tagged to
  everyone in the household, "Work" tagged to just one — at save time, or
  later via "edit tags" on the place-detail page. Untagged (the default,
  and every location saved before this change) means shared/no restriction.
  Tags show as small pills on the saved-places list and detail page.
  Backend: new `locations.drivers` column (JSON array, nullable — omitted
  on an edit leaves existing tags untouched, an explicit empty array clears
  them); `set_location` MCP tool and `/data/save-location` gain a `drivers`
  param; `/data/save-location` also now accepts `id` so it doubles as the
  edit route.
- Confirmed reverse-geocoding already uses Nominatim, not GovMap — GovMap's
  reverse endpoint only returns cadastral parcels, not human addresses, so
  Nominatim was already the right choice for that direction (forward
  geocoding, used by the address search above, is the one GovMap is good at).

## 1.5.1 — 2026-07-06

Make the save-location failure reason actually visible, and clarify what
the API usage table is (and isn't).

- The 1.5.0 fix put the real save-location error in the button's `title` —
  a hover-only tooltip, invisible in a screenshot and unusable on touch. It
  now renders as plain text under the form instead.
- API usage screen: added a note explaining the call-log table is a
  per-day/per-kind cost summary (one row per day+kind, count growing in
  place), not a live per-call feed — and that the "synced Xs ago" seen
  elsewhere is the dashboard re-reading its own already-stored data, not a
  new billed Tesla API call.

## 1.5.0 — 2026-07-06

Places: add a spot proactively instead of only naming ones the car already
visited, and a clearer failure when saving a location goes wrong.

- New "Add a place" card on the Places screen: search an address (reuses the
  worker's existing `/geocode` endpoint — GovMap with a Nominatim fallback,
  previously unused by the dashboard), pick a result, name it, save it. Works
  for anywhere, not just a spot the car has already visited enough times to
  be "suggested".
- A failed location save (suggested-place or address-search) now surfaces
  the worker's actual error message (hover the "Failed" button) instead of a
  bare, undiagnosable "Failed".

## 1.4.0 — 2026-07-06

API usage drill-down, and decluttering the Overview page.

- Removed the "Tesla API spend" card from Overview — it was duplicated with
  the always-visible sidebar widget.
- The sidebar spend widget is now clickable → a new "API usage" screen
  (reachable only via the widget, not cluttering the main nav): month-to-date
  spend + forecast, daily rate, projected month-end total, a cost breakdown
  by call kind (vehicle data reads / commands / wakes / telemetry signals),
  and a per-day table of what was actually spent on what.
- Backend: spend is now also bucketed by (day, call kind) in a new
  `api_spend_calls` table — one row per day/kind (not per HTTP call, which
  for telemetry signals would be thousands/day) — so the breakdown is
  answerable without an unbounded raw call log. New `GET /data/budget-calls`
  endpoint and `get_api_call_log` MCP tool (read-scope, account-wide).

## 1.3.0 — 2026-07-06

Sentry Mode event log — "fully utilize" the telemetry rather than just the
boolean on/off already visible.

- `ingest.ts` now normalizes `SentryMode` into one vocabulary regardless of
  which shape the account streams: a plain boolean (REST poll, or a
  telemetry config not yet upgraded) becomes `"armed"`/`"off"`; the richer
  `SentryModeState` enum (`Idle`/`Armed`/`Aware`/`Panic`) has its prefix
  stripped and is lowercased. Legacy rows recorded before this change (a bare
  0/1) are still read correctly — the reader falls back to them.
- New backend derivation `getSentryLog`: armed-hours over the window, and —
  only when the account actually streams the full enum — a trigger-event
  list (transitions into Aware/Panic) each paired with the nearest known GPS
  position. `enum_available` tells the two cases apart; a boolean-only
  account gets armed-hours and a note explaining that true trigger detection
  needs the fuller telemetry config, instead of silently showing zero events
  forever. New `GET /data/sentry-log` endpoint and `get_sentry_log` MCP tool
  (read-scope).
- New "Sentry Mode" card on the Vampire drain screen: armed hours, trigger
  event count (panic events called out), and — when available — a table of
  each event's time, state transition and location.

## 1.2.1 — 2026-07-06

Closed the real gaps in the field-mapping pass from 1.1.0/1.2.0 — fields that
should have been mapped the first time and were just missed, as opposed to
the ones deliberately left out (powertrain diagnostics, Semi-truck/Cybertruck-
only, static config, the one CSV-documented-broken field).

- Now tracking: `LifetimeEnergyUsed`, `ChargeCurrentRequestMax`,
  `MediaAudioVolumeIncrement`/`Max`, `MediaNowPlayingDuration`/`Elapsed`, and
  the software-update fields (`SoftwareUpdateVersion`,
  `SoftwareUpdateDownloadPercentComplete`,
  `SoftwareUpdateExpectedDurationMinutes`, `SoftwareUpdateScheduledStartTime`)
  — all EAV-only, same storage posture as the rest of the "track everything"
  pass. No dedicated report/UI for the software-update fields yet.
- Now playing card shows a real progress bar (elapsed/duration) when the car
  reports a genuine track length — Tesla's documented 5-hour sentinel value
  for radio/no-duration sources is explicitly excluded rather than rendered
  as a meaningless bar.
- Re-confirmed `LifetimeEnergyUsedDrive`, `ChargePort` and `DCDCEnable` stay
  excluded (Semi-truck-only despite its "Driving" category, static hardware
  descriptor, and a low-level electrical-system diagnostic, respectively).

## 1.2.0 — 2026-07-06

A shortlist from a user-supplied "100 telemetry ideas" brainstorm — picked
for being technically sound, non-redundant with existing features, and
buildable from data already flowing (see the earlier field-mapping pass in
1.1.0). Skipped the ideas that relied on the deliberately-excluded per-motor
powertrain fields, duplicated existing screens, or were really automation
actions rather than analytics (that's a `rules.ts` project, not a dashboard one).

- **Charging stats**: new "Charging taper curve" chart — lifetime average/peak
  charging power binned by 5% state-of-charge, across every session ever
  logged (distinct from the per-session charge-curve chart already on the
  charge-detail page). New `GET /data/charge-taper` endpoint.
- **Statistics**: tyre pressure card now shows long-term side-to-side/front-
  rear balance (paired same-timestamp samples, not just the latest reading)
  and flags a persistent >0.15 bar gap as a possible alignment/wear signal.
  New "Safety feature usage" card (AEB-disabled %, blind-spot chime
  activations, lane-departure/forward-collision-warning settings) and new
  "Climate habits" card (auto-climate %, seat-heater/cooling level and
  left/right divergence per side). New `GET /data/safety-features` and
  `GET /data/climate-habits` endpoints.
- **Media**: new "Traffic mood" section — top tracks playing during heavy
  traffic (10+ min delay) vs. clear roads, when navigation-delay telemetry is
  available.
- New MCP tools: `get_charge_taper_curve`, `get_safety_feature_stats`, `get_climate_habits`.

## 1.1.0 — 2026-07-06

UI consistency/UX pass, plus several new features spanning the dashboard and
the `tesla-cf-mcp-worker` backend it talks to.

**UI consistency & UX**
- Extracted repeated inline-style patterns into shared CSS classes
  (`.tm-card-head`, `.tm-link-btn`/`.tm-icon-btn`, `.tm-bar-row`/`.tm-bar-track`/`.tm-bar-fill`).
- Consolidated ad hoc empty-state markup behind a shared `miniEmptyHtml()`
  helper; gave whole-screen empty/error states an icon badge.
- Aligned copy/tone (synthetic-drive badge wording, tyre status, Battery
  Health empty state).
- Added hover/cursor affordance on the driver-edit cell; disabled+loading
  states on the certificate/report buttons.
- Added lightweight hash-based routing (`#screen` or `#screen/id`) so
  reload/bookmarks/back-forward land on the right screen.
- Removed an unrelated, unreferenced root `index.html` from the repo.

**Driver assignment — now system-driven**
- The existing driver-suggestion classifier now auto-assigns a driver
  outright (tagged `driver_source: 'auto'`) when the place/time/climate-habit
  match is unambiguous (≥3 independent supporting drives, clear margin over
  any other candidate); weaker matches still fall back to a one-tap
  suggestion. A manual assignment always overrides and re-tags as `manual`.
- One-tap roster "quick assign" chips on the Drives list and drive detail,
  as the correction/override path (not the primary flow anymore).

**Places**
- The "Suggested places" list (frequent stops already detected) can now be
  named and saved directly from the dashboard via an inline form, instead of
  requiring a separate MCP tool call. New worker endpoint: `POST /data/save-location`.

**Tesla API budget**
- `budget.ts` now buckets spend by UTC day and fits a regression over the
  month's daily spend to project the month-end total, flagging if the poll
  budget will run out before the 1st. Surfaced in the Overview budget card
  and the sidebar widget.

**Database storage**
- New compaction pass (`compactOldHistory`, cron-driven): drive routes and
  charge curves older than a year are thinned to a fixed point budget
  (endpoints always kept) instead of growing forever — the drive/session
  summary row itself is never touched. Complements the existing
  `RETENTION_DAYS` prune of raw telemetry/idle-position rows.

**Media — "most played", from the car's infotainment system**
- New "Media" screen: Now Playing (live), most-played tracks/artists/sources/stations
  leaderboards (a play is counted on each value change, not per sample), and a
  breakdown of who listens to what per assigned driver.
- Track-change markers on the drive-detail speed/elevation chart, showing
  what was playing during that drive.
- Cover art (Now Playing + top tracks) is looked up client-side from Apple's
  free iTunes Search API using the track/artist text — Tesla exposes no
  artwork itself; nothing is stored, it's a purely visual lookup per view.
- Backend: new `media_title`/`media_artist`/`media_album`/`media_station`/
  `media_source`/`media_status`/`media_volume` telemetry fields, `getMediaStats`/
  `getMediaStatsByDriver`/`mediaTrackChanges` derivations, `GET /data/media` and
  `GET /data/media-by-driver` endpoints, `get_media_stats`/`get_media_stats_by_driver` MCP tools.
- Broad field-mapping expansion ("track everything, decide later"): climate/comfort
  habits, safety/ADAS feature usage, FSD mileage, battery pack diagnostics
  (brick voltage, module temp), navigation/ETA, security & access (valet/guest
  mode, PIN to drive), and tire-pressure staleness/warnings are now captured
  into telemetry history (EAV-only, never added to the bulky `positions`
  table) even though no aggregation/UI has been built for most of them yet.

## 1.0.0 — baseline

Pre-existing dashboard: Ask Tessa, Overview, Timeline, Statistics, Drives
(list + detail with route map, speed chart, risk certificate), Drivers,
Places, Lifetime map, Charges (list + detail with charge curve), Charging
stats, Battery health, Predictions (battery forecast + range predictor),
Vampire drain. No version tracking existed before 1.1.0 — this entry is a
placeholder marking "everything before this changelog started."
