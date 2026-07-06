# Changelog

All notable changes to the Tesla dashboard (`tesla-dashboard/`) are recorded here.
The current version is shown in the sidebar footer (`v<version>`).

Versioning is informal (not strict semver): bump the **minor** version for a new
feature or screen, the **patch** version for fixes/tweaks/copy changes, and the
**major** version only for a breaking change to how the dashboard is used or
configured. See `CLAUDE.md` at the repo root for the policy on keeping this file
and `APP_VERSION` (in `app.js`) in sync.

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
